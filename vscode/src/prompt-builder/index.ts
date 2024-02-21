import { type Message, isCodyIgnoredFile } from '@sourcegraph/cody-shared'
import type { ContextItem } from './types'
import { contextItemId, renderContextItem } from './utils'
import type { MessageWithContext } from '../chat/chat-view/SimpleChatModel'

const isAgentTesting = process.env.CODY_SHIM_TESTING === 'true'

/**
 * PromptBuilder constructs a full prompt given a charLimit constraint.
 * The final prompt is constructed by concatenating the following fields:
 * - prefixMessages
 * - the reverse of reverseMessages
 */
export class PromptBuilder {
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

    /**
     * @deprecated Use 'tryAddTranscript' instead.
     */
    public tryAdd(message: Message): boolean {
        const lastMessage = this.reverseMessages.at(-1)
        if (lastMessage?.speaker === message.speaker) {
            throw new Error('Cannot add message with same speaker as last message')
        }

        const msgLen = message.speaker.length + (message.text?.length || 0) + 3 // space and 2 newlines
        if (this.charsUsed + msgLen > this.charLimit) {
            // Remove the last assistant message which is a response to the current message
            // from human to avoid the `found consecutive messages with the same speaker 'assistant'`
            // error when we add the preamble that ends with 'assistant'.
            if (message.speaker === 'human' && lastMessage?.speaker === 'assistant') {
                this.reverseMessages.pop()
            }
            return false
        }
        this.reverseMessages.push(message)
        this.charsUsed += msgLen
        return true
    }

    /**
     * Tries to add messages from transcript in pairs to the prompt builder, in reverse order.
     * Returns the index of the last message that was successfully added.
     *
     * Validates that the transcript alternates between human and assistant speakers.
     * Stops adding when the character limit would be exceeded.
     */
    public tryAddTranscript(transcript: MessageWithContext[]): number {
        // All Human message is expected to be followed by response from Assistant,
        // except for the Human message at the last index that Assistant hasn't responded yet.
        let i = transcript.findLastIndex(msg => msg.message?.speaker === 'human')
        while (i >= 0) {
            const humanMsg = transcript[i]?.message
            const assistantMsg = transcript[i + 1]?.message
            if (humanMsg?.speaker !== 'human') {
                throw new Error('Invalid transcript: expected human message at index ' + i)
            }
            if (humanMsg?.speaker === assistantMsg?.speaker) {
                throw new Error('Cannot add message with same speaker as last message')
            }
            const getLength = (msg: Message) => msg.speaker.length + (msg.text?.length || 0) + 3
            const msgLen = getLength(humanMsg) + (assistantMsg ? getLength(assistantMsg) : 0)
            if (this.charsUsed + msgLen > this.charLimit) {
                return i
            }
            // Push the assistant response first to the reverseMessages to maintain the order.
            if (assistantMsg) {
                this.reverseMessages.push(assistantMsg)
            }
            this.reverseMessages.push(humanMsg)
            this.charsUsed += msgLen
            i -= 2
        }
        return 0
    }

    /**
     * Tries to add context items to the prompt, tracking characters used.
     * Returns info about which items were used vs. ignored.
     *
     * If charLimit is specified, then imposes an additional limit on the
     * amount of context added from contextItems. This does not affect the
     * overall character limit, which is still enforced.
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
        let effectiveCharLimit = this.charLimit - this.charsUsed
        if (charLimit && charLimit < effectiveCharLimit) {
            effectiveCharLimit = charLimit
        }

        let limitReached = false
        const used: ContextItem[] = []
        const ignored: ContextItem[] = []
        const duplicate: ContextItem[] = []
        if (isAgentTesting) {
            // Need deterministic ordering of context files for the tests to pass
            // consistently across different file systems.
            contextItems.sort((a, b) => a.uri.path.localeCompare(b.uri.path))
            // Move the selectionContext to the first position so that it'd be
            // the last context item to be read by the LLM to avoid confusions where
            // other files also include the selection text in test files.
            const selectionContext = contextItems.find(item => item.source === 'selection')
            if (selectionContext) {
                contextItems.splice(contextItems.indexOf(selectionContext), 1)
                contextItems.unshift(selectionContext)
            }
        }
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
