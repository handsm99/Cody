import path from 'path'

import * as vscode from 'vscode'

import { ChatContextStatus } from '@sourcegraph/cody-shared'
import { ChatClient } from '@sourcegraph/cody-shared/src/chat/chat'
import { ChatMessage, UserLocalHistory } from '@sourcegraph/cody-shared/src/chat/transcript/messages'
import { CodebaseContext } from '@sourcegraph/cody-shared/src/codebase-context'
import { Guardrails } from '@sourcegraph/cody-shared/src/guardrails'
import { IntentDetector } from '@sourcegraph/cody-shared/src/intent-detector'

import { View } from '../../webviews/NavBar'
import { VSCodeEditor } from '../editor/vscode-editor'
import { logEvent } from '../event-logger'
import { debug } from '../log'
import { AuthProvider } from '../services/AuthProvider'
import { LocalStorage } from '../services/LocalStorageProvider'
import { SecretStorage } from '../services/SecretStorageProvider'

import { Config, MessageProvider } from './MessageProvider2'
import {
    AuthStatus,
    ConfigurationSubsetForWebview,
    DOTCOM_URL,
    ExtensionMessage,
    LocalEnv,
    WebviewMessage,
} from './protocol'

export class ChatViewProvider extends MessageProvider implements vscode.WebviewViewProvider {
    public webview?: Omit<vscode.Webview, 'postMessage'> & {
        postMessage(message: ExtensionMessage): Thenable<boolean>
    }

    constructor(
        protected extensionPath: string,
        protected config: Omit<Config, 'codebase'>, // should use codebaseContext.getCodebase() rather than config.codebase
        protected chat: ChatClient,
        protected intentDetector: IntentDetector,
        protected codebaseContext: CodebaseContext,
        protected guardrails: Guardrails,
        protected editor: VSCodeEditor,
        protected secretStorage: SecretStorage,
        protected localStorage: LocalStorage,
        protected rgPath: string,
        protected authProvider: AuthProvider
    ) {
        super(
            config,
            chat,
            intentDetector,
            codebaseContext,
            guardrails,
            editor,
            secretStorage,
            localStorage,
            rgPath,
            authProvider,
            true
        )
    }

    private async onDidReceiveMessage(message: WebviewMessage): Promise<void> {
        switch (message.command) {
            case 'ready':
                // The web view is ready to receive events. We need to make sure that it has an up
                // to date config, even if it was already published
                await this.authProvider.announceNewAuthStatus()
                break
            case 'initialized':
                debug('ChatViewProvider:onDidReceiveMessage:initialized', '')
                await this.init()
                break
            case 'submit':
                await this.onHumanMessageSubmitted(message.text, message.submitType)
                break
            case 'edit':
                this.transcript.removeLastInteraction()
                await this.onHumanMessageSubmitted(message.text, 'user')
                break
            case 'abort':
                this.cancelCompletion()
                await this.multiplexer.notifyTurnComplete()
                this.onCompletionEnd()
                break
            case 'executeRecipe':
                await this.executeRecipe(message.recipe)
                break
            case 'auth':
                if (message.type === 'app' && message.endpoint) {
                    await this.authProvider.appAuth(message.endpoint)
                    break
                }
                if (message.type === 'callback' && message.endpoint) {
                    await this.authProvider.redirectToEndpointLogin(message.endpoint)
                    break
                }
                // cody.auth.signin or cody.auth.signout
                await vscode.commands.executeCommand(`cody.auth.${message.type}`)
                break
            case 'settings':
                await this.authProvider.auth(message.serverEndpoint, message.accessToken, this.config.customHeaders)
                break
            case 'insert':
                await vscode.commands.executeCommand('cody.inline.insert', message.text)
                break
            case 'event':
                this.sendEvent(message.event, message.value)
                break
            case 'removeHistory':
                await this.clearHistory()
                break
            case 'restoreHistory':
                await this.restoreSession(message.chatID)
                break
            case 'deleteHistory':
                await this.deleteHistory(message.chatID)
                break
            case 'links':
                void this.openExternalLinks(message.value)
                break
            case 'openFile': {
                const rootPath = this.editor.getWorkspaceRootPath()
                if (!rootPath) {
                    this.sendError2('Failed to open file: missing rootPath')
                    return
                }
                try {
                    // This opens the file in the active column.
                    const uri = vscode.Uri.file(path.join(rootPath, message.filePath))
                    const doc = await vscode.workspace.openTextDocument(uri)
                    await vscode.window.showTextDocument(doc)
                } catch {
                    // Try to open the file in the sourcegraph view
                    const sourcegraphSearchURL = new URL(
                        `/search?q=context:global+file:${message.filePath}`,
                        this.config.serverEndpoint
                    ).href
                    void this.openExternalLinks(sourcegraphSearchURL)
                }
                break
            }
            case 'chat-button': {
                switch (message.action) {
                    case 'explain-code-high-level':
                    case 'find-code-smells':
                    case 'generate-unit-test':
                        void this.executeRecipe(message.action)
                        break
                    default:
                        break
                }
                break
            }
            default:
                this.sendError2('Invalid request type from Webview')
        }
    }

    private async onHumanMessageSubmitted(text: string, submitType: 'user' | 'suggestion'): Promise<void> {
        debug('ChatViewProvider:onHumanMessageSubmitted', '', { verbose: { text, submitType } })
        if (submitType === 'suggestion') {
            logEvent('CodyVSCodeExtension:chatPredictions:used')
        }
        this.inputHistory.push(text)
        if (this.config.experimentalChatPredictions) {
            void this.runRecipeForSuggestion('next-questions', text)
        }
        await this.executeChatCommands(text)
    }

