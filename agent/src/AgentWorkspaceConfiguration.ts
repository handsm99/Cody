import _ from 'lodash'
import type * as vscode from 'vscode'

import { type ClientConfiguration, CodyIDE } from '@sourcegraph/cody-shared'

import { defaultConfigurationValue } from '../../vscode/src/configuration-keys'

import type { ClientInfo, ExtensionConfiguration } from './protocol-alias'

export class AgentWorkspaceConfiguration implements vscode.WorkspaceConfiguration {
    constructor(
        private prefix: string[],
        private clientInfo: () => ClientInfo | undefined,
        private extensionConfig: () => ExtensionConfiguration | undefined,
        private dictionary: any = {}
    ) {
        const config = this.extensionConfig()
        const capabilities = this.clientInfo()?.capabilities

        this.put('editor.insertSpaces', true)
        this.put('cody', {
            advanced: {
                agent: {
                    'capabilities.storage':
                        capabilities?.globalState === 'server-managed' ||
                        capabilities?.globalState === 'client-managed',
                    'extension.version': this.clientInfo()?.version,
                    ide: {
                        name: AgentWorkspaceConfiguration.clientNameToIDE(this.clientInfo()?.name ?? ''),
                        version: this.clientInfo()?.ideVersion,
                    },
                    running: true,
                },
                hasNativeWebview: capabilities?.webview === 'native' ?? false,
            },
            autocomplete: {
                advanced: {
                    model: config?.autocompleteAdvancedModel ?? null,
                    provider: config?.autocompleteAdvancedProvider ?? null,
                },
                enabled: true,
            },
            codebase: config?.codebase,
            customHeaders: config?.customHeaders,
            'debug.verbose': config?.verboseDebug ?? false,
            'experimental.tracing': config?.verboseDebug ?? false,
            serverEndpoint: config?.serverEndpoint,
            // Use the dedicated `telemetry/recordEvent` to send telemetry from
            // agent clients.  The reason we disable telemetry via config is
            // that we don't want to submit vscode-specific events when
            // running inside the agent.
            telemetry: {
                clientName: config?.telemetryClientName,
                level: 'agent',
            },
        })

        const fromCustomConfigurationJson = config?.customConfigurationJson
        if (fromCustomConfigurationJson) {
            const configJson = JSON.parse(fromCustomConfigurationJson)
            _.merge(this.dictionary, this.normalize(configJson))
        }

        const customConfiguration = config?.customConfiguration
        if (customConfiguration) {
            for (const key of Object.keys(customConfiguration)) {
                this.put(key, customConfiguration[key])
            }
        }
    }

    public withPrefix(prefix: string): AgentWorkspaceConfiguration {
        return new AgentWorkspaceConfiguration(
            this.prefix.concat(prefix),
            this.clientInfo,
            this.extensionConfig,
            this.dictionary
        )
    }

    private normalize(cfg: any): any {
        if (cfg && typeof cfg === 'object') {
            if (Array.isArray(cfg)) {
                const normalized = []
                for (const value of Object.values(cfg)) {
                    normalized.push(this.normalize(value))
                }
                return normalized
            }

            const normalized = {}
            for (const key of Object.keys(cfg)) {
                const tmp = {}
                _.set(tmp, key, this.normalize(cfg[key]))
                _.merge(normalized, tmp)
            }
            return normalized
        }

        return cfg
    }

    private put(key: string, value: any): void {
        _.set(this.dictionary, key, this.normalize(value))
    }

    private actualSection(section: string): string {
        if (this.prefix.length === 0) {
            return section
        }
        return [...this.prefix, section].join('.')
    }

    public static clientNameToIDE(value: string): ClientConfiguration['agentIDE'] | undefined {
        switch (value.toLowerCase()) {
            case 'vscode':
                return CodyIDE.VSCode
            case 'jetbrains':
                return CodyIDE.JetBrains
            case 'emacs':
                return CodyIDE.Emacs
            case 'neovim':
                return CodyIDE.Neovim
            case 'web':
                return CodyIDE.Web
            case 'visualstudio':
                return CodyIDE.VisualStudio
            case 'eclipse':
                return CodyIDE.Eclipse
            case 'standalone-web':
                return CodyIDE.StandaloneWeb
            default:
                return undefined
        }
    }

    public get(userSection: string, defaultValue?: unknown): any {
        const section = this.actualSection(userSection)
        const fromDict = _.get(this.dictionary, section)
        if (fromDict !== undefined) {
            return structuredClone(fromDict)
        }
        return defaultConfigurationValue(section) ?? defaultValue
    }

    public has(section: string): boolean {
        const NotFound = {}
        return this.get(section, NotFound) !== NotFound
    }

    public inspect<T>(section: string):
        | {
              key: string
              defaultValue?: T | undefined
              globalValue?: T | undefined
              workspaceValue?: T | undefined
              workspaceFolderValue?: T | undefined
              defaultLanguageValue?: T | undefined
              globalLanguageValue?: T | undefined
              workspaceLanguageValue?: T | undefined
              workspaceFolderLanguageValue?: T | undefined
              languageIds?: string[] | undefined
          }
        | undefined {
        return undefined
    }

    public async update(
        section: string,
        value: any,
        _configurationTarget?: boolean | vscode.ConfigurationTarget | null | undefined,
        _overrideInLanguage?: boolean | undefined
    ): Promise<void> {
        this.put(section, value)
        return Promise.resolve()
    }
}
