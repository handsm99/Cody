import type { init as browserInit } from '@sentry/browser'
import type { init as nodeInit } from '@sentry/node'

import { Configuration } from '@sourcegraph/cody-shared/src/configuration'
import { isDotCom } from '@sourcegraph/cody-shared/src/sourcegraph-api/environments'

import { extensionDetails } from '../EventLogger'

export * from '@sentry/core'
export const SENTRY_DSN = 'https://f565373301c9c7ef18448a1c60dfde8d@o19358.ingest.sentry.io/4505743319564288'

export type SentryOptions = NonNullable<Parameters<typeof nodeInit | typeof browserInit>[0]>

export abstract class SentryService {
    constructor(protected config: Pick<Configuration, 'serverEndpoint' | 'isRunningInsideAgent'>) {
        this.prepareReconfigure()
    }

    public onConfigurationChange(newConfig: Pick<Configuration, 'serverEndpoint'>): void {
        this.config = newConfig
        this.prepareReconfigure()
    }

    private prepareReconfigure(): void {
        try {
            const isProd = process.env.NODE_ENV === 'production'
            const options: SentryOptions = {
                dsn: SENTRY_DSN,
                release: extensionDetails.version,
                environment: this.config.isRunningInsideAgent
                    ? 'agent'
                    : typeof process !== 'undefined'
                    ? 'vscode-node'
                    : 'vscode-web',

                // In dev mode, have Sentry log extended debug information to the console.
                debug: !isProd,

                // Only send errors when connected to dotcom
                beforeSend: event => {
                    if (!isDotCom(this.config.serverEndpoint) && isProd) {
                        return null
                    }
                    return event
                },

                // The extension host is shared across other extensions, so listening on the default
                // unhandled error listeners would not be helpful in case other extensions or VS Code
                // throw. Instead, use the manual `captureException` API.
                //
                // When running inside Agent, we control the whole Node environment so we can safely
                // listen to unhandled errors/rejections.
                ...(this.config.isRunningInsideAgent ? {} : { defaultIntegrations: false }),
            }

            this.reconfigure(options)
        } catch (error) {
            // We don't want to crash the extension host or VS Code if Sentry fails to load.
            console.error('Failed to initialize Sentry', error)
        }
    }

    protected abstract reconfigure(options: Parameters<typeof nodeInit | typeof browserInit>[0]): void
}
