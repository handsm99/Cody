import {
    type ChatMessage,
    type ContextItem,
    type ContextMessage,
    type Message,
    type ModelContextWindow,
    TokenCounter,
    displayPath,
    isCodyIgnoredFile,
    ps,
    toRangeData,
} from '@sourcegraph/cody-shared'
import type { ContextTokenUsageType } from '@sourcegraph/cody-shared/src/token'
import { renderContextItem } from './utils'

interface PromptBuilderContextResult {
    limitReached: boolean
    used: ContextItem[]
    ignored: ContextItem[]
    duplicate: ContextItem[]
}

/**
 * PromptBuilder constructs a full prompt given a charLimit constraint.
 * The final prompt is constructed by concatenating the following fields:
 * - prefixMessages
 * - the reverse of reverseMessages
 */
export class PromptBuilder {
    private prefixMessages: Message[] = []
    private reverseMessages: Message[] = []

    private processedContext = new Set<string>()
    private processedContextType = new Set<ContextTokenUsageType>()

    private tokenCounter: TokenCounter

    constructor(contextWindow: ModelContextWindow) {
        this.tokenCounter = new TokenCounter(contextWindow)
    }

    public build(): Message[] {
        return this.prefixMessages.concat([...this.reverseMessages].reverse())
    }

    public tryAddToPrefix(messages: Message[]): boolean {
        const withinLimit = this.tokenCounter.updateUsage('preamble', messages)
        if (withinLimit) {
            this.prefixMessages.push(...messages)
        }
        return withinLimit
    }

    /**
     * Tries to add messages in pairs from reversed transcript to the prompt builder.
     * Returns the index of the last message that was successfully added.
     *
     * Validates that the transcript alternates between human and assistant speakers.
     * Stops adding when the character limit would be exceeded.
     */
    public tryAddMessages(reverseTranscript: ChatMessage[]): number {
        // All Human message is expected to be followed by response from Assistant,
        // except for the Human message at the last index that Assistant hasn't responded yet.
        const lastHumanMsgIndex = reverseTranscript.findIndex(msg => msg.speaker === 'human')
        for (let i = lastHumanMsgIndex; i < reverseTranscript.length; i += 2) {
            const humanMsg = reverseTranscript[i]
            const assistantMsg = reverseTranscript[i - 1]
            if (humanMsg?.speaker !== 'human' || humanMsg?.speaker === assistantMsg?.speaker) {
                throw new Error(`Invalid transcript order: expected human message at index ${i}`)
            }
            const withinLimit = this.tokenCounter.updateUsage('input', [humanMsg, assistantMsg])
            if (!withinLimit) {
                return reverseTranscript.length - i + (assistantMsg ? 1 : 0)
            }
            if (assistantMsg) {
                this.reverseMessages.push(assistantMsg)
            }
            this.reverseMessages.push(humanMsg)
        }
        return 0
    }

    public tryAddContext(
        tokenType: ContextTokenUsageType,
        contextMessages: (ContextItem | ContextMessage)[]
    ): PromptBuilderContextResult {
        const result = {
            limitReached: false, // Indicates if the token budget was exceeded
            used: [] as ContextItem[], // The items that were successfully added
            ignored: [] as ContextItem[], // The items that were ignored
            duplicate: [] as ContextItem[], // The items that were duplicates of previously seen items
        }
        this.processedContextType.add(tokenType)
        // Create a new array to avoid modifying the original array, then reverse it to process the newest context items first.
        const reversedContextItems = contextMessages.slice().reverse()
        for (const item of reversedContextItems) {
            const userContextItem = contextItem(item)
            const id = this.getContextItemId(item)
            // Skip context items that are in the Cody ignore list
            if (isCodyIgnoredFile(userContextItem.uri)) {
                result.ignored.push(userContextItem)
                continue
            }

            // Check if the specific context item has already been seen
            if (this.processedContext.has(id)) {
                result.duplicate.push(userContextItem)
                continue
            }

            const contextMsg = isContextItem(item) ? renderContextItem(item) : item
            if (!contextMsg) {
                continue
            }
            const assistantMsg = { speaker: 'assistant', text: ps`Ok.` } as Message
            const withinLimit = this.tokenCounter.updateUsage(tokenType, [contextMsg, assistantMsg])

            // Check if the type of context item has been processed before to determine if it is a new item or not.
            // We do not want to update exisiting context items from chat history that's not related to last human message,
            // unless isTooLarge is undefined, meaning it has not been processed before like new enhanced context.
            if (
                (tokenType === 'user' && !this.processedContextType.has(tokenType)) ||
                userContextItem.isTooLarge === undefined
            ) {
                userContextItem.isTooLarge = !withinLimit
            }

            // Skip context items that would exceed the token budget
            if (!withinLimit) {
                userContextItem.content = undefined
                result.ignored.push(userContextItem)
                result.limitReached = true
                continue
            }
            this.processedContext.add(id)
            this.reverseMessages.push(assistantMsg, contextMsg)
            result.used.push(userContextItem)
        }
        return result
    }

    public getContextItemId(value: ContextItem | ContextMessage): string {
        const item = contextItem(value)

        // Unified context items have a `title` property that is used for display instead of the URI path,
        // as the source of the context lives remotely, we will not be able to use the uri path to match
        // the local context items.
        const displayFilePath = (item.source === 'unified' && item.title) || displayPath(item.uri)

        if (this.processedContext.has(displayFilePath)) {
            return displayFilePath
        }

        // HACK: Handle `item.range` values that were serialized from `vscode.Range` into JSON `[start,
        // end]`. If a value of that type exists in `item.range`, it's a bug, but it's an easy-to-hit
        // bug, so protect against it. See the `toRangeData` docstring for more.
        const range = toRangeData(item.range)
        if (range) {
            return `${displayFilePath}#${range.start.line}:${range.end.line}`
        }

        // If there's no range, it means the whole file was used as context
        return displayFilePath
    }
}

function isContextItem(value: ContextItem | ContextMessage): value is ContextItem {
    return 'uri' in value && 'type' in value && !('speaker' in value)
}

function contextItem(value: ContextItem | ContextMessage): ContextItem {
    return isContextItem(value) ? value : value.file
}
