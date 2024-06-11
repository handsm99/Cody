import * as uuid from 'uuid'

import {
    type BillingCategory,
    type BillingProduct,
    CHAT_INPUT_TOKEN_BUDGET,
    CHAT_OUTPUT_TOKEN_BUDGET,
    type ChatMessage,
    ConfigFeaturesSingleton,
    type ContextItem,
    ContextItemSource,
    type ContextItemWithContent,
    type DefaultChatCommands,
    type EventSource,
    type MentionQuery,
    type Message,
    ModelUsage,
    ModelsService,
    PromptString,
    type SerializedPromptEditorState,
    Typewriter,
    allMentionProvidersMetadata,
    hydrateAfterPostMessage,
    isDefined,
    isError,
    isFileURI,
    isRateLimitError,
    parseMentionQuery,
    recordErrorToSpan,
    reformatBotMessageForChat,
    serializeChatMessage,
    tracer,
    truncatePromptString,
} from '@sourcegraph/cody-shared'

import { telemetryRecorder } from '@sourcegraph/cody-shared'
import { getFullConfig } from '../../configuration'
import { resolveContextItems } from '../../editor/utils/editor-context'
import { logDebug } from '../../log'
// biome-ignore lint/nursery/noRestrictedImports: Deprecated v1 telemetry used temporarily to support existing analytics.
import { telemetryService } from '../../services/telemetry'
import {
    handleCodeFromInsertAtCursor,
    handleCodeFromSaveToNewFile,
    handleCopiedCode,
} from '../../services/utils/codeblock-action-tracker'
import { openExternalLinks, openLocalFileWithRange } from '../../services/utils/workspace-action'
import { countGeneratedCode } from '../utils'

import type { Span } from '@opentelemetry/api'
import { captureException } from '@sentry/core'
import type { TelemetryEventParameters } from '@sourcegraph/telemetry'
import * as vscode from 'vscode'
import type { URI } from 'vscode-uri'
import { getContextFileFromUri } from '../../commands/context/file-path'
import { getContextFileFromCursor, getContextFileFromSelection } from '../../commands/context/selection'
import type { Repo } from '../../context/repo-fetcher'
import { gitCommitIdFromGitExtension } from '../../repository/git-extension-api'
import { recordExposedExperimentsToSpan } from '../../services/open-telemetry/utils'
import type { MessageErrorType } from '../MessageProvider'
import { getChatContextItemsForMention } from '../context/chatContext'
import type {
    ChatSubmitType,
    ConfigurationSubsetForWebview,
    LocalEnv,
    WebviewMessage,
} from '../protocol'
import { CodyChatPanelViewType, addWebviewViewHTML_new } from './ChatManager'
import { InitDoer } from './InitDoer'
import { prepareChatMessage } from './SimpleChatModel'
import {
    type ChatSession,
    type SimpleChatPanelProviderOptions,
    isAbortErrorOrSocketHangUp,
    newChatModelFromSerializedChatTranscript,
} from './SimpleChatPanelProvider'
import { getEnhancedContext } from './context'
import { DefaultPrompter } from './prompt'

import type { ChatClient, Guardrails } from '@sourcegraph/cody-shared'
import { type RemoteSearch, RepoInclusion } from '../../context/remote-search'
import type { RemoteRepoPicker } from '../../context/repo-picker'
import type { VSCodeEditor } from '../../editor/vscode-editor'
import type { ContextRankingController } from '../../local-context/context-ranking'
import { ContextStatusAggregator } from '../../local-context/enhanced-context-status'
import type { LocalEmbeddingsController } from '../../local-context/local-embeddings'
import type { SymfRunner } from '../../local-context/symf'
import { chatModel } from '../../models'
import type { AuthProvider } from '../../services/AuthProvider'
import type { TreeViewProvider } from '../../services/tree-views/TreeViewProvider'
import { startClientStateBroadcaster } from '../clientStateBroadcaster'
import type { ExtensionMessage } from '../protocol'
import { ChatHistoryManager } from './ChatHistoryManager'
import type { ChatPanelConfig } from './ChatPanelsManager'
import { CodebaseStatusProvider } from './CodebaseStatusProvider'
import { SimpleChatModel } from './SimpleChatModel'

export class ChatSidePanelController implements vscode.WebviewViewProvider {
    constructor(private options: SimpleChatPanelProviderOptions) {}

    async resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext<unknown>,
        token: vscode.CancellationToken
    ) {
        const webview = webviewView.webview
        await ChatController.create(webview, this.options)
    }
}

/**
 * Replaces the other SimpleChatPanelProvider
 */
export class SimpleChatPanelProvider implements vscode.Disposable, ChatSession {
    private chatController?: ChatController

    constructor(private options: SimpleChatPanelProviderOptions) {}

    /**
     * Revives the chat panel when the extension is reactivated.
     */
    public async revive(webviewPanel: vscode.WebviewPanel): Promise<void> {
        logDebug('SimpleChatPanelProvider:revive', 'registering webview panel')
        await this.registerWebviewPanel(webviewPanel)
    }

    /**
     * Registers the given webview panel by setting up its options, icon, and handlers.
     * Also stores the panel reference and disposes it when closed.
     */
    private async registerWebviewPanel(panel: vscode.WebviewPanel): Promise<vscode.WebviewPanel> {
        logDebug('SimpleChatPanelProvider:registerWebviewPanel', 'registering webview panel')
        if (this.webviewPanel || this.webview) {
            throw new Error('Webview or webview panel already registered')
        }

        const webviewPath = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webviews')
        panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'resources', 'active-chat-icon.svg')

