import path from 'path'

import * as vscode from 'vscode'
import { URI } from 'vscode-uri'

import { Client, createClient } from '@sourcegraph/cody-shared/src/chat/client'
import { registeredRecipes } from '@sourcegraph/cody-shared/src/chat/recipes/agent-recipes'
import { SourcegraphNodeCompletionsClient } from '@sourcegraph/cody-shared/src/sourcegraph-api/completions/nodeClient'

import { activate } from '../../vscode/src/extension.node'

import { AgentTextDocument } from './AgentTextDocument'
import { newTextEditor } from './AgentTextEditor'
import { AgentWorkspaceDocuments } from './AgentWorkspaceDocuments'
import { AgentEditor } from './editor'
import { MessageHandler } from './jsonrpc'
import { AutocompleteItem, ConnectionConfiguration } from './protocol'
import * as vscode_shim from './vscode-shim'

const secretStorage = new Map<string, string>()

async function initializeVscodeExtension(): Promise<void> {
    await activate({
        asAbsolutePath(relativePath) {
            return path.resolve(process.cwd(), relativePath)
        },
        environmentVariableCollection: {} as any,
        extension: {} as any,
        extensionMode: {} as any,
        extensionPath: {} as any,
        extensionUri: {} as any,
        globalState: {
            keys: () => [],
            get: () => undefined,
            update: (key, value) => Promise.resolve(),
            setKeysForSync: keys => {},
        },
        logUri: {} as any,
        logPath: {} as any,
        secrets: {
            onDidChange: vscode_shim.emptyEvent(),
            get(key) {
                if (key === 'cody.access-token' && vscode_shim.connectionConfig) {
                    // console.log('MATCH')
                    return Promise.resolve(vscode_shim.connectionConfig.accessToken)
                }
                // console.log({ key })

                return Promise.resolve(secretStorage.get(key))
            },
            store(key, value) {
                // console.log({ key, value })
                secretStorage.set(key, value)
                return Promise.resolve()
            },
            delete(key) {
                return Promise.resolve()
            },
        },
        storageUri: {} as any,
        subscriptions: [],
        workspaceState: {} as any,
        globalStorageUri: {} as any,
        storagePath: {} as any,
        globalStoragePath: {} as any,
    })
    // const platform = nodePlatformContext
    // const secretStorage = new InMemorySecretStorage()
    // const localStorage = new LocalStorage({
    //     get: () => undefined,
    //     update(key, value) {
    //         return Promise.resolve()
    //     },
    //     keys() {
    //         return []
    //     },
    // })
    // const rgPath = platform.getRgPath ? await platform.getRgPath() : null
    // const initialConfig = await getFullConfig(secretStorage, localStorage)
    // const telemetryService = createVSCodeTelemetryService()
    // const disposables: vscode.Disposable[] = []
    // // Controller for inline Chat
    // const commentController = new InlineController(process.cwd(), telemetryService)
    // // Controller for Non-Stop Cody
    // const fixup = new FixupController()
    // disposables.push(fixup)
    // if (TestSupport.instance) {
    //     TestSupport.instance.fixupController.set(fixup)
    // }
    // const editor = new VSCodeEditor({
    //     inline: commentController,
    //     fixups: fixup,
    //     command: undefined, // platform.createCommandsController?.(context, localStorage),
    // })
    // const { codebaseContext: initialCodebaseContext, chatClient } = await configureExternalServices(
    //     initialConfig,
    //     rgPath,
    //     editor,
    //     telemetryService,
    //     platform
    // )

    // const authProvider = new AuthProvider(initialConfig, secretStorage, localStorage, telemetryService)
    // await authProvider.init()

    // const contextProvider = new ContextProvider(
    //     initialConfig,
    //     chatClient,
    //     initialCodebaseContext,
    //     editor,
    //     secretStorage,
    //     localStorage,
    //     rgPath,
    //     authProvider,
    //     telemetryService,
    //     platform
    // )
    // disposables.push(contextProvider)
    // await contextProvider.init()
    // const history = new VSCodeDocumentHistory()
    // const statusBar = createStatusBar()
    // const providerConfig = createProviderConfig(config, () => {}, {} as SourcegraphNodeCompletionsClient)
    // const provider = new InlineCompletionItemProvider({
    //     providerConfig,
    //     history,
    //     statusBar,
    //     getCodebaseContext: () => contextProvider.context,
    //     isEmbeddingsContextEnabled: config.autocompleteAdvancedEmbeddings,
    //     completeSuggestWidgetSelection: config.autocompleteExperimentalCompleteSuggestWidgetSelection,
    // })
    return vscode_shim.completionProvider as any
}

export class Agent extends MessageHandler {
    private client: Promise<Client | null> = Promise.resolve(null)
    public workspace = new AgentWorkspaceDocuments()

