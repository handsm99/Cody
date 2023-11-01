import * as vscode from 'vscode'

import { BotResponseMultiplexer } from '@sourcegraph/cody-shared/src/chat/bot-response-multiplexer'
import { ChatClient } from '@sourcegraph/cody-shared/src/chat/chat'
import { getPreamble } from '@sourcegraph/cody-shared/src/chat/preamble'
import { CodyPrompt, CustomCommandType } from '@sourcegraph/cody-shared/src/chat/prompts'
import { newInteraction } from '@sourcegraph/cody-shared/src/chat/prompts/utils'
import { Recipe, RecipeID } from '@sourcegraph/cody-shared/src/chat/recipes/recipe'
import { Transcript } from '@sourcegraph/cody-shared/src/chat/transcript'
import { Interaction } from '@sourcegraph/cody-shared/src/chat/transcript/interaction'
import {
    ChatEventSource,
    ChatHistory,
    ChatMessage,
    UserLocalHistory,
} from '@sourcegraph/cody-shared/src/chat/transcript/messages'
import { Typewriter } from '@sourcegraph/cody-shared/src/chat/typewriter'
import { reformatBotMessage } from '@sourcegraph/cody-shared/src/chat/viewHelpers'
import { annotateAttribution, Guardrails } from '@sourcegraph/cody-shared/src/guardrails'
import { IntentDetector } from '@sourcegraph/cody-shared/src/intent-detector'
import { ANSWER_TOKENS, DEFAULT_MAX_TOKENS } from '@sourcegraph/cody-shared/src/prompt/constants'
import { Message } from '@sourcegraph/cody-shared/src/sourcegraph-api'

import { showAskQuestionQuickPick } from '../custom-prompts/utils/menu'
import { VSCodeEditor } from '../editor/vscode-editor'
import { PlatformContext } from '../extension.common'
import { logDebug, logError } from '../log'
import { FixupTask } from '../non-stop/FixupTask'
import { AuthProvider, isNetworkError } from '../services/AuthProvider'
import { localStorage } from '../services/LocalStorageProvider'
import { telemetryService } from '../services/telemetry'
import { telemetryRecorder } from '../services/telemetry-v2'
import { TestSupport } from '../test-support'

import { ContextProvider } from './ContextProvider'
import { countGeneratedCode } from './utils'

/**
 * The problem with a token limit for the prompt is that we can only
 * estimate tokens (and do so in a very cheap way), so it can be that
 * we undercount tokens. If we exceed the maximum tokens, things will
 * start to break, so we should have some safety cushion for when we're wrong in estimating.
 *
 * Ie.: Long text, 10000 characters, we estimate it to be 2500 tokens.
 * That would fit into a limit of 3000 tokens easily. Now, it's actually
 * 3500 tokens, because it splits weird and our estimation is off, it will
 * fail. That's where we want to add this safety cushion in.
 */
const SAFETY_PROMPT_TOKENS = 100

/**
 * Multiplexer topics that should not be displayed in chat view
 */
const nonDisplayTopics = new Set(['fixup'])

/**
 * The types of errors that should be handled from MessageProvider.
 * `transcript`: Errors that can be displayed directly within a chat transcript, if available.
 * `system`: Errors that should be handled differently, e.g. alerted to the user.
 */
export type MessageErrorType = 'transcript' | 'system'

/**
 * A derived class of MessageProvider must implement these handler methods.
 * This contract ensures that MessageProvider is focused solely on building, sending and receiving messages.
 * It does not assume anything about how those messages will be displayed to the user.
 */
abstract class MessageHandler {
    protected abstract handleTranscript(transcript: ChatMessage[], messageInProgress: boolean): void
    protected abstract handleHistory(history: UserLocalHistory): void
    protected abstract handleSuggestions(suggestions: string[]): void
    protected abstract handleCodyCommands(prompts: [string, CodyPrompt][]): void
    protected abstract handleError(errorMsg: string, type: MessageErrorType): void
}