        // Reset the webview options to ensure localResourceRoots is up-to-date
        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [webviewPath],
            enableCommandUris: true,
        }

        await addWebviewViewHTML(this.extensionUri, panel)

        // Register webview
        this._webviewPanel = panel
        this._webview = panel.webview
        this.postContextStatus()

        // Dispose panel when the panel is closed
        panel.onDidDispose(() => {
            this.cancelSubmitOrEditOperation()
            this._webviewPanel = undefined
            this._webview = undefined
            panel.dispose()
        })

        this.disposables.push(
            panel.webview.onDidReceiveMessage(message =>
                this.onDidReceiveMessage(
                    hydrateAfterPostMessage(message, uri => vscode.Uri.from(uri as any))
                )
            )
        )

        // Used for keeping sidebar chat view closed when webview panel is enabled
        await vscode.commands.executeCommand('setContext', CodyChatPanelViewType, true)

        const configFeatures = await ConfigFeaturesSingleton.getInstance().getConfigFeatures()
        void this.postMessage({
            type: 'setConfigFeatures',
            configFeatures: {
                chat: configFeatures.chat,
                attribution: configFeatures.attribution,
            },
        })

        return panel
    }
}

/**
 * A controller for a chat webview, whether in the sidebar or in a panel.
 */
export class ChatController implements vscode.Disposable, ChatSession {
    private chatModel: SimpleChatModel

    private config: ChatPanelConfig
    private readonly authProvider: AuthProvider
    private readonly chatClient: ChatClient
    private readonly codebaseStatusProvider: CodebaseStatusProvider
    private readonly localEmbeddings: LocalEmbeddingsController | null
    private readonly contextRanking: ContextRankingController | null
    private readonly symf: SymfRunner | null
    private readonly contextStatusAggregator = new ContextStatusAggregator()
    private readonly editor: VSCodeEditor
    private readonly treeView: TreeViewProvider
    private readonly guardrails: Guardrails
    private readonly remoteSearch: RemoteSearch | null
    private readonly repoPicker: RemoteRepoPicker | null

    private history = new ChatHistoryManager()
    private contextFilesQueryCancellation?: vscode.CancellationTokenSource
    private allMentionProvidersMetadataQueryCancellation?: vscode.CancellationTokenSource

    private disposables: vscode.Disposable[] = []
    public dispose(): void {
        vscode.Disposable.from(...this.disposables).dispose()
        this.disposables = []
    }

    public static async create(webview: vscode.Webview, options: SimpleChatPanelProviderOptions) {
        const c = new ChatController(webview, options)
        await c.initialize()
        return c
    }

    constructor(
        private webview: vscode.Webview,
        {
            config,
            extensionUri,
            authProvider,
            chatClient,
            localEmbeddings,
            contextRanking,
            symf,
            editor,
            treeView,
            models,
            guardrails,
            enterpriseContext,
        }: SimpleChatPanelProviderOptions
    ) {
        this.config = config
        this.extensionUri = extensionUri
        this.authProvider = authProvider
        this.chatClient = chatClient
        this.localEmbeddings = localEmbeddings
        this.contextRanking = contextRanking
        this.symf = symf
        this.repoPicker = enterpriseContext?.repoPicker || null
        this.remoteSearch = enterpriseContext?.createRemoteSearch() || null
        this.editor = editor
        this.treeView = treeView
        this.chatModel = new SimpleChatModel(chatModel.get(authProvider, models))
        this.guardrails = guardrails

        // TODO(beyang)
        //
        // if (TestSupport.instance) {
        //     TestSupport.instance.chatPanelProvider.set(this)
        // }

        // Advise local embeddings to start up if necessary.
        void this.localEmbeddings?.start()

        // Start the context Ranking module
        void this.contextRanking?.start()

        // Push context status to the webview when it changes.
        this.disposables.push(
            this.contextStatusAggregator.onDidChangeStatus(() => this.postContextStatus())
        )
        this.disposables.push(this.contextStatusAggregator)
        if (this.localEmbeddings) {
            this.disposables.push(this.contextStatusAggregator.addProvider(this.localEmbeddings))
        }
        this.codebaseStatusProvider = new CodebaseStatusProvider(
            this.editor,
            this.symf,
            enterpriseContext ? enterpriseContext.getCodebaseRepoIdMapper() : null
        )
        this.disposables.push(this.contextStatusAggregator.addProvider(this.codebaseStatusProvider))

        if (this.remoteSearch) {
            this.disposables.push(
                // Display enhanced context status from the remote search provider
                this.contextStatusAggregator.addProvider(this.remoteSearch),

                // When the codebase has a remote ID, include it automatically
                this.codebaseStatusProvider.onDidChangeStatus(async () => {
                    const codebase = await this.codebaseStatusProvider.currentCodebase()
                    if (codebase?.remote && codebase.remoteRepoId) {
                        this.remoteSearch?.setRepos(
                            [
                                {
                                    name: codebase.remote,
                                    id: codebase.remoteRepoId,
                                },
                            ],
                            RepoInclusion.Automatic
                        )
                    }
                })
            )
        }

        this.disposables.push(
            startClientStateBroadcaster({
                remoteSearch: this.remoteSearch,
                postMessage: (message: ExtensionMessage) => this.postMessage(message),
            })
        )
    }

    /**
     * Registers the given webview panel by setting up its options, icon, and handlers.
     * Also stores the panel reference and disposes it when closed.
     */
    private async initialize() {
        const webviewPath = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webviews')
        // TODO(beyang)
        //
        // panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'resources', 'active-chat-icon.svg')

        // Reset the webview options to ensure localResourceRoots is up-to-date
        this.webview.options = {
            enableScripts: true,
            localResourceRoots: [webviewPath],
            enableCommandUris: true,
        }

        await addWebviewViewHTML_new(this.extensionUri, this.webview)

        this.postContextStatus()

        // TODO(beyang)
        //
        // // Dispose panel when the panel is closed
        // panel.onDidDispose(() => {
        //     this.cancelSubmitOrEditOperation()
        //     this._webviewPanel = undefined
        //     this._webview = undefined
        //     panel.dispose()
        // })

        this.disposables.push(
            this.webview.onDidReceiveMessage(message =>
                this.onDidReceiveMessage(
                    hydrateAfterPostMessage(message, uri => vscode.Uri.from(uri as any))
                )
            )
        )

        // Used for keeping sidebar chat view closed when webview panel is enabled
        await vscode.commands.executeCommand('setContext', CodyChatPanelViewType, true)

        const configFeatures = await ConfigFeaturesSingleton.getInstance().getConfigFeatures()
        void this.postMessage({
            type: 'setConfigFeatures',
            configFeatures: {
                chat: configFeatures.chat,
                attribution: configFeatures.attribution,
            },
        })
    }