    constructor() {
        super()
        vscode_shim.setWorkspaceDocuments(this.workspace)

        this.registerRequest('initialize', async client => {
            process.stderr.write(
                `Cody Agent: handshake with client '${client.name}' (version '${client.version}') at workspace root path '${client.workspaceRootUri}'\n`
            )
            await initializeVscodeExtension()
            this.workspace.workspaceRootUri = URI.parse(client.workspaceRootUri || `file://${client.workspaceRootPath}`)
            if (client.connectionConfiguration) {
                this.setClient(client.connectionConfiguration)
            }

            const codyClient = await this.client

            if (!codyClient) {
                return {
                    name: 'cody-agent',
                    authenticated: false,
                    codyEnabled: false,
                    codyVersion: null,
                }
            }

            const codyStatus = codyClient.codyStatus
            return {
                name: 'cody-agent',
                authenticated: codyClient.sourcegraphStatus.authenticated,
                codyEnabled: codyStatus.enabled,
                codyVersion: codyStatus.version,
            }
        })
        this.registerNotification('initialized', () => {})

        this.registerRequest('shutdown', () => Promise.resolve(null))

        this.registerNotification('exit', () => {
            process.exit(0)
        })

        this.registerNotification('textDocument/didFocus', document => {
            this.workspace.activeDocumentFilePath = document.filePath
            vscode_shim.onDidChangeActiveTextEditor.fire(newTextEditor(this.workspace.agentTextDocument(document)))
        })
        this.registerNotification('textDocument/didOpen', document => {
            this.workspace.setDocument(document)
            this.workspace.activeDocumentFilePath = document.filePath
            const textDocument = this.workspace.agentTextDocument(document)
            vscode_shim.onDidOpenTextDocument.fire(textDocument)
            vscode_shim.onDidChangeActiveTextEditor.fire(newTextEditor(textDocument))
        })
        this.registerNotification('textDocument/didChange', document => {
            const textDocument = this.workspace.agentTextDocument(document)
            this.workspace.setDocument(document)
            this.workspace.activeDocumentFilePath = document.filePath

            vscode_shim.onDidChangeActiveTextEditor.fire(newTextEditor(textDocument))
            vscode_shim.onDidChangeTextDocument.fire({
                document: textDocument,
                contentChanges: [], // TODO: implement this. It's only used by recipes, not autocomplete.
                reason: undefined,
            })
        })
        this.registerNotification('textDocument/didClose', document => {
            this.workspace.deleteDocument(document.filePath)
            vscode_shim.onDidCloseTextDocument.fire(this.workspace.agentTextDocument(document))
        })

        this.registerNotification('connectionConfiguration/didChange', config => {
            this.setClient(config)
        })

        this.registerRequest('recipes/list', () =>
            Promise.resolve(
                Object.values(registeredRecipes).map(({ id }) => ({
                    id,
                    title: id, // TODO: will be added in a follow PR
                }))
            )
        )

        this.registerRequest('recipes/execute', async data => {
            const client = await this.client
            if (!client) {
                return null
            }

            await client.executeRecipe(data.id, {
                humanChatInput: data.humanChatInput,
                data: data.data,
            })
            return null
        })
        this.registerRequest('autocomplete/execute', async params => {
            const provider = await vscode_shim.completionProvider
            if (!provider) {
                console.log('Completion provider is not initialized')
                return { items: [] }
            }
            const token = new vscode.CancellationTokenSource().token
            const document = this.workspace.getDocument(params.filePath)
            if (!document) {
                console.log('No document found for file path', params.filePath, [...this.workspace.allFilePaths()])
                return { items: [] }
            }

            const textDocument = new AgentTextDocument(document)

            try {
                const result = await provider.provideInlineCompletionItems(
                    textDocument as any,
                    new vscode.Position(params.position.line, params.position.character),
                    { triggerKind: vscode.InlineCompletionTriggerKind.Automatic, selectedCompletionInfo: undefined },
                    token
                )
                const items: AutocompleteItem[] = result.items.flatMap(({ insertText, range }) =>
                    typeof insertText === 'string' && range !== undefined ? [{ insertText, range }] : []
                )
                return { items }
            } catch (error) {
                console.log('autocomplete failed', error)
                return { items: [] }
            }
        })
    }

    private setClient(config: ConnectionConfiguration): void {
        vscode_shim.setConnectionConfig(config)
        vscode_shim.onDidChangeConfiguration.fire({
            affectsConfiguration: () =>
                // assuming the return value below only impacts performance (not
                // functionality), we return true to always triggger the callback.
                true,
        })
        vscode_shim.commands.executeCommand('cody.auth.sync')
        this.client = createClient({
            editor: new AgentEditor(this),
            config: { ...config, useContext: 'none' },
            setMessageInProgress: messageInProgress => {
                this.notify('chat/updateMessageInProgress', messageInProgress)
            },
            setTranscript: () => {
                // Not supported yet by agent.
            },
            createCompletionsClient: config => new SourcegraphNodeCompletionsClient(config),
        })
    }
}