    private async executeChatCommands(text: string): Promise<void> {
        switch (true) {
            case /^\/r(est)?\s/i.test(text):
                await this.clearAndRestartSession()
                break
            case /^\/s(earch)?\s/i.test(text):
                await this.executeRecipe('context-search', text)
                break
            default:
                return this.executeRecipe('chat-question', text)
        }
    }

    public showTab(tab: string): void {
        void vscode.commands.executeCommand('cody.chat.focus')
        void this.webview?.postMessage({ type: 'showTab', tab })
    }

    /**
     * Send transcript to webview
     */
    protected sendTranscript2(transcript: ChatMessage[], isMessageInProgress: boolean): void {
        void this.webview?.postMessage({
            type: 'transcript',
            messages: transcript,
            isMessageInProgress,
        })
    }

    protected sendSuggestions2(suggestions: string[]): void {
        void this.webview?.postMessage({
            type: 'suggestions',
            suggestions,
        })
    }

    /**
     * Sends chat history to webview
     */
    protected sendHistory2(history: UserLocalHistory): void {
        void this.webview?.postMessage({
            type: 'history',
            messages: history,
        })
    }

    protected async sendContextStatus2(contextStatus: ChatContextStatus): Promise<void> {
        await this.webview?.postMessage({
            type: 'contextStatus',
            contextStatus,
        })
    }

    protected async sendConfig2(
        config: ConfigurationSubsetForWebview & LocalEnv,
        authStatus: AuthStatus
    ): Promise<void> {
        await this.webview?.postMessage({ type: 'config', config, authStatus })
    }

    /**
     * Display error message in webview view as banner in chat view
     * It does not display error message as assistant response
     */
    public sendError2(errorMsg: string): void {
        void this.webview?.postMessage({ type: 'errors', errors: errorMsg })
    }

    /**
     * Log Events - naming convention: source:feature:action
     */
    public sendEvent(event: string, value: string): void {
        const endpoint = this.config.serverEndpoint || DOTCOM_URL.href
        const endpointUri = { serverEndpoint: endpoint }
        switch (event) {
            case 'feedback':
                logEvent(`CodyVSCodeExtension:codyFeedback:${value}`, null, this.codyFeedbackPayload())
                break
            case 'token':
                logEvent(`CodyVSCodeExtension:cody${value}AccessToken:clicked`, endpointUri, endpointUri)
                break
            case 'auth':
                logEvent(`CodyVSCodeExtension:Auth:${value}`, endpointUri, endpointUri)
                break
            // aditya combine this with above statemenet for auth or click
            case 'click':
                logEvent(`CodyVSCodeExtension:${value}:clicked`, endpointUri, endpointUri)
                break
        }
    }

    private codyFeedbackPayload(): any {
        const endpoint = this.config.serverEndpoint || DOTCOM_URL.href
        const isPrivateInstance = new URL(endpoint).href !== DOTCOM_URL.href

        // The user should only be able to submit feedback on transcripts, but just in case we guard against this happening.
        const privateChatTranscript = this.transcript.toChat()
        if (privateChatTranscript.length === 0) {
            return null
        }

        const lastContextFiles = privateChatTranscript.at(-1)?.contextFiles
        const lastChatUsedEmbeddings = lastContextFiles?.some(file => file.source === 'embeddings')

        // We only include full chat transcript for dot com users with connected codebase
        const chatTranscript = !isPrivateInstance && this.codebaseContext.getCodebase() ? privateChatTranscript : null

        return {
            chatTranscript,
            lastChatUsedEmbeddings,
        }
    }

    /**
     * Set webview view
     */
    public setWebviewView(view: View): void {
        void vscode.commands.executeCommand('cody.chat.focus')
        void this.webview?.postMessage({
            type: 'view',
            messages: view,
        })
    }

    /**
     * create webview resources
     */
    public async resolveWebviewView(
        webviewView: vscode.WebviewView,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _context: vscode.WebviewViewResolveContext<unknown>,
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        _token: vscode.CancellationToken
    ): Promise<void> {
        this.webview = webviewView.webview
        this.authProvider.webview = webviewView.webview

        const extensionPath = vscode.Uri.file(this.extensionPath)
        const webviewPath = vscode.Uri.joinPath(extensionPath, 'dist')

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [webviewPath],
            enableCommandUris: true,
        }

        // Create Webview using vscode/index.html
        const root = vscode.Uri.joinPath(webviewPath, 'index.html')
        const bytes = await vscode.workspace.fs.readFile(root)
        const decoded = new TextDecoder('utf-8').decode(bytes)
        const resources = webviewView.webview.asWebviewUri(webviewPath)

        // Set HTML for webview
        // This replace variables from the vscode/dist/index.html with webview info
        // 1. Update URIs to load styles and scripts into webview (eg. path that starts with ./)
        // 2. Update URIs for content security policy to only allow specific scripts to be run
        webviewView.webview.html = decoded
            .replaceAll('./', `${resources.toString()}/`)
            .replaceAll('{cspSource}', webviewView.webview.cspSource)

        // Register webview
        this.disposables.push(webviewView.webview.onDidReceiveMessage(message => this.onDidReceiveMessage(message)))
    }

    /**
     * Open external links
     */
    private async openExternalLinks(uri: string): Promise<void> {
        try {
            await vscode.env.openExternal(vscode.Uri.parse(uri))
        } catch (error) {
            throw new Error(`Failed to open file: ${error}`)
        }
    }
}