    /**
     * onDidReceiveMessage handles all user actions sent from the chat panel view.
     * @param message is the message from the view.
     */
    private async onDidReceiveMessage(message: WebviewMessage): Promise<void> {
        switch (message.command) {
            case 'ready':
                await this.handleReady()
                break
            case 'initialized':
                await this.handleInitialized()
                break
            case 'submit': {
                await this.handleUserMessageSubmission(
                    uuid.v4(),
                    PromptString.unsafe_fromUserQuery(message.text),
                    message.submitType,
                    message.contextFiles ?? [],
                    message.editorState as SerializedPromptEditorState,
                    message.addEnhancedContext ?? false,
                    this.startNewSubmitOrEditOperation(),
                    'chat'
                )
                break
            }
            case 'edit': {
                await this.handleEdit(
                    uuid.v4(),
                    PromptString.unsafe_fromUserQuery(message.text),
                    message.index ?? undefined,
                    message.contextFiles ?? [],
                    message.editorState as SerializedPromptEditorState,
                    message.addEnhancedContext || false
                )
                break
            }
            case 'abort':
                this.handleAbort()
                break
            case 'chatModel':
                this.handleSetChatModel(message.model)
                break
            case 'get-chat-models':
                this.postChatModels()
                break
            case 'getUserContext':
                await this.handleGetUserContextFilesCandidates(parseMentionQuery(message.query, null))
                break
            case 'getAllMentionProvidersMetadata':
                await this.handleGetAllMentionProvidersMetadata()
                break
            case 'queryContextItems':
                await this.handleGetUserContextFilesCandidates(message.query)
                break
            case 'insert':
                await handleCodeFromInsertAtCursor(message.text)
                break
            case 'copy':
                await handleCopiedCode(message.text, message.eventType === 'Button')
                break
            case 'links':
                void openExternalLinks(message.value)
                break
            // TODO(beyang)
            //
            // case 'openFile':
            //     await openFile(message.uri, message.range ?? undefined, this.webviewPanel?.viewColumn)
            //     break
            case 'openLocalFileWithRange':
                await openLocalFileWithRange(message.filePath, message.range ?? undefined)
                break
            case 'newFile':
                handleCodeFromSaveToNewFile(message.text)
                await this.editor.createWorkspaceFile(message.text)
                break
            case 'context/get-remote-search-repos': {
                await this.postMessage({
                    type: 'context/remote-repos',
                    repos: this.chatModel.getSelectedRepos() ?? [],
                })
                break
            }
            case 'context/choose-remote-search-repo': {
                await this.handleChooseRemoteSearchRepo(message.explicitRepos ?? undefined)
                break
            }
            case 'context/remove-remote-search-repo':
                void this.handleRemoveRemoteSearchRepo(message.repoId)
                break
            case 'embeddings/index':
                void this.localEmbeddings?.index()
                break
            case 'symf/index': {
                void this.handleSymfIndex()
                break
            }
            case 'show-page':
                await vscode.commands.executeCommand('cody.show-page', message.page)
                break
            case 'attribution-search':
                await this.handleAttributionSearch(message.snippet)
                break
            case 'restoreHistory':
                await this.restoreSession(message.chatID)
                break
            case 'reset':
                await this.clearAndRestartSession()
                break
            case 'event':
                telemetryService.log(message.eventName, message.properties ?? undefined)
                break
            case 'recordEvent':
                telemetryRecorder.recordEvent(
                    // 👷 HACK: We have no control over what gets sent over JSON RPC,
                    // so we depend on client implementations to give type guidance
                    // to ensure that we don't accidentally share arbitrary,
                    // potentially sensitive string values. In this RPC handler,
                    // when passing the provided event to the TelemetryRecorder
                    // implementation, we forcibly cast all the inputs below
                    // (feature, action, parameters) into known types (strings
                    // 'feature', 'action', 'key') so that the recorder will accept
                    // it. DO NOT do this elsewhere!
                    message.feature as 'feature',
                    message.action as 'action',
                    message.parameters as TelemetryEventParameters<
                        { key: number },
                        BillingProduct,
                        BillingCategory
                    >
                )
                break
            default:
                this.postError(new Error(`Invalid request type from Webview Panel: ${message.command}`))
        }
    }

    private async getConfigForWebview(): Promise<ConfigurationSubsetForWebview & LocalEnv> {
        const config = await getFullConfig()
        return {
            uiKindIsWeb: vscode.env.uiKind === vscode.UIKind.Web,
            serverEndpoint: config.serverEndpoint,
            experimentalNoodle: config.experimentalNoodle,
        }
    }

    // =======================================================================
    // #region top-level view action handlers
    // =======================================================================

    // When the webview sends the 'ready' message, respond by posting the view config
    private async handleReady(): Promise<void> {
        const authStatus = this.authProvider.getAuthStatus()
        const configForWebview = await this.getConfigForWebview()
        const workspaceFolderUris =
            vscode.workspace.workspaceFolders?.map(folder => folder.uri.toString()) ?? []
        await this.postMessage({
            type: 'config',
            config: configForWebview,
            authStatus,
            workspaceFolderUris,
        })
        logDebug('SimpleChatPanelProvider', 'updateViewConfig', {
            verbose: configForWebview,
        })
        // Update the chat model providers again to ensure the correct token limit is set on ready
        this.handleSetChatModel(this.chatModel.modelID)
    }

