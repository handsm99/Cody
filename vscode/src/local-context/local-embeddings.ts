import * as vscode from 'vscode'

import { ContextGroup, ContextStatusProvider } from '@sourcegraph/cody-shared/src/codebase-context/context-status'
import { LocalEmbeddingsFetcher } from '@sourcegraph/cody-shared/src/local-context'
import { EmbeddingsSearchResult } from '@sourcegraph/cody-shared/src/sourcegraph-api/graphql/client'

import { spawnBfg } from '../graph/bfg/spawn-bfg'
import { QueryResultSet } from '../jsonrpc/embeddings-protocol'
import { MessageHandler } from '../jsonrpc/jsonrpc'
import { logDebug } from '../log'
import { captureException } from '../services/sentry/sentry'

export function createLocalEmbeddingsController(context: vscode.ExtensionContext): LocalEmbeddingsController {
    return new LocalEmbeddingsController(context)
}

export class LocalEmbeddingsController implements LocalEmbeddingsFetcher, ContextStatusProvider {
    private service: Promise<MessageHandler> | undefined

    constructor(private readonly context: vscode.ExtensionContext) {}

    private getService(): Promise<MessageHandler> {
        if (!this.service) {
            this.service = this.spawnAndBindService(this.context)
        }
        return this.service
    }

    private async spawnAndBindService(context: vscode.ExtensionContext): Promise<MessageHandler> {
        const service = await new Promise<MessageHandler>((resolve, reject) => {
            spawnBfg(context, reject).then(
                bfg => resolve(bfg),
                error => {
                    captureException(error)
                    reject(error)
                }
            )
        })
        // TODO: Add more states for cody-engine fetching and trigger status updates here
        service.registerNotification('embeddings/progress', obj => {
            if (!this.statusBar) {
                return
            }
            if (typeof obj === 'object') {
                // TODO: Make clicks on this status bar item show detailed status, errors.
                if ('Progress' in obj) {
                    const percent = Math.floor((100 * obj.Progress.numItems) / obj.Progress.totalItems)
                    this.statusBar.text = `$(loading~spin) Cody Embeddings (${percent.toFixed(0)}%)`
                    this.statusBar.backgroundColor = undefined
                    this.statusBar.show()
                } else if ('Error' in obj) {
                    this.statusBar.text = '$(warning) Cody Embeddings'
                    this.statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
                    this.statusBar.show()
                }
            } else if (obj === 'Done') {
                this.statusBar.text = '$(sparkle) Cody Embeddings'
                this.statusBar.backgroundColor = undefined
                this.statusBar.show()
                // TODO: Hide this notification after a while.

                // TODO: There's a race here if there's an intervening load.
                if (this.lastRepo) {
                    this.lastRepo.loadResult = true
                    this.statusEvent.fire(this)
                }
            } else {
                // TODO(dpc): Handle these notifications.
                logDebug('LocalEmbeddingsController', JSON.stringify(obj))
                void vscode.window.showInformationMessage(JSON.stringify(obj))
            }
        })
        return service
    }

    // ContextStatusProvider implementation

    private statusEvent: vscode.EventEmitter<ContextStatusProvider> = new vscode.EventEmitter()

    public onDidChangeStatus(callback: (provider: ContextStatusProvider) => void): vscode.Disposable {
        return this.statusEvent.event(callback)
    }

    public get status(): ContextGroup[] {
        if (!this.lastRepo) {
            // TODO: We could dig up the workspace folder here and use that.
            return []
        }
        // TODO: Summarize the path with ~, etc.
        const path = this.lastRepo.path
        if (this.lastRepo.loadResult) {
            return [
                {
                    name: path,
                    providers: [
                        {
                            kind: 'embeddings',
                            type: 'local',
                            state: 'ready',
                        },
                    ],
                },
            ]
        }
        // TODO: Display indexing, if we are indexing
        return [
            {
                name: path,
                providers: [
                    {
                        kind: 'embeddings',
                        type: 'local',
                        state: 'unconsented',
                    },
                ],
            },
        ]
    }

    // Interactions with cody-engine

    private lastRepo: { path: string; loadResult: boolean } | undefined
    private lastAccessToken: string | undefined
    private statusBar: vscode.StatusBarItem | undefined

    public async setAccessToken(token: string): Promise<void> {
        if (token === this.lastAccessToken) {
            return Promise.resolve()
        }
        this.lastAccessToken = token
        // TODO: Make the cody-engine reply to set-token.
        void (await this.getService()).request('embeddings/set-token', token)
    }

    public async index(): Promise<void> {
        if (!this.lastRepo?.path || this.lastRepo?.loadResult) {
            logDebug('LocalEmbeddingsController', 'No repository to index')
            return
        }
        const repoPath = this.lastRepo.path
        logDebug('Indexing repository', repoPath)
        try {
            // TODO(dpc): Add a configuration parameter to override the embedding model for dev/testing
            // const model = 'stub/stub'
            const model = 'openai/text-embedding-ada-002'
            await (await this.getService()).request('embeddings/index', { path: repoPath, model, dimension: 1536 })
            this.statusBar?.dispose()
            this.statusBar = vscode.window.createStatusBarItem(
                'cody-local-embeddings',
                vscode.StatusBarAlignment.Right,
                0
            )
        } catch (error) {
            logDebug('LocalEmbeddingsController', captureException(error))
        }
    }

    public async load(repoPath: string | undefined): Promise<boolean> {
        if (!repoPath) {
            return Promise.resolve(false)
        }
        if (repoPath === this.lastRepo?.path) {
            return Promise.resolve(this.lastRepo.loadResult)
        }
        this.lastRepo = {
            path: repoPath,
            loadResult: await (await this.getService()).request('embeddings/load', repoPath),
        }
        this.statusEvent.fire(this)
        return this.lastRepo.loadResult
    }

    public async query(query: string): Promise<QueryResultSet> {
        return (await this.getService()).request('embeddings/query', query)
    }

    // LocalEmbeddingsFetcher
    public async getContext(query: string, _numResults: number): Promise<EmbeddingsSearchResult[]> {
        try {
            const results = (await this.query(query)).results
            logDebug('LocalEmbeddingsController', `returning ${results.length} results`)
            return results
        } catch (error) {
            logDebug('LocalEmbeddingsController', captureException(error))
            return []
        }
    }
}
