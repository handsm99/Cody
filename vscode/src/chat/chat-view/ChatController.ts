import * as uuid from 'uuid'
import * as vscode from 'vscode'

import {
    type AuthStatus,
    type BillingCategory,
    type BillingProduct,
    CHAT_INPUT_TOKEN_BUDGET,
    CHAT_OUTPUT_TOKEN_BUDGET,
    type ChatClient,
    type ChatMessage,
    ClientConfigSingleton,
    type ClientConfigurationWithAccessToken,
    CodyIDE,
    type ConfigWatcher,
    type ContextItem,
    type ContextItemOpenCtx,
    ContextItemSource,
    DOTCOM_URL,
    type DefaultChatCommands,
    type EventSource,
    type Guardrails,
    type Message,
    ModelUsage,
    PromptString,
    type RankedContext,
    type SerializedChatInteraction,
    type SerializedChatTranscript,
    type SerializedPromptEditorState,
    Typewriter,
    addMessageListenersForExtensionAPI,
    createMessageAPIForExtension,
    featureFlagProvider,
    getContextForChatMessage,
    hydrateAfterPostMessage,
    inputTextWithoutContextChipsFromPromptEditorState,
    isAbortErrorOrSocketHangUp,
    isContextWindowLimitError,
    isDefined,
    isDotCom,
    isError,
    isRateLimitError,
    modelsService,
    parseMentionQuery,
    recordErrorToSpan,
    reformatBotMessageForChat,
    serializeChatMessage,
    startWith,
    telemetryRecorder,
    tracer,
    truncatePromptString,
} from '@sourcegraph/cody-shared'

import type { Span } from '@opentelemetry/api'
import { captureException } from '@sentry/core'
import {
    combineLatest,
    promiseFactoryToObservable,
    promiseToObservable,
} from '@sourcegraph/cody-shared/src/misc/observable'
import { TokenCounterUtils } from '@sourcegraph/cody-shared/src/token/counter'
import type { TelemetryEventParameters } from '@sourcegraph/telemetry'
import { map } from 'observable-fns'
import type { URI } from 'vscode-uri'
import { version as VSCEVersion } from '../../../package.json'
import { View } from '../../../webviews/tabs/types'
import { redirectToEndpointLogin, showSignOutMenu } from '../../auth/auth'
import {
    closeAuthProgressIndicator,
    startAuthProgressIndicator,
} from '../../auth/auth-progress-indicator'
import type { startTokenReceiver } from '../../auth/token-receiver'
import { getContextFileFromUri } from '../../commands/context/file-path'
import { getContextFileFromCursor, getContextFileFromSelection } from '../../commands/context/selection'
import { getConfigWithEndpoint } from '../../configuration'
import type { EnterpriseContextFactory } from '../../context/enterprise-context-factory'
import { resolveContextItems } from '../../editor/utils/editor-context'
import type { VSCodeEditor } from '../../editor/vscode-editor'
import type { ExtensionClient } from '../../extension-client'
import type { LocalEmbeddingsController } from '../../local-context/local-embeddings'
import type { SymfRunner } from '../../local-context/symf'
import { logDebug } from '../../log'
import { migrateAndNotifyForOutdatedModels } from '../../models/modelMigrator'
import { mergedPromptsAndLegacyCommands } from '../../prompts/prompts'
import { workspaceReposMonitor } from '../../repository/repo-metadata-from-git-api'
import { authProvider } from '../../services/AuthProvider'
import { AuthProviderSimplified } from '../../services/AuthProviderSimplified'
import { recordExposedExperimentsToSpan } from '../../services/open-telemetry/utils'
import {
    handleCodeFromInsertAtCursor,
    handleCodeFromSaveToNewFile,
    handleCopiedCode,
    handleSmartApply,
} from '../../services/utils/codeblock-action-tracker'
import { openExternalLinks, openLocalFileWithRange } from '../../services/utils/workspace-action'
import { TestSupport } from '../../test-support'
import type { MessageErrorType } from '../MessageProvider'
import {
    getCorpusContextItemsForEditorState,
    startClientStateBroadcaster,
} from '../clientStateBroadcaster'
import { getChatContextItemsForMention, getMentionMenuData } from '../context/chatContext'
import type { ContextAPIClient } from '../context/contextAPIClient'
import type {
    ChatSubmitType,
    ConfigurationSubsetForWebview,
    ExtensionMessage,
    LocalEnv,
    SmartApplyResult,
    WebviewMessage,
} from '../protocol'
import { countGeneratedCode } from '../utils'
import { chatHistory } from './ChatHistoryManager'
import { ChatModel, prepareChatMessage } from './ChatModel'
import { CodyChatEditorViewType } from './ChatsController'
import { type ContextRetriever, toStructuredMentions } from './ContextRetriever'
import { InitDoer } from './InitDoer'
import { getChatPanelTitle, openFile } from './chat-helpers'
import { type HumanInput, getPriorityContext } from './context'
import { DefaultPrompter, type PromptInfo } from './prompt'

interface ChatControllerOptions {
    extensionUri: vscode.Uri
    chatClient: ChatClient

    retrievers: AuthDependentRetrievers

    contextRetriever: ContextRetriever
    contextAPIClient: ContextAPIClient | null

    extensionClient: ExtensionClient

    editor: VSCodeEditor
    guardrails: Guardrails
    startTokenReceiver?: typeof startTokenReceiver

    configWatcher: ConfigWatcher<ClientConfigurationWithAccessToken>
}

export interface ChatSession {
    webviewPanelOrView: vscode.WebviewView | vscode.WebviewPanel | undefined
    sessionID: string
}