    private initDoer = new InitDoer<boolean | undefined>()
    private async handleInitialized(): Promise<void> {
        logDebug('SimpleChatPanelProvider', 'handleInitialized')
        // HACK: this call is necessary to get the webview to set the chatID state,
        // which is necessary on deserialization. It should be invoked before the
        // other initializers run (otherwise, it might interfere with other view
        // state)
        await this.webview?.postMessage({
            type: 'transcript',
            messages: [],
            isMessageInProgress: false,
            chatID: this.chatModel.sessionID,
        })

        this.postChatModels()
        await this.saveSession()
        this.initDoer.signalInitialized()
    }

    private async getRepoMetadataIfPublic(): Promise<string> {
        const currentCodebase = await this.codebaseStatusProvider.currentCodebase()
        if (currentCodebase?.isPublic) {
            const gitMetadata = {
                githubUrl: currentCodebase?.remote,
                commit: gitCommitIdFromGitExtension(currentCodebase?.localFolder),
            }
            return JSON.stringify(gitMetadata)
        }
        return ''
    }

    /**
     * Handles user input text for both new and edit submissions
     */
    public async handleUserMessageSubmission(
        requestID: string,
        inputText: PromptString,
        submitType: ChatSubmitType,
        mentions: ContextItem[],
        editorState: SerializedPromptEditorState | null,
        addEnhancedContext: boolean,
        abortSignal: AbortSignal,
        source?: EventSource,
        command?: DefaultChatCommands
    ): Promise<void> {
        return tracer.startActiveSpan('chat.submit', async (span): Promise<void> => {
            span.setAttribute('sampled', true)
            const authStatus = this.authProvider.getAuthStatus()
            const sharedProperties = {
                requestID,
                chatModel: this.chatModel.modelID,
                source,
                command,
                traceId: span.spanContext().traceId,
                sessionID: this.chatModel.sessionID,
                addEnhancedContext,
            }
            telemetryService.log('CodyVSCodeExtension:chat-question:submitted', sharedProperties)
            const mentionsInInitialContext = mentions.filter(
                item => item.source !== ContextItemSource.User
            )
            const mentionsByUser = mentions.filter(item => item.source === ContextItemSource.User)
            telemetryRecorder.recordEvent('cody.chat-question', 'submitted', {
                metadata: {
                    // Flag indicating this is a transcript event to go through ML data pipeline. Only for DotCom users
                    // See https://github.com/sourcegraph/sourcegraph/pull/59524
                    recordsPrivateMetadataTranscript: authStatus.endpoint && authStatus.isDotCom ? 1 : 0,
                    addEnhancedContext: addEnhancedContext ? 1 : 0,

                    // All mentions
                    mentionsTotal: mentions.length,
                    mentionsOfRepository: mentions.filter(item => item.type === 'repository').length,
                    mentionsOfTree: mentions.filter(item => item.type === 'tree').length,
                    mentionsOfWorkspaceRootTree: mentions.filter(
                        item => item.type === 'tree' && item.isWorkspaceRoot
                    ).length,
                    mentionsOfFile: mentions.filter(item => item.type === 'file').length,

                    // Initial context mentions
                    mentionsInInitialContext: mentionsInInitialContext.length,
                    mentionsInInitialContextOfRepository: mentionsInInitialContext.filter(
                        item => item.type === 'repository'
                    ).length,
                    mentionsInInitialContextOfTree: mentionsInInitialContext.filter(
                        item => item.type === 'tree'
                    ).length,
                    mentionsInInitialContextOfWorkspaceRootTree: mentionsInInitialContext.filter(
                        item => item.type === 'tree' && item.isWorkspaceRoot
                    ).length,
                    mentionsInInitialContextOfFile: mentionsInInitialContext.filter(
                        item => item.type === 'file'
                    ).length,

                    // Explicit mentions by user
                    mentionsByUser: mentionsByUser.length,
                    mentionsByUserOfRepository: mentionsByUser.filter(item => item.type === 'repository')
                        .length,
                    mentionsByUserOfTree: mentionsByUser.filter(item => item.type === 'tree').length,
                    mentionsByUserOfWorkspaceRootTree: mentionsByUser.filter(
                        item => item.type === 'tree' && item.isWorkspaceRoot
                    ).length,
                    mentionsByUserOfFile: mentionsByUser.filter(item => item.type === 'file').length,
                },
                privateMetadata: {
                    ...sharedProperties,
                    // 🚨 SECURITY: chat transcripts are to be included only for DotCom users AND for V2 telemetry
                    // V2 telemetry exports privateMetadata only for DotCom users
                    // the condition below is an additional safeguard measure
                    promptText:
                        authStatus.isDotCom && truncatePromptString(inputText, CHAT_INPUT_TOKEN_BUDGET),
                    gitMetadata:
                        authStatus.isDotCom && addEnhancedContext
                            ? await this.getRepoMetadataIfPublic()
                            : '',
                },
            })

            tracer.startActiveSpan('chat.submit.firstToken', async (firstTokenSpan): Promise<void> => {
                if (inputText.toString().match(/^\/reset$/)) {
                    span.addEvent('clearAndRestartSession')
                    span.end()
                    return this.clearAndRestartSession()
                }

                if (submitType === 'user-newchat' && !this.chatModel.isEmpty()) {
                    span.addEvent('clearAndRestartSession')
                    await this.clearAndRestartSession()
                    abortSignal.throwIfAborted()
                }

                this.chatModel.addHumanMessage({ text: inputText, editorState })
                await this.saveSession()
                abortSignal.throwIfAborted()

                this.postEmptyMessageInProgress()

                // Add user's current selection as context for chat messages.
                const selectionContext = source === 'chat' ? await getContextFileFromSelection() : []
                abortSignal.throwIfAborted()

                const userContextItems: ContextItemWithContent[] = await resolveContextItems(
                    this.editor,
                    [...mentions, ...selectionContext],
                    inputText
                )
                abortSignal.throwIfAborted()

                /**
                 * Whether the input has repository or tree mentions that need large-corpus
                 * context-fetching (embeddings, symf, and/or context search).
                 */
                const corpusMentions = mentions.filter(
                    item => item.type === 'repository' || item.type === 'tree'
                )
                const hasCorpusMentions = corpusMentions.length > 0

                span.setAttribute('strategy', this.config.useContext)
                const prompter = new DefaultPrompter(
                    userContextItems,
                    addEnhancedContext || hasCorpusMentions
                        ? async text =>
                              getEnhancedContext({
                                  strategy: this.config.useContext,
                                  editor: this.editor,
                                  input: { text, mentions },
                                  addEnhancedContext,
                                  providers: {
                                      localEmbeddings: this.localEmbeddings,
                                      symf: this.symf,
                                      remoteSearch: this.remoteSearch,
                                  },
                                  contextRanking: this.contextRanking,
                              })
                        : undefined
                )
                const sendTelemetry = (contextSummary: any, privateContextStats?: any): void => {
                    const properties = {
                        ...sharedProperties,
                        traceId: span.spanContext().traceId,
                    }
                    span.setAttributes(properties)
                    firstTokenSpan.setAttributes(properties)

                    telemetryService.log('CodyVSCodeExtension:chat-question:executed', properties, {
                        hasV2Event: true,
                    })
                    telemetryRecorder.recordEvent('cody.chat-question', 'executed', {
                        metadata: {
                            ...contextSummary,
                            // Flag indicating this is a transcript event to go through ML data pipeline. Only for DotCom users
                            // See https://github.com/sourcegraph/sourcegraph/pull/59524
                            recordsPrivateMetadataTranscript: authStatus.isDotCom ? 1 : 0,
                        },
                        privateMetadata: {
                            properties,
                            privateContextStats,
                            // 🚨 SECURITY: chat transcripts are to be included only for DotCom users AND for V2 telemetry
                            // V2 telemetry exports privateMetadata only for DotCom users
                            // the condition below is an additional safeguard measure
                            promptText:
                                authStatus.isDotCom &&
                                truncatePromptString(inputText, CHAT_INPUT_TOKEN_BUDGET),
                        },
                    })
                }

                try {
                    const prompt = await this.buildPrompt(prompter, abortSignal, sendTelemetry)
                    abortSignal.throwIfAborted()
                    this.streamAssistantResponse(requestID, prompt, span, firstTokenSpan, abortSignal)
                } catch (error) {
                    if (isAbortErrorOrSocketHangUp(error as Error)) {
                        return
                    }
                    if (isRateLimitError(error)) {
                        this.postError(error, 'transcript')
                    } else {
                        this.postError(
                            isError(error)
                                ? error
                                : new Error(`Error generating assistant response: ${error}`)
                        )
                    }
                    recordErrorToSpan(span, error as Error)
                }
            })
        })
    }

