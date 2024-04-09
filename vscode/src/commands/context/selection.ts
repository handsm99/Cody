import {
    type ContextItem,
    TokenCounter,
    USER_CONTEXT_TOKEN_BUDGET,
    USER_CONTEXT_TOKEN_BUDGET_IN_BYTES,
    logError,
    truncateText,
    wrapInActiveSpan,
} from '@sourcegraph/cody-shared'
import {
    type ContextItemFile,
    ContextItemSource,
} from '@sourcegraph/cody-shared/src/codebase-context/messages'
import { getEditor } from '../../editor/active-editor'
import { getSmartSelection } from '../../editor/utils'

import { tokensToBytes } from '@sourcegraph/cody-shared/src/token/utils'
import { type Position, Selection } from 'vscode'
/**
 * Gets context file content from the current editor selection.
 *
 * When no selection is made, try getting the smart selection based on the cursor position.
 * If no smart selection is found, use the visible range of the editor instead.
 */
export async function getContextFileFromCursor(newCursorPosition?: Position): Promise<ContextItem[]> {
    return wrapInActiveSpan('commands.context.selection', async span => {
        try {
            const editor = getEditor()
            const document = editor?.active?.document

            if (!editor?.active || !document) {
                throw new Error('No active editor')
            }

            // Use user current selection if any
            // Else, use smart selection based on cursor position
            // Else, use visible range of the editor that contains the cursor as fallback
            const activeCursor = newCursorPosition && new Selection(newCursorPosition, newCursorPosition)
            const cursor = activeCursor ?? editor.active.selection
            const smartSelection = await getSmartSelection(document?.uri, cursor?.start)
            const activeSelection = !cursor?.start.isEqual(cursor?.end) ? cursor : smartSelection
            const visibleRange = editor.active.visibleRanges.find(range => range.contains(cursor?.start))
            const selection = activeSelection ?? visibleRange

            const content = document.getText(selection)
            const truncatedContent = truncateText(content, USER_CONTEXT_TOKEN_BUDGET_IN_BYTES)
            const tokenCount = TokenCounter.countTokens(truncatedContent)
            const size = tokensToBytes(tokenCount)

            return [
                {
                    type: 'file',
                    uri: document.uri,
                    content: truncatedContent,
                    source: ContextItemSource.Selection,
                    range: selection,
                    size,
                    isTooLarge: USER_CONTEXT_TOKEN_BUDGET < tokenCount,
                } satisfies ContextItemFile,
            ]
        } catch (error) {
            logError('getContextFileFromCursor', 'failed', { verbose: error })
            return []
        }
    })
}
