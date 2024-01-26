import * as vscode from 'vscode'

import {
    getSimplePreamble,
    isCodyIgnoredFile,
    languageFromFilename,
    populateCodeContextTemplate,
    populateContextTemplateFromText,
    populateCurrentSelectedCodeContextTemplate,
    populateMarkdownContextTemplate,
    ProgrammingLanguage,
    type Message,
} from '@sourcegraph/cody-shared'

import { logDebug } from '../../log'

import {
    contextItemId,
    type ContextItem,
    type MessageWithContext,
    type SimpleChatModel,
} from './SimpleChatModel'
import { URI } from 'vscode-uri'

interface PromptInfo {
    prompt: Message[]
    newContextUsed: ContextItem[]
}

export interface IPrompter {
    makePrompt(chat: SimpleChatModel, charLimit: number): Promise<PromptInfo>
}

const ENHANCED_CONTEXT_ALLOCATION = 0.6 // Enhanced context should take up 60% of the context window

export class CommandPrompter implements IPrompter {
    constructor(private getContextItems: (maxChars: number) => Promise<ContextItem[]>) {}
    public async makePrompt(chat: SimpleChatModel, charLimit: number): Promise<PromptInfo> {
        const enhancedContextCharLimit = Math.floor(charLimit * ENHANCED_CONTEXT_ALLOCATION)
        const promptBuilder = new PromptBuilder(charLimit)
        const newContextUsed: ContextItem[] = []
        const preInstruction: string | undefined = vscode.workspace
            .getConfiguration('cody.chat')
            .get('preInstruction')

        const preambleMessages = getSimplePreamble(preInstruction)
        const preambleSucceeded = promptBuilder.tryAddToPrefix(preambleMessages)
        if (!preambleSucceeded) {
            throw new Error(`Preamble length exceeded context window size ${charLimit}`)
        }

        // Add existing transcript messages
        const reverseTranscript: MessageWithContext[] = [...chat.getMessagesWithContext()].reverse()
        for (let i = 0; i < reverseTranscript.length; i++) {
            const messageWithContext = reverseTranscript[i]
            const contextLimitReached = promptBuilder.tryAdd(messageWithContext.message)
            if (!contextLimitReached) {
                logDebug(
                    'CommandPrompter.makePrompt',
                    `Ignored ${reverseTranscript.length - i} transcript messages due to context limit`
                )
                return {
                    prompt: promptBuilder.build(),
                    newContextUsed,
                }
            }
        }

        const contextItems = await this.getContextItems(enhancedContextCharLimit)
        const { limitReached, used, ignored } = promptBuilder.tryAddContext(
            contextItems,
            enhancedContextCharLimit
        )
        newContextUsed.push(...used)
        if (limitReached) {
            // TODO(beyang): we're masking this error (repro: try /explain),
            // we should improve the commands context selection process
            logDebug(
                'CommandPrompter',
                'makePrompt',
                `context limit reached, ignored ${ignored.length} items`
            )
        }

        return {
            prompt: promptBuilder.build(),
            newContextUsed,
        }
    }
}

export class DefaultPrompter implements IPrompter {
    constructor(
        private explicitContext: ContextItem[],
        private getEnhancedContext?: (query: string, charLimit: number) => Promise<ContextItem[]>
    ) {}
    // Constructs the raw prompt to send to the LLM, with message order reversed, so we can construct
    // an array with the most important messages (which appear most important first in the reverse-prompt.
    //
    // Returns the reverse prompt and the new context that was used in the
    // prompt for the current message.
    public async makePrompt(
        chat: SimpleChatModel,
        charLimit: number
    ): Promise<{
        prompt: Message[]
        newContextUsed: ContextItem[]
    }> {
        const enhancedContextCharLimit = Math.floor(charLimit * ENHANCED_CONTEXT_ALLOCATION)
        const promptBuilder = new PromptBuilder(charLimit)
        const newContextUsed: ContextItem[] = []
        const preInstruction: string | undefined = vscode.workspace
            .getConfiguration('cody.chat')
            .get('preInstruction')

        const preambleMessages = getSimplePreamble(preInstruction)
        const preambleSucceeded = promptBuilder.tryAddToPrefix(preambleMessages)
        if (!preambleSucceeded) {
            throw new Error(`Preamble length exceeded context window size ${charLimit}`)
        }

        // Add existing transcript messages
        const reverseTranscript: MessageWithContext[] = [...chat.getMessagesWithContext()].reverse()
        for (let i = 0; i < reverseTranscript.length; i++) {
            const messageWithContext = reverseTranscript[i]
            const contextLimitReached = promptBuilder.tryAdd(messageWithContext.message)
            if (!contextLimitReached) {
                logDebug(
                    'DefaultPrompter.makePrompt',
                    `Ignored ${reverseTranscript.length - i} transcript messages due to context limit`
                )
                return {
                    prompt: promptBuilder.build(),
                    newContextUsed,
                }
            }
        }

        {
            // Add context from new user-specified context items
            const { limitReached, used } = promptBuilder.tryAddContext(this.explicitContext)
            newContextUsed.push(...used)
            if (limitReached) {
                logDebug(
                    'DefaultPrompter.makePrompt',
                    'Ignored current user-specified context items due to context limit'
                )
                return { prompt: promptBuilder.build(), newContextUsed }
            }
        }

        // TODO(beyang): Decide whether context from previous messages is less
        // important than user added context, and if so, reorder this.
        {
            // Add context from previous messages
            const { limitReached } = promptBuilder.tryAddContext(
                reverseTranscript.flatMap((message: MessageWithContext) => message.newContextUsed || [])
            )
            if (limitReached) {
                logDebug(
                    'DefaultPrompter.makePrompt',
                    'Ignored prior context items due to context limit'
                )
                return { prompt: promptBuilder.build(), newContextUsed }
            }
        }

        const lastMessage = reverseTranscript[0]
        if (!lastMessage?.message.text) {
            throw new Error('No last message or last message text was empty')
        }
        if (lastMessage.message.speaker === 'assistant') {
            throw new Error('Last message in prompt needs speaker "human", but was "assistant"')
        }
        if (this.getEnhancedContext) {
            // Add additional context from current editor or broader search
            const additionalContextItems = await this.getEnhancedContext(
                lastMessage.message.text,
                enhancedContextCharLimit
            )
            const { limitReached, used, ignored } = promptBuilder.tryAddContext(
                additionalContextItems,
                enhancedContextCharLimit
            )
            newContextUsed.push(...used)
            if (limitReached) {
                logDebug(
                    'DefaultPrompter.makePrompt',
                    `Ignored ${ignored.length} additional context items due to limit reached`
                )
            }
        }

        return {
            prompt: promptBuilder.build(),
            newContextUsed,
        }
    }
}