    private submitOrEditOperation: AbortController | undefined
    public startNewSubmitOrEditOperation(): AbortSignal {
        this.submitOrEditOperation?.abort()
        this.submitOrEditOperation = new AbortController()
        return this.submitOrEditOperation.signal
    }
    private cancelSubmitOrEditOperation(): void {
        if (this.submitOrEditOperation) {
            this.submitOrEditOperation.abort()
            this.submitOrEditOperation = undefined
        }
    }

    /**
     * Handles editing a human chat message in current chat session.
     *
     * Removes any existing messages from the provided index,
     * before submitting the replacement text as a new question.
     * When no index is provided, default to the last human message.
     */
    private async handleEdit(
        requestID: string,
        text: PromptString,
        index: number | undefined,
        contextFiles: ContextItem[],
        editorState: SerializedPromptEditorState | null,
        addEnhancedContext = true
    ): Promise<void> {
        const abortSignal = this.startNewSubmitOrEditOperation()

        telemetryService.log('CodyVSCodeExtension:editChatButton:clicked', undefined, {
            hasV2Event: true,
        })
        telemetryRecorder.recordEvent('cody.editChatButton', 'clicked')

        try {
            const humanMessage = index ?? this.chatModel.getLastSpeakerMessageIndex('human')
            if (humanMessage === undefined) {
                return
            }
            this.chatModel.removeMessagesFromIndex(humanMessage, 'human')
            return await this.handleUserMessageSubmission(
                requestID,
                text,
                'user',
                contextFiles,
                editorState,
                addEnhancedContext,
                abortSignal,
                'chat'
            )
        } catch {
            this.postError(new Error('Failed to edit prompt'), 'transcript')
        }
    }

    private handleAbort(): void {
        this.cancelSubmitOrEditOperation()

        telemetryService.log('CodyVSCodeExtension:abortButton:clicked', { hasV2Event: true })
        telemetryRecorder.recordEvent('cody.sidebar.abortButton', 'clicked')
    }

    private async handleSetChatModel(modelID: string): Promise<void> {
        this.chatModel.updateModel(modelID)
        await chatModel.set(modelID)
    }

    private async handleGetAllMentionProvidersMetadata(): Promise<void> {
        // Cancel previously in-flight query.
        const cancellation = new vscode.CancellationTokenSource()
        this.allMentionProvidersMetadataQueryCancellation?.cancel()
        this.allMentionProvidersMetadataQueryCancellation = cancellation

        try {
            const providers = await allMentionProvidersMetadata()
            if (cancellation.token.isCancellationRequested) {
                return
            }
            void this.postMessage({
                type: 'allMentionProvidersMetadata',
                providers,
            })
        } catch (error) {
            if (cancellation.token.isCancellationRequested) {
                return
            }
            cancellation.cancel()
            this.postError(new Error(`Error retrieving context files: ${error}`))
        } finally {
            cancellation.dispose()
        }
    }