export interface MessageProviderOptions {
    chat: ChatClient
    intentDetector: IntentDetector
    guardrails: Guardrails
    editor: VSCodeEditor
    authProvider: AuthProvider
    contextProvider: ContextProvider
    platform: Pick<PlatformContext, 'recipes'>
}

export abstract class MessageProvider extends MessageHandler implements vscode.Disposable {
    public currentChatID = ''

    // input and chat history are shared across all MessageProvider instances
    protected static inputHistory: string[] = []
    protected static chatHistory: ChatHistory = {}

    private isMessageInProgress = false
    private cancelCompletionCallback: (() => void) | null = null

    // Allows recipes to hook up subscribers to process sub-streams of bot output
    private multiplexer: BotResponseMultiplexer = new BotResponseMultiplexer()

    protected transcript: Transcript = new Transcript()
    protected disposables: vscode.Disposable[] = []

    protected chat: ChatClient
    protected intentDetector: IntentDetector
    protected guardrails: Guardrails
    protected readonly editor: VSCodeEditor
    protected authProvider: AuthProvider
    protected contextProvider: ContextProvider
    protected platform: Pick<PlatformContext, 'recipes'>

    constructor(options: MessageProviderOptions) {
        super()

        if (TestSupport.instance) {
            TestSupport.instance.messageProvider.set(this)
        }

        this.chat = options.chat
        this.intentDetector = options.intentDetector
        this.guardrails = options.guardrails
        this.editor = options.editor
        this.authProvider = options.authProvider
        this.contextProvider = options.contextProvider
        this.platform = options.platform

        // chat id is used to identify chat session
        this.createNewChatID()

        // Listen to configuration changes to possibly enable Custom Commands
        this.contextProvider.configurationChangeEvent.event(() => this.sendCodyCommands())
    }

    protected async init(chatID?: string): Promise<void> {
        this.loadChatHistory()
        this.sendTranscript()
        this.sendHistory()
        await this.contextProvider.init()
        await this.sendCodyCommands()

        if (chatID) {
            await this.restoreSession(chatID)
        }
    }

    public async clearAndRestartSession(): Promise<void> {
        await this.saveTranscriptToChatHistory()
        this.createNewChatID()
        this.cancelCompletion()
        this.isMessageInProgress = false
        this.transcript.reset()
        this.handleSuggestions([])
        this.sendTranscript()
        this.sendHistory()
        telemetryService.log('CodyVSCodeExtension:chatReset:executed', undefined, { hasV2Event: true })
        telemetryRecorder.recordEvent('cody.messageProvider.chatReset', 'executed')
    }

    public async clearHistory(): Promise<void> {
        MessageProvider.chatHistory = {}
        MessageProvider.inputHistory = []
        await localStorage.removeChatHistory()
        // Reset the current transcript
        this.transcript = new Transcript()
        await this.clearAndRestartSession()
        this.sendHistory()
        telemetryService.log('CodyVSCodeExtension:clearChatHistoryButton:clicked', undefined, { hasV2Event: true })
        telemetryRecorder.recordEvent('cody.messageProvider.clearChatHistoryButton', 'clicked')
    }

    /**
     * Restores a session from a chatID
     */
    public async restoreSession(chatID: string): Promise<void> {
        await this.saveTranscriptToChatHistory()
        this.cancelCompletion()
        this.currentChatID = chatID
        this.transcript = Transcript.fromJSON(MessageProvider.chatHistory[chatID])
        await this.transcript.toJSON()
        this.sendTranscript()
        this.sendHistory()
        telemetryService.log('CodyVSCodeExtension:restoreChatHistoryButton:clicked', undefined, { hasV2Event: true })
        telemetryRecorder.recordEvent('cody.messageProvider.restoreChatHistoryButton', 'clicked')
    }

    private createNewChatID(): void {
        this.currentChatID = new Date(Date.now()).toUTCString()
    }

