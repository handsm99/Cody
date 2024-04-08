import {
    type ChatMessage,
    type ContextItem,
    ContextItemSource,
    type ContextMessage,
    type Message,
    type TokenCounter,
    isCodyIgnoredFile,
    toRangeData,
} from '@sourcegraph/cody-shared'
import { SHA256 } from 'crypto-js'
import { renderContextItem } from './utils'

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
    private seenContext = new Set<string>()
    constructor(private tokenCounter: TokenCounter) {}

    public build(): Message[] {
        return this.prefixMessages.concat([...this.reverseMessages].reverse())
    }

    public tryAddToPrefix(messages: Message[]): boolean {
        for (const message of messages) {
            const isAdded = this.tokenCounter.updateChatUsage([message])
            if (!isAdded) {
                return false
            }
        }
        this.prefixMessages.push(...messages)
        return true
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
            const isAdded = this.tokenCounter.updateChatUsage([humanMsg, assistantMsg])
            if (!isAdded) {
                return reverseTranscript.length - i + (assistantMsg ? 1 : 0)
            }
            if (assistantMsg) {
                this.reverseMessages.push(assistantMsg)
            }
            this.reverseMessages.push(humanMsg)
        }
        return 0
    }

    /**
     * Tries to add context items and messages to the prompt builder, tracking which ones were used, ignored, or duplicated.
     * Returns an object with the results of the operation.
     *
     * Validates that the context items are not in the Cody ignore list, and that they have not been seen before.
     * Stops adding context items when the token budget would be exceeded.
     *
     * @param contextItemsMessages - An array of context items or context messages to add to the prompt builder.
     */
    public tryAddUserContext(contextItemsMessages: (ContextItem | ContextMessage)[]): {
        limitReached: boolean
        used: ContextItem[]
        ignored: ContextItem[]
        duplicate: ContextItem[]
    } {
        const result = {
            limitReached: false, // Indicates if the token budget was exceeded
            used: [] as ContextItem[], // The context items that were successfully added
            ignored: [] as ContextItem[], // The context items that were ignored
            duplicate: [] as ContextItem[], // The context items that were duplicates of previously seen items
        }

        // Create a new array to avoid modifying the original array,
        // then reverse it to process the newest context items first.
        const reversedContextItems = contextItemsMessages.slice().reverse()
        for (const item of reversedContextItems) {
            const userContextItem = contextItem(item)
            const id = contextItemId(item)

            // Skip context items that are in the Cody ignore list
            if (isCodyIgnoredFile(userContextItem.uri)) {
                result.ignored.push(userContextItem)
                continue
            }

            // Skip context items that have already been seen
            if (this.seenContext.has(id)) {
                result.duplicate.push(userContextItem)
                continue
            }

            this.seenContext.add(id)

            const contextMessage = isContextItem(item) ? renderContextItem(item) : item
            const isAdded = contextMessage
                ? this.tokenCounter.updateUserContextUsage([contextMessage])
                : false
            userContextItem.isTooLarge = !isAdded

            // Skip context items that would exceed the token budget
            if (userContextItem.isTooLarge) {
                result.ignored.push(userContextItem)
                result.limitReached = true
                continue
            }

            if (contextMessage) {
                this.reverseMessages.push({ speaker: 'assistant', text: 'Ok.' })
                this.reverseMessages.push(contextMessage)
            }

            this.seenContext.add(id)
            result.used.push(userContextItem)
        }

        return result
    }

    /**
     * Tries to add context items to the prompt, tracking characters used.
     * Returns info about which items were used vs. ignored.
     *
     * If charLimit is specified, then imposes an additional limit on the
     * amount of context added from contextItems. This does not affect the
     * overall character limit, which is still enforced.
     */
    public tryAddContext(contextItemsAndMessages: (ContextItem | ContextMessage)[]): {
        limitReached: boolean
        used: ContextItem[]
        ignored: ContextItem[]
        duplicate: ContextItem[]
    } {
        let limitReached = false
        const used: ContextItem[] = []
        const ignored: ContextItem[] = []
        const duplicate: ContextItem[] = []
        if (isAgentTesting) {
            // Need deterministic ordering of context files for the tests to pass
            // consistently across different file systems.
            contextItemsAndMessages.sort((a, b) =>
                contextItem(a).uri.path.localeCompare(contextItem(b).uri.path)
            )
            // Move the selectionContext to the first position so that it'd be
            // the last context item to be read by the LLM to avoid confusions where
            // other files also include the selection text in test files.
            const selectionContext = contextItemsAndMessages.find(
                item =>
                    (isContextItem(item) ? item.source : item.file.source) ===
                    ContextItemSource.Selection
            )
            if (selectionContext) {
                contextItemsAndMessages.splice(contextItemsAndMessages.indexOf(selectionContext), 1)
                contextItemsAndMessages.unshift(selectionContext)
            }
        }
        for (const v of contextItemsAndMessages) {
            const item = contextItem(v)
            const uri = contextItem(v).uri
            if (uri.scheme === 'file' && isCodyIgnoredFile(uri)) {
                ignored.push(item)
                continue
            }
            const id = contextItemId(v)
            if (this.seenContext.has(id)) {
                duplicate.push(item)
                continue
            }
            const contextMessage = isContextItem(v) ? renderContextItem(v) : v
            const isAdded =
                contextMessage && this.tokenCounter.updateEnhancedContextUsage([contextMessage])
            if (!isAdded) {
                // Marks excluded context items as too large to be displayed in UI
                if (item.type === 'file') {
                    item.isTooLarge = true
                }
                ignored.push(item)
                limitReached = true
                continue
            }
            this.seenContext.add(id)
            if (contextMessage) {
                this.reverseMessages.push({ speaker: 'assistant', text: 'Ok.' })
                this.reverseMessages.push(contextMessage)
            }
            // Marks added file items as not too large
            if (item.type === 'file') {
                item.isTooLarge = false
            }
            used.push(item)
        }
        return {
            limitReached,
            used,
            ignored,
            duplicate,
        }
    }
}

function isContextItem(value: ContextItem | ContextMessage): value is ContextItem {
    return 'uri' in value && 'type' in value && !('speaker' in value)
}

function contextItem(value: ContextItem | ContextMessage): ContextItem {
    return isContextItem(value) ? value : value.file
}

function contextItemId(value: ContextItem | ContextMessage): string {
    const item = contextItem(value)

    // HACK: Handle `item.range` values that were serialized from `vscode.Range` into JSON `[start,
    // end]`. If a value of that type exists in `item.range`, it's a bug, but it's an easy-to-hit
    // bug, so protect against it. See the `toRangeData` docstring for more.
    const range = toRangeData(item.range)
    if (range) {
        return `${item.uri.toString()}#${range.start.line}:${range.end.line}`
    }

    if (item.content) {
        return `${item.uri.toString()}#${SHA256(item.content).toString()}`
    }

    return item.uri.toString()
}