    private async handleGetUserContextFilesCandidates(query: MentionQuery): Promise<void> {
        // Cancel previously in-flight query.
        const cancellation = new vscode.CancellationTokenSource()
        this.contextFilesQueryCancellation?.cancel()
        this.contextFilesQueryCancellation = cancellation

        const source = 'chat'
        const scopedTelemetryRecorder: Parameters<typeof getChatContextItemsForMention>[2] = {
            empty: () => {
                telemetryService.log('CodyVSCodeExtension:at-mention:executed', {
                    source,
                })
                telemetryRecorder.recordEvent('cody.at-mention', 'executed', {
                    privateMetadata: { source },
                })
            },
            withProvider: (provider, providerMetadata) => {
                telemetryService.log(`CodyVSCodeExtension:at-mention:${provider}:executed`, {
                    source,
                    providerMetadata,
                })
                telemetryRecorder.recordEvent(`cody.at-mention.${provider}`, 'executed', {
                    privateMetadata: { source, providerMetadata },
                })
            },
        }

        try {
            const items = await getChatContextItemsForMention(
                query,
                cancellation.token,
                scopedTelemetryRecorder
            )
            if (cancellation.token.isCancellationRequested) {
                return
            }
            const { input, context } = this.chatModel.contextWindow
            const userContextFiles = items.map(f => ({
                ...f,
                isTooLarge: f.size ? f.size > (context?.user || input) : undefined,
            }))
            void this.postMessage({
                type: 'userContextFiles',
                userContextFiles,
            })
        } catch (error) {
            if (cancellation.token.isCancellationRequested) {
                return
            }
            cancellation.cancel()
            this.postError(new Error(`Error retrieving context files: ${error}`))
        } finally {
            cancellation.dispose()
        }
    }

    public async handleGetUserEditorContext(uri?: URI): Promise<void> {
        // Get selection from the active editor
        const selection = vscode.window.activeTextEditor?.selection

        // Determine context based on URI presence
        const contextItem = uri
            ? await getContextFileFromUri(uri, selection)
            : await getContextFileFromCursor()

        const { input, context } = this.chatModel.contextWindow
        const userContextSize = context?.user ?? input

        void this.postMessage({
            type: 'clientAction',
            addContextItemsToLastHumanInput: contextItem
                ? [
                      {
                          ...contextItem,
                          type: 'file',
                          // Remove content to avoid sending large data to the webview
                          content: undefined,
                          isTooLarge: contextItem.size ? contextItem.size > userContextSize : undefined,
                          source: ContextItemSource.User,
                          range: contextItem.range,
                      } satisfies ContextItem,
                  ]
                : [],
        })

        // TODO(beyang):
        //
        // // Reveal the webview panel if it is hidden
        // this.webviewPanel?.reveal()
    }

    private async handleSymfIndex(): Promise<void> {
        const codebase = await this.codebaseStatusProvider.currentCodebase()
        if (codebase && isFileURI(codebase.localFolder)) {
            await this.symf?.ensureIndex(codebase.localFolder, {
                retryIfLastAttemptFailed: true,
                ignoreExisting: false,
            })
        }
    }

    private async handleAttributionSearch(snippet: string): Promise<void> {
        try {
            const attribution = await this.guardrails.searchAttribution(snippet)
            if (isError(attribution)) {
                await this.postMessage({
                    type: 'attribution',
                    snippet,
                    error: attribution.message,
                })
                return
            }
            await this.postMessage({
                type: 'attribution',
                snippet,
                attribution: {
                    repositoryNames: attribution.repositories.map(r => r.name),
                    limitHit: attribution.limitHit,
                },
            })
        } catch (error) {
            await this.postMessage({
                type: 'attribution',
                snippet,
                error: `${error}`,
            })
        }
    }

    private async handleChooseRemoteSearchRepo(explicitRepos?: Repo[]): Promise<void> {
        if (!this.remoteSearch) {
            return
        }
        const repos =
            explicitRepos ??
            (await this.repoPicker?.show(this.remoteSearch.getRepos(RepoInclusion.Manual)))
        if (repos) {
            this.chatModel.setSelectedRepos(repos)
            this.remoteSearch.setRepos(repos, RepoInclusion.Manual)
        }
    }

    private handleRemoveRemoteSearchRepo(repoId: string): void {
        this.remoteSearch?.removeRepo(repoId)
    }

    // #endregion
    // =======================================================================
    // #region view updaters
    // =======================================================================

    private postEmptyMessageInProgress(): void {
        this.postViewTranscript({ speaker: 'assistant', model: this.chatModel.modelID })
    }

    private postViewTranscript(messageInProgress?: ChatMessage): void {
        const messages: ChatMessage[] = [...this.chatModel.getMessages()]
        if (messageInProgress) {
            messages.push(messageInProgress)
        }

        // We never await on postMessage, because it can sometimes hang indefinitely:
        // https://github.com/microsoft/vscode/issues/159431
        void this.postMessage({
            type: 'transcript',
            messages: messages.map(prepareChatMessage).map(serializeChatMessage),
            isMessageInProgress: !!messageInProgress,
            chatID: this.chatModel.sessionID,
        })

        // Update webview panel title
        this.postChatTitle()
    }

    /**
     * Display error message in webview as part of the chat transcript, or as a system banner alongside the chat.
     */
    private postError(error: Error, type?: MessageErrorType): void {
        logDebug('SimpleChatPanelProvider: postError', error.message)
        // Add error to transcript
        if (type === 'transcript') {
            this.chatModel.addErrorAsBotMessage(error)
            this.postViewTranscript()
            void this.postMessage({
                type: 'transcript-errors',
                isTranscriptError: true,
            })
            return
        }

        void this.postMessage({ type: 'errors', errors: error.message })
        captureException(error)
    }

    private postChatModels(): void {
        const authStatus = this.authProvider.getAuthStatus()
        if (!authStatus?.isLoggedIn) {
            return
        }
        const models = ModelsService.getModels(
            ModelUsage.Chat,
            authStatus.isDotCom && !authStatus.userCanUpgrade,
            this.chatModel.modelID
        )

        void this.postMessage({
            type: 'chatModels',
            models,
        })
    }