    private sendPrompt(
        promptMessages: Message[],
        responsePrefix = '',
        multiplexerTopic = BotResponseMultiplexer.DEFAULT_TOPIC,
        recipeId: RecipeID
    ): void {
        this.cancelCompletion()
        void vscode.commands.executeCommand('setContext', 'cody.reply.pending', true)

        const typewriter = new Typewriter({
            update: content => {
                const displayText = reformatBotMessage(content, responsePrefix)
                this.transcript.addAssistantResponse(content, displayText)
                this.sendTranscript()
            },
            close: () => {},
        })

        let text = ''

        this.multiplexer.sub(multiplexerTopic, {
            onResponse: (content: string) => {
                text += content
                typewriter.update(text)
                return Promise.resolve()
            },
            onTurnComplete: async () => {
                typewriter.close()
                await typewriter.finished
                const lastInteraction = this.transcript.getLastInteraction()
                if (lastInteraction) {
                    // remove display text from last interaction if this is a non-display topic
                    // TODO(keegancsmith) guardrails may be slow, we need to make this async update the interaction.
                    const displayText = nonDisplayTopics.has(multiplexerTopic)
                        ? undefined
                        : await this.guardrailsAnnotateAttributions(reformatBotMessage(text, responsePrefix))
                    this.transcript.addAssistantResponse(text, displayText)
                }
                await this.onCompletionEnd()
                // Count code generated from response
                const codeCount = countGeneratedCode(text)
                if (codeCount?.charCount) {
                    const source = lastInteraction?.getHumanMessage().source || recipeId
                    telemetryService.log(
                        'CodyVSCodeExtension:chatResponse:hasCode',
                        { ...codeCount, source },
                        { hasV2Event: true }
                    )
                    telemetryRecorder.recordEvent(`cody.messageProvider.chatResponse.${source}`, 'hasCode', {
                        metadata: {
                            ...codeCount,
                        },
                    })
                }
            },
        })

        let textConsumed = 0

        this.cancelCompletionCallback = this.chat.chat(promptMessages, {
            onChange: text => {
                // TODO(dpc): The multiplexer can handle incremental text. Change chat to provide incremental text.
                text = text.slice(textConsumed)
                textConsumed += text.length
                void this.multiplexer.publish(text)
            },
            onComplete: () => {
                void this.multiplexer.notifyTurnComplete()
            },
            onError: (err, statusCode) => {
                // TODO notify the multiplexer of the error
                logError('ChatViewProvider:onError', err)

                if (isAbortError(err)) {
                    this.isMessageInProgress = false
                    this.sendTranscript()
                    return
                }

                // Log users out on unauth error
                if (statusCode && statusCode >= 400 && statusCode <= 410) {
                    this.authProvider
                        .auth(
                            this.contextProvider.config.serverEndpoint,
                            this.contextProvider.config.accessToken,
                            this.contextProvider.config.customHeaders
                        )
                        .catch(error => console.error(error))
                    logError('ChatViewProvider:onError:unauthUser', err, { verbose: { statusCode } })
                }

                if (isNetworkError(err)) {
                    err = 'Cody could not respond due to network error.'
                }
                // Display error message as assistant response
                this.handleError(err, 'transcript')
                // We ignore embeddings errors in this instance because we're already showing an
                // error message and don't want to overwhelm the user.
                void this.onCompletionEnd(true)
                console.error(`Completion request failed: ${err}`)
            },
        })
    }

    protected cancelCompletion(): void {
        this.cancelCompletionCallback?.()
        this.cancelCompletionCallback = null
    }

    protected async onCompletionEnd(ignoreEmbeddingsError: boolean = false): Promise<void> {
        this.isMessageInProgress = false
        this.cancelCompletionCallback = null
        this.sendTranscript()
        await this.saveTranscriptToChatHistory()
        this.sendHistory()
        void vscode.commands.executeCommand('setContext', 'cody.reply.pending', false)
        if (!ignoreEmbeddingsError) {
            this.logEmbeddingsSearchErrors()
        }
    }

    protected async abortCompletion(): Promise<void> {
        await this.saveTranscriptToChatHistory()
        this.cancelCompletion()
        await this.multiplexer.notifyTurnComplete()
        await this.onCompletionEnd()
    }