export class AuthDependentRetrievers {
    constructor(
        private _localEmbeddings: LocalEmbeddingsController | null,
        private _symf: SymfRunner | null,
        private _enterpriseContext: EnterpriseContextFactory | null
    ) {}

    private isCodyWeb(): boolean {
        return vscode.workspace.getConfiguration().get<string>('cody.advanced.agent.ide') === CodyIDE.Web
    }

    private isConsumer(): boolean {
        return isDotCom(authProvider.instance!.status)
    }

    private allowRemoteContext(): boolean {
        return this.isCodyWeb() || !this.isConsumer()
    }

    get localEmbeddings(): LocalEmbeddingsController | null {
        return this.isConsumer() ? this._localEmbeddings : null
    }

    get symf(): SymfRunner | null {
        return this.isConsumer() ? this._symf : null
    }

    get enterpriseContext(): EnterpriseContextFactory | null {
        return this.allowRemoteContext() ? this._enterpriseContext : null
    }
}

/**
 * ChatController is the view controller class for the chat panel.
 * It handles all events sent from the view, keeps track of the underlying chat model,
 * and interacts with the rest of the extension.
 *
 * Its methods are grouped into the following sections, each of which is demarcated
 * by a comment block (search for "// #region "):
 *
 * 1. top-level view action handlers
 * 2. view updaters
 * 3. chat request lifecycle methods
 * 4. session management
 * 5. webview container management
 * 6. other public accessors and mutators
 *
 * The following invariants should be maintained:
 * 1. top-level view action handlers
 *    a. should all follow the handle$ACTION naming convention
 *    b. should be private (with the existing exceptions)
 * 2. view updaters
 *    a. should all follow the post$ACTION naming convention
 *    b. should NOT mutate model state
 * 3. Keep the public interface of this class small in order to
 *    avoid tight coupling with other classes. If communication
 *    with other components outside the model and view is needed,
 *    use a broadcast/subscription design.
 */
export class ChatController implements vscode.Disposable, vscode.WebviewViewProvider, ChatSession {
    private chatModel: ChatModel

    private readonly chatClient: ChatClient

    private readonly retrievers: AuthDependentRetrievers

    private readonly contextRetriever: ContextRetriever

    private readonly editor: VSCodeEditor
    private readonly extensionClient: ExtensionClient
    private readonly guardrails: Guardrails

    private readonly startTokenReceiver: typeof startTokenReceiver | undefined
    private readonly contextAPIClient: ContextAPIClient | null
    private configWatcher: ConfigWatcher<ClientConfigurationWithAccessToken>

    private disposables: vscode.Disposable[] = []

    public dispose(): void {
        vscode.Disposable.from(...this.disposables).dispose()
        this.disposables = []
    }