    private postContextStatus(): void {
        const { status } = this.contextStatusAggregator
        void this.postMessage({
            type: 'enhanced-context',
            enhancedContextStatus: { groups: status },
        })
        // Only log non-empty status to reduce noises.
        if (status.length > 0) {
            logDebug('SimpleChatPanelProvider', 'postContextStatus', JSON.stringify(status))
        }
    }

    /**
     * Low-level utility to post a message to the webview, pending initialization.
     *
     * cody-invariant: this.webview?.postMessage should never be invoked directly
     * except within this method.
     */
    private postMessage(message: ExtensionMessage): Thenable<boolean | undefined> {
        return this.initDoer.do(() => this.webview?.postMessage(message))
    }

    private postChatTitle(): void {
        // TODO(beyang)
        //
        // if (this.webviewPanel) {
        //     this.webviewPanel.title = this.chatModel.getChatTitle()
        // }
    }

    // #endregion
    // =======================================================================
    // #region chat request lifecycle methods
    // =======================================================================

    /**
     * Constructs the prompt and updates the UI with the context used in the prompt.
     */
    private async buildPrompt(
        prompter: DefaultPrompter,
        abortSignal: AbortSignal,
        sendTelemetry?: (contextSummary: any, privateContextStats?: any) => void
    ): Promise<Message[]> {
        const { prompt, context } = await prompter.makePrompt(
            this.chatModel,
            this.authProvider.getAuthStatus().codyApiVersion
        )
        abortSignal.throwIfAborted()

        // Update UI based on prompt construction
        // Includes the excluded context items to display in the UI
        this.chatModel.setLastMessageContext([...context.used, ...context.ignored])

        if (sendTelemetry) {
            // Create a summary of how many code snippets of each context source are being
            // included in the prompt
            const contextSummary: { [key: string]: number } = {}
            for (const { source } of context.used) {
                if (!source) {
                    continue
                }
                if (contextSummary[source]) {
                    contextSummary[source] += 1
                } else {
                    contextSummary[source] = 1
                }
            }

            // Log the size of all user context items (e.g., @-mentions)
            // Includes the count of files and the size of each file
            const getContextStats = (files: ContextItem[]) =>
                files.length && {
                    countFiles: files.length,
                    fileSizes: files.map(f => f.size).filter(isDefined),
                }
            // NOTE: The private context stats are only logged for DotCom users
            const privateContextStats = {
                included: getContextStats(context.used.filter(f => f.source === 'user')),
                excluded: getContextStats(context.ignored.filter(f => f.source === 'user')),
            }
            sendTelemetry(contextSummary, privateContextStats)
        }

        return prompt
    }

    private streamAssistantResponse(
        requestID: string,
        prompt: Message[],
        span: Span,
        firstTokenSpan: Span,
        abortSignal: AbortSignal
    ): void {
        logDebug('SimpleChatPanelProvider', 'streamAssistantResponse', {
            verbose: { requestID, prompt },
        })
        let firstTokenMeasured = false
        function measureFirstToken() {
            if (firstTokenMeasured) {
                return
            }
            firstTokenMeasured = true
            span.addEvent('firstToken')
            firstTokenSpan.end()
        }

        abortSignal.throwIfAborted()
        this.postEmptyMessageInProgress()
        this.sendLLMRequest(
            prompt,
            {
                update: content => {
                    abortSignal.throwIfAborted()
                    measureFirstToken()
                    span.addEvent('update')
                    this.postViewTranscript({
                        speaker: 'assistant',
                        text: PromptString.unsafe_fromLLMResponse(content),
                        model: this.chatModel.modelID,
                    })
                },
                close: content => {
                    abortSignal.throwIfAborted()
                    measureFirstToken()
                    recordExposedExperimentsToSpan(span)
                    span.end()
                    this.addBotMessage(requestID, PromptString.unsafe_fromLLMResponse(content))
                },
                error: (partialResponse, error) => {
                    if (isAbortErrorOrSocketHangUp(error)) {
                        throw error
                    }
                    this.postError(error, 'transcript')
                    try {
                        // We should still add the partial response if there was an error
                        // This'd throw an error if one has already been added
                        this.addBotMessage(
                            requestID,
                            PromptString.unsafe_fromLLMResponse(partialResponse)
                        )
                    } catch {
                        console.error('Streaming Error', error)
                    }
                    recordErrorToSpan(span, error)
                },
            },
            abortSignal
        )
    }

    /**
     * Issue the chat request and stream the results back, updating the model and view
     * with the response.
     */
    private async sendLLMRequest(
        prompt: Message[],
        callbacks: {
            update: (response: string) => void
            close: (finalResponse: string) => void
            error: (completedResponse: string, error: Error) => void
        },
        abortSignal: AbortSignal
    ): Promise<void> {
        let lastContent = ''
        const typewriter = new Typewriter({
            update: content => {
                lastContent = content
                callbacks.update(content)
            },
            close: () => {
                callbacks.close(lastContent)
            },
            error: error => {
                callbacks.error(lastContent, error)
            },
        })

        try {
            const stream = this.chatClient.chat(
                prompt,
                {
                    model: this.chatModel.modelID,
                    maxTokensToSample: this.chatModel.contextWindow.output,
                },
                abortSignal
            )

            for await (const message of stream) {
                switch (message.type) {
                    case 'change': {
                        typewriter.update(message.text)
                        break
                    }
                    case 'complete': {
                        typewriter.close()
                        typewriter.stop()
                        break
                    }
                    case 'error': {
                        typewriter.close()
                        typewriter.stop(message.error)
                    }
                }
            }
        } catch (error: unknown) {
            typewriter.close()
            typewriter.stop(isAbortErrorOrSocketHangUp(error as Error) ? undefined : (error as Error))
        }
    }