    private getRecipe(id: RecipeID): Recipe | undefined {
        return this.platform.recipes.find(recipe => recipe.id === id)
    }

    public async executeRecipe(recipeId: RecipeID, humanChatInput = '', source?: ChatEventSource): Promise<void> {
        if (this.isMessageInProgress) {
            this.handleError('Cannot execute multiple recipes. Please wait for the current recipe to finish.', 'system')
            return
        }

        // Filter the human input to check for chat commands and retrieve the correct recipe id
        // e.g. /edit from 'chat-question' should be redirected to use the 'fixup' recipe
        const command = await this.chatCommandsFilter(humanChatInput, recipeId, source)
        if (!command) {
            return
        }
        humanChatInput = command?.text
        recipeId = command?.recipeId

        logDebug('MessageProvider:executeRecipe', recipeId, { verbose: humanChatInput })

        const recipe = this.getRecipe(recipeId)
        if (!recipe) {
            logDebug('MessageProvider:executeRecipe', 'no recipe found')
            return
        }

        // Create a new multiplexer to drop any old subscribers
        this.multiplexer = new BotResponseMultiplexer()

        let interaction: Interaction | null = null

        try {
            interaction = await recipe.getInteraction(humanChatInput, {
                editor: this.editor,
                intentDetector: this.intentDetector,
                codebaseContext: this.contextProvider.context,
                responseMultiplexer: this.multiplexer,
                firstInteraction: this.transcript.isEmpty,
            })
        } catch (error: any) {
            this.handleError(error.message, 'system')
            return
        }

        if (!interaction) {
            return
        }
        const errorMsg = interaction?.getAssistantMessage()?.error
        if (errorMsg !== undefined) {
            await this.addCustomInteraction(errorMsg, '', interaction)
            return
        }
        this.isMessageInProgress = true
        this.transcript.addInteraction(interaction)

        const contextSummary = {
            embeddings: 0,
            local: 0,
        }

        // Check whether or not to connect to LLM backend for responses
        // Ex: performing fuzzy / context-search does not require responses from LLM backend
        switch (recipeId) {
            case 'local-indexed-keyword-search':
            case 'context-search':
                this.sendTranscript()
                await this.onCompletionEnd()
                break
            default: {
                this.sendTranscript()

                const { prompt, contextFiles, preciseContexts } = await this.transcript.getPromptForLastInteraction(
                    getPreamble(this.contextProvider.context.getCodebase()),
                    this.maxPromptTokens
                )
                this.transcript.setUsedContextFilesForLastInteraction(contextFiles, preciseContexts)
                this.sendPrompt(
                    prompt,
                    interaction.getAssistantMessage().prefix ?? '',
                    recipe.multiplexerTopic,
                    recipeId
                )
                await this.saveTranscriptToChatHistory()

                contextFiles.map(file => {
                    if (file.source) {
                        contextSummary.embeddings++
                    } else {
                        contextSummary.local++
                    }
                })
            }
        }
        telemetryService.log(
            `CodyVSCodeExtension:recipe:${recipe.id}:executed`,
            { contextSummary },
            { hasV2Event: true }
        )
        telemetryRecorder.recordEvent(`cody.recipe.${recipe.id}`, 'executed', { metadata: { ...contextSummary } })
    }

