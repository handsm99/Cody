import {
    type ContextItem,
    ContextItemSource,
    TokenCounter,
    contextFiltersProvider,
    logError,
    toRangeData,
    wrapInActiveSpan,
} from '@sourcegraph/cody-shared'
import * as vscode from 'vscode'
import type { URI } from 'vscode-uri'

/**
 * Generate ContextFile for a file URI.
 */
export async function getContextFileFromUri(file: URI, range?: vscode.Range): Promise<ContextItem[]> {
    return wrapInActiveSpan('commands.context.filePath', async span => {
        try {
            if (await contextFiltersProvider.isUriIgnored(file)) {
                return []
            }

            // empty range can happen when user initiates action from right
            // click. Treat as wanting full document.
            range = range?.isEmpty ? undefined : range

            const doc = await vscode.workspace.openTextDocument(file)
            const content = doc?.getText(range).trim()
            if (!content) {
                throw new Error('No file content')
            }
            const size = TokenCounter.countTokens(content)

            return [
                {
                    type: 'file',
                    content,
                    uri: file,
                    source: ContextItemSource.Editor,
                    range: toRangeData(range),
                    size,
                },
            ] satisfies ContextItem[]
        } catch (error) {
            logError('getContextFileFromUri', 'failed', { verbose: error })
            return []
        }
    })
}