function renderContextItem(contextItem: ContextItem): Message[] {
    // Do not create context item for empty file
    if (!contextItem.text?.trim()?.length) {
        return []
    }
    let messageText: string
    const uri = contextItem.source === 'unified' ? URI.parse(contextItem.title || '') : contextItem.uri
    if (contextItem.source === 'selection') {
        messageText = populateCurrentSelectedCodeContextTemplate(contextItem.text, uri)
    } else if (contextItem.source === 'editor') {
        // This template text works well with prompts in our commands
        // Using populateCodeContextTemplate here will cause confusion to Cody
        const templateText = 'Codebase context from file path {fileName}: '
        messageText = populateContextTemplateFromText(templateText, contextItem.text, uri)
    } else if (contextItem.source === 'terminal') {
        messageText = contextItem.text
    } else if (languageFromFilename(uri) === ProgrammingLanguage.Markdown) {
        messageText = populateMarkdownContextTemplate(contextItem.text, uri, contextItem.repoName)
    } else {
        messageText = populateCodeContextTemplate(contextItem.text, uri, contextItem.repoName)
    }
    return [
        { speaker: 'human', text: messageText },
        { speaker: 'assistant', text: 'Ok.' },
    ]
}

/**
 * PromptBuilder constructs a full prompt given a charLimit constraint.
 * The final prompt is constructed by concatenating the following fields:
 * - prefixMessages
 * - the reverse of reverseMessages
 */
class PromptBuilder {
    private prefixMessages: Message[] = []
    private reverseMessages: Message[] = []
    private charsUsed = 0
    private seenContext = new Set<string>()
    constructor(private readonly charLimit: number) {}

    public build(): Message[] {
        return this.prefixMessages.concat([...this.reverseMessages].reverse())
    }

    public tryAddToPrefix(messages: Message[]): boolean {
        let numChars = 0
        for (const message of messages) {
            numChars += message.speaker.length + (message.text?.length || 0) + 3 // space and 2 newlines
        }
        if (numChars + this.charsUsed > this.charLimit) {
            return false
        }
        this.prefixMessages.push(...messages)
        this.charsUsed += numChars
        return true
    }

    public tryAdd(message: Message): boolean {
        const lastMessage = this.reverseMessages.at(-1)
        if (lastMessage?.speaker === message.speaker) {
            throw new Error('Cannot add message with same speaker as last message')
        }

        const msgLen = message.speaker.length + (message.text?.length || 0) + 3 // space and 2 newlines
        if (this.charsUsed + msgLen > this.charLimit) {
            return false
        }
        this.reverseMessages.push(message)
        this.charsUsed += msgLen
        return true
    }

    /**
     * Tries to add context items to the prompt, tracking characters used.
     * Returns info about which items were used vs. ignored.
     */
    public tryAddContext(
        contextItems: ContextItem[],
        charLimit?: number
    ): {
        limitReached: boolean
        used: ContextItem[]
        ignored: ContextItem[]
        duplicate: ContextItem[]
    } {
        const effectiveCharLimit = charLimit ? this.charsUsed + charLimit : this.charLimit
        let limitReached = false
        const used: ContextItem[] = []
        const ignored: ContextItem[] = []
        const duplicate: ContextItem[] = []
        for (const contextItem of contextItems) {
            if (contextItem.uri.scheme === 'file' && isCodyIgnoredFile(contextItem.uri)) {
                ignored.push(contextItem)
                continue
            }
            const id = contextItemId(contextItem)
            if (this.seenContext.has(id)) {
                duplicate.push(contextItem)
                continue
            }
            const contextMessages = renderContextItem(contextItem).reverse()
            const contextLen = contextMessages.reduce(
                (acc, msg) => acc + msg.speaker.length + (msg.text?.length || 0) + 3,
                0
            )
            if (this.charsUsed + contextLen > effectiveCharLimit) {
                ignored.push(contextItem)
                limitReached = true
                continue
            }
            this.seenContext.add(id)
            this.reverseMessages.push(...contextMessages)
            this.charsUsed += contextLen
            used.push(contextItem)
        }
        return {
            limitReached,
            used,
            ignored,
            duplicate,
        }
    }
}