    protected async runRecipeForSuggestion(recipeId: RecipeID, humanChatInput: string = ''): Promise<void> {
        const recipe = this.getRecipe(recipeId)
        if (!recipe) {
            return
        }

        const multiplexer = new BotResponseMultiplexer()
        const transcript = Transcript.fromJSON(await this.transcript.toJSON())

        const interaction = await recipe.getInteraction(humanChatInput, {
            editor: this.editor,
            intentDetector: this.intentDetector,
            codebaseContext: this.contextProvider.context,
            responseMultiplexer: multiplexer,
            firstInteraction: this.transcript.isEmpty,
        })
        if (!interaction) {
            return
        }
        transcript.addInteraction(interaction)

        const { prompt, contextFiles } = await transcript.getPromptForLastInteraction(
            getPreamble(this.contextProvider.context.getCodebase()),
            this.maxPromptTokens
        )
        transcript.setUsedContextFilesForLastInteraction(contextFiles)

        telemetryService.log(`CodyVSCodeExtension:recipe:${recipe.id}:executed`, undefined, { hasV2Event: true })

        let text = ''
        multiplexer.sub(BotResponseMultiplexer.DEFAULT_TOPIC, {
            onResponse: (content: string) => {
                text += content
                return Promise.resolve()
            },
            onTurnComplete: () => {
                const suggestions = text
                    .split('\n')
                    .slice(0, 3)
                    .map(line => line.trim().replace(/^-/, '').trim())
                this.handleSuggestions(suggestions)
                return Promise.resolve()
            },
        })

        let textConsumed = 0
        this.chat.chat(prompt, {
            onChange: text => {
                // TODO(dpc): The multiplexer can handle incremental text. Change chat to provide incremental text.
                text = text.slice(textConsumed)
                textConsumed += text.length
                void multiplexer.publish(text)
            },
            onComplete: () => {
                void multiplexer.notifyTurnComplete()
            },
            onError: (error, statusCode) => {
                console.error(error, statusCode)
            },
        })
    }

    private async guardrailsAnnotateAttributions(text: string): Promise<string> {
        if (!this.contextProvider.config.experimentalGuardrails) {
            return text
        }

        const result = await annotateAttribution(this.guardrails, text)

        // Only log telemetry if we did work (ie had to annotate something).
        if (result.codeBlocks > 0) {
            telemetryService.log(
                'CodyVSCodeExtension:guardrails:annotate',
                {
                    codeBlocks: result.codeBlocks,
                    duration: result.duration,
                },
                { hasV2Event: true }
            )
            telemetryRecorder.recordEvent('cody.guardrails.annotate', 'executed', {
                // Convert nanoseconds to milliseconds to match other telemetry.
                metadata: { codeBlocks: result.codeBlocks, durationMs: result.duration / 1000000 },
            })
        }

        return result.text
    }

    /**
     * Send transcript to view
     */
    private sendTranscript(): void {
        const chatTranscript = this.transcript.toChat()
        this.handleTranscript(chatTranscript, this.isMessageInProgress)
    }

    public isCustomCommandAction(title: string): boolean {
        const customPromptActions = ['add', 'get', 'menu']
        return customPromptActions.includes(title)
    }

    /**
     * Handle instructions returned from webview in regard to a Cody Command
     * Finds and execute a Cody command
     */
    public async executeCustomCommand(title: string, type?: CustomCommandType): Promise<void> {
        title = title.trim()
        switch (title) {
            case 'get':
                await this.sendCodyCommands()
                break
            case 'menu':
                await this.editor.controllers.command?.menu('custom')
                await this.sendCodyCommands()
                break
            case 'add':
                if (!type) {
                    break
                }
                await this.editor.controllers.command?.configFileAction('add', type)
                telemetryService.log('CodyVSCodeExtension:addCommandButton:clicked', undefined, { hasV2Event: true })
                telemetryRecorder.recordEvent('cody.addCommandButton', 'clicked')
                break
        }
        // Get prompt details from controller by title then execute prompt's command
        return this.executeRecipe('custom-prompt', title, 'custom-commands')
    }

