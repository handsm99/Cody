import * as vscode from 'vscode'

import { ActiveTextEditorSelectionRange } from '@sourcegraph/cody-shared'
import { ContextFile, ContextMessage } from '@sourcegraph/cody-shared/src/codebase-context/messages'

import { ContextItem } from './SimpleChatModel'

export const relativeFileUrlScheme = 'cody-file-relative'
export const embeddingsUrlScheme = 'cody-embeddings'

export function relativeFileUrl(fileName: string, range?: vscode.Range): vscode.Uri {
    return vscode.Uri.from({
        scheme: relativeFileUrlScheme,
        path: fileName,
        fragment: range && `L${range.start.line}-${range.end.line}`,
    })
}

// The approximate inverse of CodebaseContext.makeContextMessageWithResponse
export function contextMessageToContextItem(contextMessage: ContextMessage): ContextItem | null {
    if (!contextMessage.text) {
        return null
    }
    const contextText = stripContextWrapper(contextMessage.text)
    if (!contextText) {
        return null
    }
    if (!contextMessage.file) {
        return null
    }
    const range = contextMessage.file.range
    return {
        text: contextText,
        uri:
            contextMessage.file.uri ||
            relativeFileUrl(contextMessage.file.fileName, activeEditorSelectionRangeToRange(range)),
        range: range && new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character),
    }
}

export function stripContextWrapper(text: string): string | undefined {
    {
        const start = text.indexOf('Use following code snippet')
        if (start >= 0) {
            text = text.slice(start)
            const lines = text.split('\n')
            return lines.slice(2, -1).join('\n')
        }
    }
    {
        const start = text.indexOf('Use the following text from file')
        if (start >= 0) {
            text = text.slice(start)
            const lines = text.split('\n')
            return lines.slice(1).join('\n')
        }
    }
    {
        const start = text.indexOf('My selected ')
        const selectedStart = text.indexOf('<selected>')
        const selectedEnd = text.indexOf('</selected>')
        if (start >= 0 && selectedStart >= 0 && selectedEnd >= 0) {
            text = text.slice(selectedStart, selectedEnd)
            const lines = text.split('\n')
            return lines.slice(1, -1).join('\n')
        }
    }
    return undefined
}

export function contextItemsToContextFiles(items: ContextItem[]): ContextFile[] {
    const contextFiles: ContextFile[] = []
    for (const item of items) {
        let relFsPath = item.uri.fsPath
        if (relFsPath.startsWith('/')) {
            relFsPath = relFsPath.slice(1)
        }
        contextFiles.push({
            fileName: relFsPath,
            source: 'embeddings',
            range: rangeToActiveTextEditorSelectionRange(item.range),
            content: item.text,
        })
    }
    return contextFiles
}

export function rangeToActiveTextEditorSelectionRange(
    range?: vscode.Range
): ActiveTextEditorSelectionRange | undefined {
    if (!range) {
        return undefined
    }
    return {
        start: {
            line: range.start.line,
            character: range.start.character,
        },
        end: {
            line: range.end.line,
            character: range.end.character,
        },
    }
}

function activeEditorSelectionRangeToRange(range?: ActiveTextEditorSelectionRange): vscode.Range | undefined {
    if (!range) {
        return undefined
    }
    return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character)
}

export function getChatPanelTitle(lastDisplayText?: string): string {
    if (!lastDisplayText) {
        return 'New Chat'
    }
    // Regex to remove the markdown formatted links with this format: '[_@FILENAME_]()'
    const MARKDOWN_LINK_REGEX = /\[_(.+?)_]\((.+?)\)/g
    lastDisplayText = lastDisplayText.replaceAll(MARKDOWN_LINK_REGEX, '$1')?.trim()
    // truncate title that is too long
    return lastDisplayText
}