    constructor({
        extensionUri,
        chatClient,
        retrievers,
        editor,
        guardrails,
        startTokenReceiver,
        contextAPIClient,
        contextRetriever,
        extensionClient,
        configWatcher,
    }: ChatControllerOptions) {
        this.extensionUri = extensionUri
        this.chatClient = chatClient
        this.retrievers = retrievers
        this.editor = editor
        this.extensionClient = extensionClient
        this.contextRetriever = contextRetriever
        this.configWatcher = configWatcher

        this.chatModel = new ChatModel(getDefaultModelID())

        this.guardrails = guardrails
        this.startTokenReceiver = startTokenReceiver
        this.contextAPIClient = contextAPIClient

        if (TestSupport.instance) {
            TestSupport.instance.chatPanelProvider.set(this)
        }

        // Advise local embeddings to start up if necessary.
        void this.retrievers.localEmbeddings?.start()

        // Keep feature flags updated.
        this.disposables.push({
            dispose: featureFlagProvider.instance!.onFeatureFlagChanged('', () => {
                void this.sendConfig()
            }),
        })

        this.disposables.push(
            startClientStateBroadcaster({
                useRemoteSearch: this.retrievers.enterpriseContext !== null,
                postMessage: (message: ExtensionMessage) => this.postMessage(message),
                chatModel: this.chatModel,
            })
        )

        // Observe any changes in chat history and send client notifications to
        // the consumer
        this.disposables.push(
            chatHistory.onHistoryChanged(chatHistory => {
                this.postMessage({ type: 'history', localHistory: chatHistory })
            })
        )
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
                this.setWebviewView(View.Chat)
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
            case 'getUserContext': {
                const result = await getChatContextItemsForMention({
                    mentionQuery: parseMentionQuery(message.query, null),
                })
                await this.postMessage({
                    type: 'userContextFiles',
                    userContextFiles: result,
                })
                break
            }
            case 'insert':
                await handleCodeFromInsertAtCursor(message.text)
                break
            case 'copy':
                await handleCopiedCode(message.text, message.eventType === 'Button')
                break
            case 'smartApplySubmit':
                await handleSmartApply(
                    message.id,
                    message.code,
                    authProvider.instance!.status,
                    message.instruction,
                    message.fileName
                )
                break
            case 'smartApplyAccept':
                await vscode.commands.executeCommand('cody.fixup.codelens.accept', message.id)
                break
            case 'smartApplyReject':
                await vscode.commands.executeCommand('cody.fixup.codelens.undo', message.id)
                break
            case 'openURI':
                vscode.commands.executeCommand('vscode.open', message.uri)
                break
            case 'links':
                void openExternalLinks(message.value)
                break
            case 'openFileLink':
                vscode.commands.executeCommand('vscode.open', message.uri, {
                    selection: message.range,
                    preserveFocus: true,
                    background: false,
                    preview: true,
                    viewColumn: vscode.ViewColumn.Beside,
                })
                break
            case 'openFile':
                await openFile(
                    message.uri,
                    message.range ?? undefined,
                    this._webviewPanelOrView && 'viewColumn' in this._webviewPanelOrView
                        ? this._webviewPanelOrView.viewColumn
                        : undefined
                )
                break
            case 'openLocalFileWithRange':
                await openLocalFileWithRange(message.filePath, message.range ?? undefined)
                break
            case 'newFile':
                await handleCodeFromSaveToNewFile(message.text, this.editor)
                break
            case 'context/get-remote-search-repos': {
                await this.postMessage({
                    type: 'context/remote-repos',
                    repos: this.chatModel.getSelectedRepos() ?? [],
                })
                break
            }
            case 'embeddings/index':
                void this.retrievers.localEmbeddings?.index()
                break
            case 'show-page':
                await vscode.commands.executeCommand('cody.show-page', message.page)
                break
            case 'attribution-search':
                await this.handleAttributionSearch(message.snippet)
                break
            case 'restoreHistory':
                await this.restoreSession(message.chatID)
                this.setWebviewView(View.Chat)
                break
            case 'reset':
                await this.clearAndRestartSession()
                break
            case 'command':
                vscode.commands.executeCommand(message.id, message.arg)
                break
            case 'event':
                // no-op, legacy v1 telemetry has been removed. This should be removed as well.
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
            case 'auth': {
                if (message.authKind === 'callback' && message.endpoint) {
                    redirectToEndpointLogin(message.endpoint)
                    break
                }
                if (message.authKind === 'offline') {
                    authProvider.instance!.auth({ endpoint: '', token: '', isOfflineMode: true })
                    break
                }
                if (message.authKind === 'simplified-onboarding') {
                    const endpoint = DOTCOM_URL.href

                    let tokenReceiverUrl: string | undefined = undefined
                    closeAuthProgressIndicator()
                    startAuthProgressIndicator()
                    tokenReceiverUrl = await this.startTokenReceiver?.(
                        endpoint,
                        async (token, endpoint) => {
                            closeAuthProgressIndicator()
                            const authStatus = await authProvider.instance!.auth({ endpoint, token })
                            telemetryRecorder.recordEvent(
                                'cody.auth.fromTokenReceiver.web',
                                'succeeded',
                                {
                                    metadata: {
                                        success: authStatus?.authenticated ? 1 : 0,
                                    },
                                }
                            )
                            if (!authStatus?.authenticated) {
                                void vscode.window.showErrorMessage(
                                    'Authentication failed. Please check your token and try again.'
                                )
                            }
                            // TODO!(sqs): check for siteHasCodyEnabled & verified emails?
                        }
                    )

                    const authProviderSimplified = new AuthProviderSimplified()
                    const authMethod = message.authMethod || 'dotcom'
                    const successfullyOpenedUrl = await authProviderSimplified.openExternalAuthUrl(
                        authMethod,
                        tokenReceiverUrl
                    )
                    if (!successfullyOpenedUrl) {
                        closeAuthProgressIndicator()
                    }
                    break
                }
                if (message.authKind === 'signin' && message.endpoint && message.value) {
                    await authProvider.instance!.auth({
                        endpoint: message.endpoint,
                        token: message.value,
                    })
                    break
                }
                if (message.authKind === 'signout') {
                    await showSignOutMenu()
                    this.setWebviewView(View.Login)
                    break
                }
                // cody.auth.signin or cody.auth.signout
                await vscode.commands.executeCommand(`cody.auth.${message.authKind}`)
                break
            }
            case 'simplified-onboarding': {
                if (message.onboardingKind === 'web-sign-in-token') {
                    void vscode.window
                        .showInputBox({ prompt: 'Enter web sign-in token' })
                        .then(async token => {
                            if (!token) {
                                return
                            }
                            const authStatus = await authProvider.instance!.auth({
                                endpoint: DOTCOM_URL.href,
                                token,
                            })
                            if (!authStatus?.authenticated) {
                                void vscode.window.showErrorMessage(
                                    'Authentication failed. Please check your token and try again.'
                                )
                            }
                        })
                    break
                }
                break
            }
            case 'troubleshoot/reloadAuth': {
                await authProvider.instance!.reloadAuthStatus()
                const nextAuth = authProvider.instance!.status
                telemetryRecorder.recordEvent('cody.troubleshoot', 'reloadAuth', {
                    metadata: {
                        success: nextAuth.authenticated ? 1 : 0,
                    },
                })
                break
            }
        }
    }

    private isSmartApplyEnabled(): boolean {
        return this.extensionClient.capabilities?.edit !== 'none'
    }

    private async getConfigForWebview(): Promise<ConfigurationSubsetForWebview & LocalEnv> {
        const config = getConfigWithEndpoint()
        const sidebarViewOnly = this.extensionClient.capabilities?.webviewNativeConfig?.view === 'single'
        const isEditorViewType = this.webviewPanelOrView?.viewType === 'cody.editorPanel'
        const webviewType = isEditorViewType && !sidebarViewOnly ? 'editor' : 'sidebar'

        return {
            agentIDE: config.agentIDE ?? CodyIDE.VSCode,
            agentExtensionVersion: config.isRunningInsideAgent
                ? config.agentExtensionVersion
                : VSCEVersion,
            uiKindIsWeb: vscode.env.uiKind === vscode.UIKind.Web,
            serverEndpoint: config.serverEndpoint,
            experimentalNoodle: config.experimentalNoodle,
            smartApply: this.isSmartApplyEnabled(),
            webviewType,
            multipleWebviewsEnabled: !sidebarViewOnly,
            internalDebugContext: config.internalDebugContext,
        }
    }

    // =======================================================================
    // #region top-level view action handlers
    // =======================================================================

    public setAuthStatus(status: AuthStatus): void {
        // Run this async because this method may be called during initialization
        // and awaiting on this.postMessage may result in a deadlock
        void this.sendConfig()

        // Get the latest model list available to the current user to update the ChatModel.
        if (status.authenticated) {
            this.chatModel.updateModel(getDefaultModelID())
        }
    }

    // When the webview sends the 'ready' message, respond by posting the view config
    private async handleReady(): Promise<void> {
        await this.sendConfig()
    }

    private async sendConfig(): Promise<void> {
        const authStatus = authProvider.instance!.status
        const configForWebview = await this.getConfigForWebview()
        const workspaceFolderUris =
            vscode.workspace.workspaceFolders?.map(folder => folder.uri.toString()) ?? []
        const clientConfig = await ClientConfigSingleton.getInstance().getConfig()
        await this.postMessage({
            type: 'config',
            config: configForWebview,
            authStatus,
            workspaceFolderUris,
            configFeatures: {
                attribution: clientConfig?.attributionEnabled ?? false,
                serverSentModels: clientConfig?.modelsAPIEnabled ?? false,
            },
            isDotComUser: isDotCom(authStatus),
        })
        logDebug('ChatController', 'updateViewConfig', {
            verbose: configForWebview,
        })
    }

    private initDoer = new InitDoer<boolean | undefined>()
    private async handleInitialized(): Promise<void> {
        // HACK: this call is necessary to get the webview to set the chatID state,
        // which is necessary on deserialization. It should be invoked before the
        // other initializers run (otherwise, it might interfere with other view
        // state)
        await this.webviewPanelOrView?.webview.postMessage({
            type: 'transcript',
            messages: [],
            isMessageInProgress: false,
            chatID: this.chatModel.sessionID,
        })

        // Update the chat model providers to ensure the correct token limit is set
        this.chatModel.updateModel(this.chatModel.modelID)

        await this.saveSession()
        this.initDoer.signalInitialized()
        await this.sendConfig()
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
        legacyAddEnhancedContext: boolean,
        signal: AbortSignal,
        source?: EventSource,
        command?: DefaultChatCommands
    ): Promise<void> {
        return tracer.startActiveSpan('chat.submit', async (span): Promise<void> => {
            span.setAttribute('sampled', true)
            const authStatus = authProvider.instance!.status
            const sharedProperties = {
                requestID,
                chatModel: this.chatModel.modelID,
                source,
                command,
                traceId: span.spanContext().traceId,
                sessionID: this.chatModel.sessionID,
                addEnhancedContext: legacyAddEnhancedContext,
            }
            await this.recordChatQuestionTelemetryEvent(
                authStatus,
                legacyAddEnhancedContext,
                mentions,
                sharedProperties,
                inputText
            )

            tracer.startActiveSpan('chat.submit.firstToken', async (firstTokenSpan): Promise<void> => {
                if (inputText.toString().match(/^\/reset$/)) {
                    span.addEvent('clearAndRestartSession')
                    span.end()
                    return this.clearAndRestartSession()
                }

                if (submitType === 'user-newchat' && !this.chatModel.isEmpty()) {
                    span.addEvent('clearAndRestartSession')
                    await this.clearAndRestartSession()
                    signal.throwIfAborted()
                }

                this.chatModel.addHumanMessage({ text: inputText, editorState })
                await this.saveSession()
                signal.throwIfAborted()

                this.postEmptyMessageInProgress()
                this.contextAPIClient?.detectChatIntent(requestID, inputText.toString())

                // All mentions we receive are either source=initial or source=user. If the caller
                // forgot to set the source, assume it's from the user.
                mentions = mentions.map(m => (m.source ? m : { ...m, source: ContextItemSource.User }))

                // If the legacyAddEnhancedContext param is true, then pretend there is a `@repo` or `@tree`
                // mention and a mention of the current selection to match the old behavior.
                if (legacyAddEnhancedContext) {
                    const corpusMentions = await getCorpusContextItemsForEditorState(
                        this.retrievers.enterpriseContext !== null
                    )
                    mentions = mentions.concat(corpusMentions)

                    const selectionContext = source === 'chat' ? await getContextFileFromSelection() : []
                    signal.throwIfAborted()
                    mentions = mentions.concat(selectionContext)
                }

                const contextAlternatives = await this.computeContext(
                    { text: inputText, mentions },
                    requestID,
                    editorState,
                    span,
                    signal
                )
                signal.throwIfAborted()
                const corpusContext = contextAlternatives[0].items

                const explicitMentions = corpusContext.filter(c => c.source === ContextItemSource.User)
                const implicitMentions = corpusContext.filter(c => c.source !== ContextItemSource.User)

                const prompter = new DefaultPrompter(
                    explicitMentions,
                    implicitMentions,
                    command !== undefined
                )

                try {
                    const { prompt, context } = await this.buildPrompt(
                        prompter,
                        signal,
                        requestID,
                        contextAlternatives
                    )

                    void this.sendChatExecutedTelemetry(
                        span,
                        firstTokenSpan,
                        inputText,
                        sharedProperties,
                        context
                    )

                    signal.throwIfAborted()
                    this.streamAssistantResponse(requestID, prompt, span, firstTokenSpan, signal)
                } catch (error) {
                    if (isAbortErrorOrSocketHangUp(error as Error)) {
                        return
                    }
                    if (isRateLimitError(error) || isContextWindowLimitError(error)) {
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

    private async sendChatExecutedTelemetry(
        span: Span,
        firstTokenSpan: Span,
        inputText: PromptString,
        sharedProperties: any,
        context: PromptInfo['context']
    ): Promise<void> {
        const authStatus = authProvider.instance!.status

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
        const privateContextSummary = await this.buildPrivateContextSummary(context)

        const properties = {
            ...sharedProperties,
            traceId: span.spanContext().traceId,
        }
        span.setAttributes(properties)
        firstTokenSpan.setAttributes(properties)

        telemetryRecorder.recordEvent('cody.chat-question', 'executed', {
            metadata: {
                ...contextSummary,
                // Flag indicating this is a transcript event to go through ML data pipeline. Only for DotCom users
                // See https://github.com/sourcegraph/sourcegraph/pull/59524
                recordsPrivateMetadataTranscript: isDotCom(authStatus) ? 1 : 0,
            },
            privateMetadata: {
                properties,
                privateContextSummary: privateContextSummary,
                // 🚨 SECURITY: chat transcripts are to be included only for DotCom users AND for V2 telemetry
                // V2 telemetry exports privateMetadata only for DotCom users
                // the condition below is an additional safeguard measure
                promptText:
                    isDotCom(authStatus) && truncatePromptString(inputText, CHAT_INPUT_TOKEN_BUDGET),
            },
        })
    }

    private async computeContext(
        { text, mentions }: HumanInput,
        requestID: string,
        editorState: SerializedPromptEditorState | null,
        span: Span,
        signal?: AbortSignal
    ): Promise<RankedContext[]> {
        // Remove context chips (repo, @-mentions) from the input text for context retrieval.
        const inputTextWithoutContextChips = editorState
            ? PromptString.unsafe_fromUserQuery(
                  inputTextWithoutContextChipsFromPromptEditorState(editorState)
              )
            : text
        const structuredMentions = toStructuredMentions(mentions)
        const retrievedContextPromise = this.contextRetriever.retrieveContext(
            structuredMentions,
            inputTextWithoutContextChips,
            span,
            signal
        )
        const priorityContextPromise = retrievedContextPromise.then(p =>
            getPriorityContext(text, this.editor, p)
        )
        const openCtxContextPromise = getContextForChatMessage(text.toString(), signal)
        const [priorityContext, retrievedContext, openCtxContext] = await Promise.all([
            priorityContextPromise,
            retrievedContextPromise,
            openCtxContextPromise,
        ])

        const resolvedExplicitMentionsPromise = resolveContextItems(
            this.editor,
            [structuredMentions.symbols, structuredMentions.files].flat(),
            text,
            signal
        )

        const rankedContext: RankedContext[] = []
        const useReranker =
            vscode.workspace.getConfiguration().get<boolean>('cody.internal.useReranker') ?? false
        if (useReranker && this.contextAPIClient && retrievedContext.length > 1) {
            const response = await this.contextAPIClient.rankContext(
                requestID,
                inputTextWithoutContextChips.toString(),
                retrievedContext
            )
            if (isError(response)) {
                throw response
            }
            if (!response) {
                throw new Error('empty response from context reranking API')
            }
            const { used, ignored } = response
            const all: [ContextItem, number][] = []
            const usedContext: ContextItem[] = []
            const ignoredContext: ContextItem[] = []
            for (const { index, score } of used) {
                usedContext.push(retrievedContext[index])
                all.push([retrievedContext[index], score])
            }
            for (const { index, score } of ignored) {
                ignoredContext.push(retrievedContext[index])
                all.push([retrievedContext[index], score])
            }

            rankedContext.push({
                strategy: 'local+remote, reranked',
                items: combineContext(
                    await resolvedExplicitMentionsPromise,
                    openCtxContext,
                    priorityContext,
                    usedContext
                ),
            })
        }

        rankedContext.push({
            strategy: 'local+remote',
            items: combineContext(
                await resolvedExplicitMentionsPromise,
                openCtxContext,
                priorityContext,
                retrievedContext
            ),
        })
        return rankedContext
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
        // Notify the webview there is no message in progress.
        this.postViewTranscript()
        telemetryRecorder.recordEvent('cody.sidebar.abortButton', 'clicked')
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

        // Reveal the webview panel if it is hidden
        if (this._webviewPanelOrView) {
            revealWebviewViewOrPanel(this._webviewPanelOrView)
        }
    }

    public async handleSmartApplyResult(result: SmartApplyResult): Promise<void> {
        void this.postMessage({
            type: 'clientAction',
            smartApplyResult: result,
        })
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

        this.syncPanelTitle()
    }

    private syncPanelTitle() {
        // Update webview panel title if we're in an editor panel
        if (this._webviewPanelOrView && 'reveal' in this._webviewPanelOrView) {
            this._webviewPanelOrView.title = this.chatModel.getChatTitle()
        }
    }

    /**
     * Display error message in webview as part of the chat transcript, or as a system banner alongside the chat.
     */
    private postError(error: Error, type?: MessageErrorType): void {
        logDebug('ChatController: postError', error.message)
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

    /**
     * Low-level utility to post a message to the webview, pending initialization.
     *
     * cody-invariant: this.webview.postMessage should never be invoked directly
     * except within this method.
     */
    private postMessage(message: ExtensionMessage): Thenable<boolean | undefined> {
        return this.initDoer.do(() => this.webviewPanelOrView?.webview.postMessage(message))
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
        requestID: string,
        contextAlternatives?: RankedContext[]
    ): Promise<PromptInfo> {
        const { prompt, context } = await prompter.makePrompt(
            this.chatModel,
            authProvider.instance!.status.codyApiVersion
        )
        abortSignal.throwIfAborted()

        // Update UI based on prompt construction. Includes the excluded context items to display in the UI
        this.chatModel.setLastMessageContext([...context.used, ...context.ignored], contextAlternatives)

        // This is not awaited, so we kick the call off but don't block on it returning
        this.contextAPIClient?.recordContext(requestID, context.used, context.ignored)

        return { prompt, context }
    }

    private async buildPrivateContextSummary(context: {
        used: ContextItem[]
        ignored: ContextItem[]
    }): Promise<object> {
        // 🚨 SECURITY: included only for dotcom users & public repos
        if (!isDotCom(authProvider.instance!.status)) {
            return {}
        }
        if (!workspaceReposMonitor) {
            return {}
        }

        const { isPublic, repoMetadata: gitMetadata } =
            await workspaceReposMonitor.getRepoMetadataIfPublic()
        if (!isPublic) {
            return {}
        }

        const getContextSummary = async (items: ContextItem[]) => ({
            count: items.length,
            items: await Promise.all(
                items.map(async i => ({
                    source: i.source,
                    size: i.size || (await TokenCounterUtils.countTokens(i.content || '')),
                    content: i.content,
                }))
            ),
        })

        return {
            included: await getContextSummary(context.used),
            excluded: await getContextSummary(context.ignored),
            gitMetadata,
        }
    }

    private streamAssistantResponse(
        requestID: string,
        prompt: Message[],
        span: Span,
        firstTokenSpan: Span,
        abortSignal: AbortSignal
    ): void {
        logDebug('ChatController', 'streamAssistantResponse', {
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
                    measureFirstToken()
                    span.addEvent('update')
                    this.postViewTranscript({
                        speaker: 'assistant',
                        text: PromptString.unsafe_fromLLMResponse(content),
                        model: this.chatModel.modelID,
                    })
                },
                close: content => {
                    measureFirstToken()
                    recordExposedExperimentsToSpan(span)
                    span.end()
                    this.addBotMessage(requestID, PromptString.unsafe_fromLLMResponse(content))
                },
                error: (partialResponse, error) => {
                    this.postError(error, 'transcript')
                    if (isAbortErrorOrSocketHangUp(error)) {
                        abortSignal.throwIfAborted()
                    }
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

        const authStatus = authProvider.instance!.status

        // Count code generated from response
        const generatedCode = countGeneratedCode(messageText.toString())
        const responseEventAction = generatedCode.charCount > 0 ? 'hasCode' : 'noCode'
        telemetryRecorder.recordEvent('cody.chatResponse', responseEventAction, {
            version: 2, // increment for major changes to this event
            interactionID: requestID,
            metadata: {
                ...generatedCode,
                // Flag indicating this is a transcript event to go through ML data pipeline. Only for dotcom users
                // See https://github.com/sourcegraph/sourcegraph/pull/59524
                recordsPrivateMetadataTranscript: isDotCom(authStatus) ? 1 : 0,
            },
            privateMetadata: {
                // 🚨 SECURITY: chat transcripts are to be included only for DotCom users AND for V2 telemetry
                // V2 telemetry exports privateMetadata only for DotCom users
                // the condition below is an aditional safegaurd measure
                responseText:
                    isDotCom(authStatus) && truncatePromptString(messageText, CHAT_OUTPUT_TOKEN_BUDGET),
                chatModel: this.chatModel.modelID,
            },
        })
    }

    // #endregion
    // =======================================================================
    // #region session management
    // =======================================================================

    // A unique identifier for this ChatController instance used to identify
    // it when a handle to this specific panel provider is needed.
    public get sessionID(): string {
        return this.chatModel.sessionID
    }

    // Attempts to restore the chat to the given sessionID, if it exists in
    // history. If it does, then saves the current session and cancels the
    // current in-progress completion. If the chat does not exist, then this
    // is a no-op.
    public async restoreSession(sessionID: string): Promise<void> {
        const oldTranscript = chatHistory.getChat(authProvider.instance!.status, sessionID)
        if (!oldTranscript) {
            return
        }
        this.cancelSubmitOrEditOperation()
        const newModel = newChatModelFromSerializedChatTranscript(oldTranscript, this.chatModel.modelID)
        this.chatModel = newModel

        this.postViewTranscript()
    }

    private async saveSession(): Promise<void> {
        const allHistory = await chatHistory.saveChat(
            authProvider.instance!.status,
            this.chatModel.toSerializedChatTranscript()
        )
        if (allHistory) {
            void this.postMessage({
                type: 'history',
                localHistory: allHistory,
            })
        }
    }

    public async clearAndRestartSession(): Promise<void> {
        this.cancelSubmitOrEditOperation()
        await this.saveSession()

        this.chatModel = new ChatModel(this.chatModel.modelID)
        this.postViewTranscript()
    }

    // #endregion
    // =======================================================================
    // #region webview container management
    // =======================================================================

    private extensionUri: vscode.Uri
    private _webviewPanelOrView?: vscode.WebviewView | vscode.WebviewPanel
    public get webviewPanelOrView(): vscode.WebviewView | vscode.WebviewPanel | undefined {
        return this._webviewPanelOrView
    }

    /**
     * Creates the webview view or panel for the Cody chat interface if it doesn't already exist.
     */
    public async createWebviewViewOrPanel(
        activePanelViewColumn?: vscode.ViewColumn,
        lastQuestion?: string
    ): Promise<vscode.WebviewView | vscode.WebviewPanel> {
        // Checks if the webview view or panel already exists and is visible.
        // If so, returns early to avoid creating a duplicate.
        if (this.webviewPanelOrView) {
            return this.webviewPanelOrView
        }

        const viewType = CodyChatEditorViewType
        const panelTitle =
            chatHistory.getChat(authProvider.instance!.status, this.chatModel.sessionID)?.chatTitle ||
            getChatPanelTitle(lastQuestion)
        const viewColumn = activePanelViewColumn || vscode.ViewColumn.Beside
        const webviewPath = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webviews')
        const panel = vscode.window.createWebviewPanel(
            viewType,
            panelTitle,
            { viewColumn, preserveFocus: true },
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                enableFindWidget: true,
                localResourceRoots: [webviewPath],
                enableCommandUris: true,
            }
        )

        return this.registerWebviewPanel(panel)
    }

    /**
     * Revives the chat panel when the extension is reactivated.
     */
    public async revive(webviewPanel: vscode.WebviewPanel): Promise<void> {
        logDebug('ChatController:revive', 'registering webview panel')
        await this.registerWebviewPanel(webviewPanel)
    }

    public async resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext<unknown>,
        _token: vscode.CancellationToken
    ): Promise<void> {
        await this.resolveWebviewViewOrPanel(webviewView)
    }

    /**
     * Registers the given webview panel by setting up its options, icon, and handlers.
     * Also stores the panel reference and disposes it when closed.
     */
    private async registerWebviewPanel(panel: vscode.WebviewPanel): Promise<vscode.WebviewPanel> {
        panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'resources', 'active-chat-icon.svg')
        return this.resolveWebviewViewOrPanel(panel)
    }

    private async resolveWebviewViewOrPanel(viewOrPanel: vscode.WebviewView): Promise<vscode.WebviewView>
    private async resolveWebviewViewOrPanel(
        viewOrPanel: vscode.WebviewPanel
    ): Promise<vscode.WebviewPanel>
    private async resolveWebviewViewOrPanel(
        viewOrPanel: vscode.WebviewView | vscode.WebviewPanel
    ): Promise<vscode.WebviewView | vscode.WebviewPanel> {
        this._webviewPanelOrView = viewOrPanel
        this.syncPanelTitle()

        const webviewPath = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webviews')
        viewOrPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [webviewPath],
            enableCommandUris: true,
        }

        await addWebviewViewHTML(this.extensionClient, this.extensionUri, viewOrPanel)

        // Dispose panel when the panel is closed
        viewOrPanel.onDidDispose(() => {
            this.cancelSubmitOrEditOperation()
            this._webviewPanelOrView = undefined
            if ('dispose' in viewOrPanel) {
                viewOrPanel.dispose()
            }
        })

        this.disposables.push(
            viewOrPanel.webview.onDidReceiveMessage(message =>
                this.onDidReceiveMessage(
                    hydrateAfterPostMessage(message, uri => vscode.Uri.from(uri as any))
                )
            )
        )

        // Listen for API calls from the webview.
        this.disposables.push(
            addMessageListenersForExtensionAPI(
                createMessageAPIForExtension({
                    postMessage: this.postMessage.bind(this),
                    postError: this.postError.bind(this),
                    onMessage: callback => {
                        const disposable = viewOrPanel.webview.onDidReceiveMessage(callback)
                        return () => disposable.dispose()
                    },
                }),
                {
                    mentionMenuData: query => getMentionMenuData(query, this.chatModel),
                    evaluatedFeatureFlag: flag =>
                        featureFlagProvider.instance!.evaluatedFeatureFlag(flag),
                    prompts: query =>
                        promiseFactoryToObservable(signal =>
                            mergedPromptsAndLegacyCommands(query, signal)
                        ),
                    models: () =>
                        combineLatest([
                            this.configWatcher.changes,
                            modelsService.instance!.selectedOrDefaultModelChanges.pipe(
                                startWith(undefined)
                            ),
                        ]).pipe(map(() => modelsService.instance!.getModels(ModelUsage.Chat))),
                    setChatModel: model => {
                        this.chatModel.updateModel(model)

                        // Because this was a user action to change the model we will set that
                        // as a global default for chat
                        return promiseToObservable(
                            modelsService.instance!.setSelectedModel(ModelUsage.Chat, model)
                        )
                    },
                }
            )
        )

        return viewOrPanel
    }

    private async setWebviewView(view: View): Promise<void> {
        if (view !== 'chat') {
            // Only chat view is supported in the webview panel.
            // When a different view is requested,
            // Set context to notify the webview panel to close.
            // This should close the webview panel and open the login view in the sidebar.
            await vscode.commands.executeCommand('setContext', 'cody.activated', false)
            return
        }
        const viewOrPanel = this._webviewPanelOrView ?? (await this.createWebviewViewOrPanel())

        this._webviewPanelOrView = viewOrPanel

        revealWebviewViewOrPanel(viewOrPanel)

        await this.postMessage({
            type: 'view',
            view: view,
        })
    }

    // #endregion
    // =======================================================================
    // #region other public accessors and mutators
    // =======================================================================

    // Convenience function for tests
    public getViewTranscript(): readonly ChatMessage[] {
        return this.chatModel.getMessages().map(prepareChatMessage)
    }

    public isEmpty(): boolean {
        return this.chatModel.isEmpty()
    }

    public isVisible(): boolean {
        return this.webviewPanelOrView?.visible ?? false
    }

    private async recordChatQuestionTelemetryEvent(
        authStatus: AuthStatus,
        legacyAddEnhancedContext: boolean,
        mentions: ContextItem[],
        sharedProperties: any,
        inputText: PromptString
    ): Promise<void> {
        const mentionsInInitialContext = mentions.filter(item => item.source !== ContextItemSource.User)
        const mentionsByUser = mentions.filter(item => item.source === ContextItemSource.User)

        let gitMetadata = ''
        if (workspaceReposMonitor) {
            const { isPublic: isWorkspacePublic, repoMetadata } =
                await workspaceReposMonitor.getRepoMetadataIfPublic()
            if (isDotCom(authStatus) && legacyAddEnhancedContext && isWorkspacePublic) {
                gitMetadata = JSON.stringify(repoMetadata)
            }
        }
        telemetryRecorder.recordEvent('cody.chat-question', 'submitted', {
            metadata: {
                // Flag indicating this is a transcript event to go through ML data pipeline. Only for DotCom users
                // See https://github.com/sourcegraph/sourcegraph/pull/59524
                recordsPrivateMetadataTranscript: authStatus.endpoint && isDotCom(authStatus) ? 1 : 0,
                addEnhancedContext: legacyAddEnhancedContext ? 1 : 0,

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
                    isDotCom(authStatus) && truncatePromptString(inputText, CHAT_INPUT_TOKEN_BUDGET),
                gitMetadata,
            },
        })
    }
}

function newChatModelFromSerializedChatTranscript(
    json: SerializedChatTranscript,
    modelID: string
): ChatModel {
    return new ChatModel(
        migrateAndNotifyForOutdatedModels(modelID)!,
        json.id,
        json.interactions.flatMap((interaction: SerializedChatInteraction): ChatMessage[] =>
            [
                PromptString.unsafe_deserializeChatMessage(interaction.humanMessage),
                interaction.assistantMessage
                    ? PromptString.unsafe_deserializeChatMessage(interaction.assistantMessage)
                    : null,
            ].filter(isDefined)
        ),
        json.chatTitle,
        json.enhancedContext?.selectedRepos
    )
}

export function disposeWebviewViewOrPanel(viewOrPanel: vscode.WebviewView | vscode.WebviewPanel): void {
    if ('dispose' in viewOrPanel) {
        viewOrPanel.dispose()
    }
}

export function webviewViewOrPanelViewColumn(
    viewOrPanel: vscode.WebviewView | vscode.WebviewPanel
): vscode.ViewColumn | undefined {
    if ('viewColumn' in viewOrPanel) {
        return viewOrPanel.viewColumn
    }
    // Our view is in the sidebar, return undefined
    return undefined
}

export function webviewViewOrPanelOnDidChangeViewState(
    viewOrPanel: vscode.WebviewView | vscode.WebviewPanel
): vscode.Event<vscode.WebviewPanelOnDidChangeViewStateEvent> {
    if ('onDidChangeViewState' in viewOrPanel) {
        return viewOrPanel.onDidChangeViewState
    }
    // Return a no-op (this means the provider is for the sidebar)
    return () => {
        return {
            dispose: () => {},
        }
    }
}

export function revealWebviewViewOrPanel(viewOrPanel: vscode.WebviewView | vscode.WebviewPanel): void {
    if ('reveal' in viewOrPanel) {
        viewOrPanel.reveal()
    }
}

function getDefaultModelID(): string {
    const pending = ''
    try {
        return modelsService.instance!.getDefaultChatModel() || pending
    } catch {
        return pending
    }
}

/**
 * Set HTML for webview (panel) & webview view (sidebar)
 */
async function addWebviewViewHTML(
    extensionClient: ExtensionClient,
    extensionUri: vscode.Uri,
    view: vscode.WebviewView | vscode.WebviewPanel
): Promise<void> {
    if (extensionClient.capabilities?.webview === 'agentic') {
        return
    }
    const config = extensionClient.capabilities?.webviewNativeConfig
    const webviewPath = config?.rootDir
        ? vscode.Uri.parse(config?.rootDir, true)
        : vscode.Uri.joinPath(extensionUri, 'dist', 'webviews')
    // Create Webview using vscode/index.html
    const root = vscode.Uri.joinPath(webviewPath, 'index.html')
    const bytes = await vscode.workspace.fs.readFile(root)
    const decoded = new TextDecoder('utf-8').decode(bytes)
    const resources = view.webview.asWebviewUri(webviewPath)

    // This replace variables from the vscode/dist/index.html with webview info
    // 1. Update URIs to load styles and scripts into webview (eg. path that starts with ./)
    // 2. Update URIs for content security policy to only allow specific scripts to be run
    view.webview.html = decoded
        .replaceAll('./', `${resources.toString()}/`)
        .replaceAll("'self'", view.webview.cspSource)
        .replaceAll('{cspSource}', view.webview.cspSource)

    // If a script or style is injected, replace the placeholder with the script or style
    // and drop the content-security-policy meta tag which prevents inline scripts and styles
    if (config?.injectScript || config?.injectStyle) {
        // drop all text betweeb <-- START CSP --> and <-- END CSP -->
        view.webview.html = decoded
            .replace(/<-- START CSP -->.*<!-- END CSP -->/s, '')
            .replaceAll('/*injectedScript*/', config?.injectScript ?? '')
            .replaceAll('/*injectedStyle*/', config?.injectStyle ?? '')
    }
}

// This is the manual ordering of the different retrieved and explicit context sources
// It should be equivalent to the ordering of things in
// ChatController:legacyComputeContext > context.ts:resolveContext
function combineContext(
    explicitMentions: ContextItem[],
    openCtxContext: ContextItemOpenCtx[],
    priorityContext: ContextItem[],
    retrievedContext: ContextItem[]
): ContextItem[] {
    return [explicitMentions, openCtxContext, priorityContext, retrievedContext].flat()
}