    protected async chatCommandsFilter(
        text: string,
        recipeId: RecipeID,
        source?: ChatEventSource
    ): Promise<{ text: string; recipeId: RecipeID; source?: ChatEventSource } | null> {
        // Inline chat has its own filter for slash commands
        if (recipeId === 'inline-chat') {
            return { text, recipeId }
        }
        text = text.trim()
        if (!text?.startsWith('/')) {
            return { text, recipeId }
        }
        switch (true) {
            case text === '/':
                return vscode.commands.executeCommand('cody.action.commands.menu', 'sidebar')
            case text === '/commands-settings':
                telemetryService.log(
                    'CodyVSCodeExtension:commandConfigMenuButton:clicked',
                    { source: 'sidebar' },
                    { hasV2Event: true }
                )
                telemetryRecorder.recordEvent(`cody.sidebar.commandConfigMenuButton.${source}`, 'clicked')
                return vscode.commands.executeCommand('cody.settings.commands')
            case /^\/o(pen)?\s/.test(text) && this.editor.controllers.command !== undefined:
                // open the user's ~/.vscode/cody.json file
                await this.editor.controllers.command?.open(text.split(' ')[1])
                telemetryService.log('CodyVSCodeExtension:command:openFile:executed', undefined, { hasV2Event: true })
                telemetryRecorder.recordEvent('cody.command.openFile', 'executed')
                return null
            case /^\/r(eset)?$/.test(text):
                await this.clearAndRestartSession()
                telemetryService.log('CodyVSCodeExtension:command:resetChat:executed', undefined, { hasV2Event: true })
                telemetryRecorder.recordEvent('cody.command.resetChat', 'executed')
                return null
            case /^\/symf(?:\s|$)/.test(text):
                return { text, recipeId: 'local-indexed-keyword-search' }
            case /^\/s(earch)?\s/.test(text):
                return { text, recipeId: 'context-search' }
            case /^\/ask(\s)?/.test(text): {
                let question = text.replace('/ask', '').trim()
                if (!question) {
                    question = await showAskQuestionQuickPick()
                }
                await vscode.commands.executeCommand('cody.action.chat', question, 'menu')
                return null
            }
            case /^\/edit(\s)?/.test(text):
                await vscode.commands.executeCommand('cody.command.edit-code', { instruction: text }, source)
                return null
            default: {
                if (!this.editor.getActiveTextEditor()?.filePath) {
                    await this.addCustomInteraction('Command failed. Please open a file and try again.', text)
                    return null
                }
                const commandRunnerID = await this.editor.controllers.command?.addCommand(text)
                if (!commandRunnerID) {
                    return null
                }
                if (commandRunnerID === 'invalid') {
                    // If no command found, send error message to view
                    await this.addCustomInteraction(`__${text}__ is not a valid command`, text)
                }
                return { text: commandRunnerID, recipeId: 'custom-prompt', source }
            }
        }
    }

    /**
     * Adds a custom interaction to the transcript.
     *
     * This method adds a new Interaction with the given assistant response and human input to the transcript.
     * It then sends the updated transcript, checks for transcript errors, and saves the transcript to the chat history
     */
    private async addCustomInteraction(
        assistantResponse: string,
        humanInput: string,
        interaction?: Interaction
    ): Promise<void> {
        const customInteraction = await newInteraction({
            displayText: humanInput,
            assistantDisplayText: assistantResponse,
        })
        this.transcript.addInteraction(interaction || customInteraction)
        this.sendTranscript()
        await this.saveTranscriptToChatHistory()
    }

    /**
     * Send list of Cody commands (default and custom) to webview
     */
    private async sendCodyCommands(): Promise<void> {
        const send = async (): Promise<void> => {
            await this.editor.controllers.command?.refresh()
            const commands = (await this.editor.controllers.command?.getAllCommands(true)) || []
            void this.handleCodyCommands(commands)
        }
        this.editor.controllers.command?.setMessenger(send)
        await send()
    }

    private async saveTranscriptToChatHistory(): Promise<void> {
        if (this.transcript.isEmpty) {
            return
        }
        MessageProvider.chatHistory[this.currentChatID] = await this.transcript.toJSON()
        await this.saveChatHistory()
        this.sendHistory()
    }

    /**
     * Save chat history
     */
    private async saveChatHistory(): Promise<void> {
        const userHistory = {
            chat: MessageProvider.chatHistory,
            input: MessageProvider.inputHistory,
        }
        await localStorage.setChatHistory(userHistory)
    }