    /**
     * Finalizes adding a bot message to the chat model and triggers an update to the view.
     */
    private addBotMessage(requestID: string, rawResponse: PromptString): void {
        const messageText = reformatBotMessageForChat(rawResponse)
        this.chatModel.addBotMessage({ text: messageText })
        void this.saveSession()
        this.postViewTranscript()

        const authStatus = this.authProvider.getAuthStatus()

        // Count code generated from response
        const generatedCode = countGeneratedCode(messageText.toString())
        const responseEventAction = generatedCode.charCount > 0 ? 'hasCode' : 'noCode'
        telemetryService.log(
            `CodyVSCodeExtension:chatResponse:${responseEventAction}`,
            { ...generatedCode, requestID, chatModel: this.chatModel.modelID },
            { hasV2Event: true }
        )
        telemetryRecorder.recordEvent('cody.chatResponse', responseEventAction, {
            version: 2, // increment for major changes to this event
            interactionID: requestID,
            metadata: {
                ...generatedCode,
                // Flag indicating this is a transcript event to go through ML data pipeline. Only for dotcom users
                // See https://github.com/sourcegraph/sourcegraph/pull/59524
                recordsPrivateMetadataTranscript: authStatus.isDotCom ? 1 : 0,
            },
            privateMetadata: {
                // 🚨 SECURITY: chat transcripts are to be included only for DotCom users AND for V2 telemetry
                // V2 telemetry exports privateMetadata only for DotCom users
                // the condition below is an aditional safegaurd measure
                responseText:
                    authStatus.isDotCom && truncatePromptString(messageText, CHAT_OUTPUT_TOKEN_BUDGET),
                chatModel: this.chatModel.modelID,
            },
        })
    }

    // #endregion
    // =======================================================================
    // #region session management
    // =======================================================================

    // A unique identifier for this SimpleChatPanelProvider instance used to identify
    // it when a handle to this specific panel provider is needed.
    public get sessionID(): string {
        return this.chatModel.sessionID
    }

    // Sets the provider up for a new chat that is not being restored from a
    // saved session.
    public async newSession(): Promise<void> {
        // Set the remote search's selected repos to the workspace repo list
        // by default.
        this.remoteSearch?.setRepos(
            (await this.repoPicker?.getDefaultRepos()) || [],
            RepoInclusion.Manual
        )
    }

    // Attempts to restore the chat to the given sessionID, if it exists in
    // history. If it does, then saves the current session and cancels the
    // current in-progress completion. If the chat does not exist, then this
    // is a no-op.
    public async restoreSession(sessionID: string): Promise<void> {
        const oldTranscript = this.history.getChat(this.authProvider.getAuthStatus(), sessionID)
        if (!oldTranscript) {
            return this.newSession()
        }
        this.cancelSubmitOrEditOperation()
        const newModel = newChatModelFromSerializedChatTranscript(oldTranscript, this.chatModel.modelID)
        this.chatModel = newModel

        // Restore per-chat enhanced context settings
        if (this.remoteSearch) {
            const repos =
                this.chatModel.getSelectedRepos() || (await this.repoPicker?.getDefaultRepos()) || []
            this.remoteSearch.setRepos(repos, RepoInclusion.Manual)
        }

        this.postViewTranscript()
    }

    private async saveSession(): Promise<void> {
        const allHistory = await this.history.saveChat(
            this.authProvider.getAuthStatus(),
            this.chatModel.toSerializedChatTranscript()
        )
        if (allHistory) {
            void this.postMessage({
                type: 'history',
                localHistory: allHistory,
            })
        }
        await this.treeView.updateTree(this.authProvider.getAuthStatus())
    }

    public async clearAndRestartSession(): Promise<void> {
        if (this.chatModel.isEmpty()) {
            return
        }

        this.cancelSubmitOrEditOperation()
        await this.saveSession()

        this.chatModel = new SimpleChatModel(this.chatModel.modelID)
        this.postViewTranscript()
    }

    // #endregion
    // =======================================================================
    // #region webview container management
    // =======================================================================

    private extensionUri: vscode.Uri
    // private _webviewPanel?: vscode.WebviewPanel
    // public get webviewPanel(): vscode.WebviewPanel | undefined {
    //     return this._webviewPanel
    // }
    // private _webview?: ChatViewProviderWebview
    // public get webview(): ChatViewProviderWebview | undefined {
    //     return this._webview
    // }

    // TODO(beyang)
    //
    // /**
    //  * Creates the webview panel for the Cody chat interface if it doesn't already exist.
    //  */
    // public async createWebviewPanel(
    //     activePanelViewColumn?: vscode.ViewColumn,
    //     _chatId?: string,
    //     lastQuestion?: string
    // ): Promise<vscode.WebviewPanel> {
    //     // Checks if the webview panel already exists and is visible.
    //     // If so, returns early to avoid creating a duplicate.
    //     if (this.webviewPanel) {
    //         return this.webviewPanel
    //     }

    //     const viewType = CodyChatPanelViewType
    //     const panelTitle =
    //         this.history.getChat(this.authProvider.getAuthStatus(), this.chatModel.sessionID)
    //             ?.chatTitle || getChatPanelTitle(lastQuestion)
    //     const viewColumn = activePanelViewColumn || vscode.ViewColumn.Beside
    //     const webviewPath = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webviews')
    //     const panel = vscode.window.createWebviewPanel(
    //         viewType,
    //         panelTitle,
    //         { viewColumn, preserveFocus: true },
    //         {
    //             enableScripts: true,
    //             retainContextWhenHidden: true,
    //             enableFindWidget: true,
    //             localResourceRoots: [webviewPath],
    //             enableCommandUris: true,
    //         }
    //     )

    //     return this.registerWebviewPanel(panel)
    // }

    // /**
    //  * Revives the chat panel when the extension is reactivated.
    //  */
    // public async revive(webviewPanel: vscode.WebviewPanel): Promise<void> {
    //     logDebug('SimpleChatPanelProvider:revive', 'registering webview panel')
    //     await this.registerWebviewPanel(webviewPanel)
    // }

    // #endregion
    // =======================================================================
    // #region other public accessors and mutators
    // =======================================================================

    // Convenience function for tests
    public getViewTranscript(): readonly ChatMessage[] {
        return this.chatModel.getMessages().map(prepareChatMessage)
    }
}
