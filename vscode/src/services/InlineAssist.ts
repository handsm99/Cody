import * as vscode from 'vscode'

/**
 * Calculate new range based on changes in the document
 */
export function updateRangeOnDocChange(current: vscode.Range, change: vscode.Range, changeText: string): vscode.Range {
    if (change.start.line > current.end.line) {
        return current
    }
    let addedLines = 0
    if (changeText.includes('\n')) {
        addedLines = changeText.split('\n').length - 1
    } else if (change.end.line - change.start.line > 0) {
        addedLines -= change.end.line - change.start.line
    }
    const newStartLine = change.start.line > current.start.line ? current.start.line : current.start.line + addedLines
    const newRange = new vscode.Range(newStartLine, 0, current.end.line + addedLines, 0)
    return newRange
}
/**
 * Create selection range for a single line
 * This is used for display the Cody icon and Code action on top of the first line of selected code
 */
export function getSingleLineRange(line: number): vscode.Range {
    return new vscode.Range(line, 0, line, 0)
}
/**
 * Generate icon path for each speaker: cody vs human (sourcegraph)
 */
export function getIconPath(speaker: string, extPath: string): vscode.Uri {
    const extensionPath = vscode.Uri.file(extPath)
    const webviewPath = vscode.Uri.joinPath(extensionPath, 'dist/webviews')
    return vscode.Uri.joinPath(webviewPath, speaker === 'cody' ? 'cody.png' : 'sourcegraph.png')
}

/**
 * To Edit a document by its Uri
 * Returns the range of the section with the content replaced by Cody
 */
export async function editDocByUri(
    uri: vscode.Uri,
    lines: { start: number; end: number },
    content: string
): Promise<vscode.Range> {
    // Highlight from the start line to the length of the replacement content
    const lineDiff = content.split('\n').length - 2
    const document = await vscode.workspace.openTextDocument(uri)
    const edit = new vscode.WorkspaceEdit()
    const range = new vscode.Range(lines.start, 0, lines.end, 0)
    edit.delete(document.uri, range)
    edit.insert(document.uri, new vscode.Position(lines.start, 0), content)
    await vscode.workspace.applyEdit(edit)
    return new vscode.Range(lines.start, 0, lines.start + lineDiff, 0)
}

export function countCode(code: string): { lineCount: number; charCount: number } {
    const lineCount = code.split(/\r\n|\r|\n/).length
    const charCount = code.length
    return { lineCount, charCount }
}

/**
 * Handle edge cases for code snippets where code is not pasted correctly
 * or code is multiline and the formatting is changed on paste
 */
export function matchCodeSnippets(copiedText: string, changedText: string): boolean {
    if (!changedText || !copiedText) {
        return false
    }
    // Code can be multiline, so we need to remove all new lines and spaces
    // from the copied code and changed text as formatting on paste may change the spacing
    const copiedTextNoSpace = copiedText.replace(/\s/g, '')
    const changedTextNoSpace = changedText?.replace(/\s/g, '')
    // check if the copied code is the same as the changed text without spaces
    return copiedTextNoSpace === changedTextNoSpace
}