    /**
     * Delete history from current chat history and local storage
     */
    protected async deleteHistory(chatID: string): Promise<void> {
        delete MessageProvider.chatHistory[chatID]
        await localStorage.deleteChatHistory(chatID)
        this.sendHistory()
        telemetryService.log('CodyVSCodeExtension:deleteChatHistoryButton:clicked', undefined, { hasV2Event: true })
        telemetryRecorder.recordEvent('cody.deleteChatHistoryButton', 'clicked')
    }

    /**
     * Loads chat history from local storage
     */
    private loadChatHistory(): void {
        const localHistory = localStorage.getChatHistory()
        if (localHistory) {
            MessageProvider.chatHistory = localHistory?.chat
            MessageProvider.inputHistory = localHistory.input
        }
    }

    /**
     * Export chat history to file system
     */
    public async exportHistory(): Promise<void> {
        telemetryService.log('CodyVSCodeExtension:exportChatHistoryButton:clicked', undefined, { hasV2Event: true })
        telemetryRecorder.recordEvent('cody.exportChatHistoryButton', 'clicked')
        const historyJson = MessageProvider.chatHistory
        const exportPath = await vscode.window.showSaveDialog({ filters: { 'Chat History': ['json'] } })
        if (!exportPath) {
            return
        }
        try {
            const logContent = new TextEncoder().encode(JSON.stringify(historyJson))
            await vscode.workspace.fs.writeFile(exportPath, logContent)
            // Display message and ask if user wants to open file
            void vscode.window.showInformationMessage('Chat history exported successfully.', 'Open').then(choice => {
                if (choice === 'Open') {
                    void vscode.commands.executeCommand('vscode.open', exportPath)
                }
            })
        } catch (error) {
            logError('MessageProvider:exportHistory', 'Failed to export chat history', error)
        }
    }

    /**
     * Send history to view
     */
    private sendHistory(): void {
        this.handleHistory({
            chat: MessageProvider.chatHistory,
            input: MessageProvider.inputHistory,
        })
    }

    /**
     * Send embedding connections or results error to output
     */
    private logEmbeddingsSearchErrors(): void {
        if (this.contextProvider.config.useContext !== 'embeddings') {
            return
        }
        const searchErrors = this.contextProvider.context.getEmbeddingSearchErrors()
        // Display error message as assistant response for users with indexed codebase but getting search errors
        if (this.contextProvider.context.checkEmbeddingsConnection() && searchErrors) {
            this.handleError(searchErrors, 'transcript')
            logError('ChatViewProvider:onLogEmbeddingsErrors', '', { verbose: searchErrors })
        }
    }

    public transcriptForTesting(testing: TestSupport): ChatMessage[] {
        if (!testing) {
            console.error('used ForTesting method without test support object')
            return []
        }
        return this.transcript.toChat()
    }

    public fixupTasksForTesting(testing: TestSupport): FixupTask[] {
        if (!testing) {
            console.error('used ForTesting method without test support object')
            return []
        }
        if (!this.editor.controllers.fixups) {
            throw new Error('no fixup controller')
        }
        return this.editor.controllers.fixups.getTasks()
    }

    public dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose()
        }
        this.disposables = []
    }

    private get maxPromptTokens(): number {
        const authStatus = this.authProvider.getAuthStatus()

        const codyConfig = vscode.workspace.getConfiguration('cody')
        const tokenLimit = codyConfig.get<number>('provider.limit.prompt')
        const localSolutionLimit = codyConfig.get<number>('provider.limit.solution')

        // The local config takes precedence over the server config.
        if (tokenLimit && localSolutionLimit) {
            return tokenLimit - localSolutionLimit
        }

        const solutionLimit = (localSolutionLimit || ANSWER_TOKENS) + SAFETY_PROMPT_TOKENS

        if (authStatus.configOverwrites?.chatModelMaxTokens) {
            return authStatus.configOverwrites.chatModelMaxTokens - solutionLimit
        }

        return DEFAULT_MAX_TOKENS - solutionLimit
    }
}

function isAbortError(error: string): boolean {
    return error === 'aborted' || error === 'socket hang up'
}
