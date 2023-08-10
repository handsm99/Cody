import * as vscode from 'vscode'

import { CodyPromptType, ConfigFileName } from '@sourcegraph/cody-shared/src/chat/prompts'

export function constructFileUri(fileName: string, rootDirPath?: string): vscode.Uri | undefined {
    if (!rootDirPath) {
        return undefined
    }
    const fileNamePaths = fileName.split('/')
    const rootDirUri = vscode.Uri.file(rootDirPath)
    const codyJsonFilePath = vscode.Uri.joinPath(rootDirUri, ...fileNamePaths)
    return codyJsonFilePath
}

// Create a .vscode/cody.json file in the root directory of the workspace or user's home directory using the sample files
export async function createJSONFile(
    extensionPath: string,
    configFileUri: vscode.Uri,
    isUserType: boolean
): Promise<void> {
    const sampleFileName = isUserType ? 'user-cody.json' : 'workspace-cody.json'
    const codyJsonPath = constructFileUri('resources/samples/' + sampleFileName, extensionPath)
    if (!configFileUri || !codyJsonPath) {
        void vscode.window.showErrorMessage('Failed to create cody.json file.')
        return
    }
    const decoded = await getFileContentText(codyJsonPath)
    await saveJSONFile(decoded, configFileUri)
}

// Add context from the sample files to the .vscode/cody.json file
export async function saveJSONFile(context: string, filePath: vscode.Uri, isSaveMode = false): Promise<void> {
    const workspaceEditor = new vscode.WorkspaceEdit()
    // Clear the file before writing to it
    workspaceEditor.deleteFile(filePath, { ignoreIfNotExists: true })
    workspaceEditor.createFile(filePath, { ignoreIfExists: isSaveMode })
    workspaceEditor.insert(filePath, new vscode.Position(0, 0), context)
    await vscode.workspace.applyEdit(workspaceEditor)
    // Save the file
    const doc = await vscode.workspace.openTextDocument(filePath)
    await doc.save()
    if (!isSaveMode) {
        await vscode.window.showTextDocument(filePath)
    }
}

// Create a file watcher for each .vscode/cody.json file
export function createFileWatchers(fsPath?: string): vscode.FileSystemWatcher | null {
    const fileUri = constructFileUri(ConfigFileName.vscode, fsPath)
    if (!fileUri) {
        return null
    }
    // Use the file as the first arg to RelativePattern because a file watcher will be set up on the
    // first arg given. If this is a directory with many files, such as the user's home directory,
    // it will cause a very large number of watchers to be created, which will exhaust the system.
    // This occurs even if the second arg is a relative file path with no wildcards.
    const watchPattern = new vscode.RelativePattern(fileUri, '*')
    const watcher = vscode.workspace.createFileSystemWatcher(watchPattern)
    return watcher
}

export async function deleteFile(uri?: vscode.Uri): Promise<void> {
    if (!uri) {
        return
    }
    await vscode.workspace.fs.delete(uri)
}

export function getFileNameFromPath(path: string): string | undefined {
    return path.split('/').pop()
}

export async function getFileToRemove(keys: string[]): Promise<string | undefined> {
    return vscode.window.showQuickPick(Array.from(keys))
}

export const createQuickPickSeparator = (label = '', detail = ''): vscode.QuickPickItem => ({ kind: -1, label, detail })
export const createQuickPickItem = (label = '', description = ''): vscode.QuickPickItem => ({ label, description })

export async function getFileContentText(uri: vscode.Uri): Promise<string> {
    try {
        const bytes = await vscode.workspace.fs.readFile(uri)
        const content = new TextDecoder('utf-8').decode(bytes)
        return content
    } catch {
        return ''
    }
}

export const isUserType = (type: CodyPromptType): boolean => type === 'user'
export const isWorkspaceType = (type: CodyPromptType): boolean => type === 'workspace'
export const isCustomType = (type: CodyPromptType): boolean => type === 'user' || type === 'workspace'
export const isNonCustomType = (type: CodyPromptType): boolean => type === 'recently used' || type === 'default'

export const outputWrapper = `
Here is the output of the \`{command}\` command, inside <output> tags.:
<output>
{output}
</output>`

export const notificationOnDisabled = async (isEnabled: boolean): Promise<boolean> => {
    if (isEnabled) {
        return isEnabled
    }
    const enableResponse = await vscode.window.showInformationMessage(
        'Please first enable `Custom Commands` before trying again.',
        'Enable Custom Commands',
        'Cancel'
    )
    if (enableResponse === 'Enable Custom Commands') {
        await vscode.commands.executeCommand('cody.status-bar.interacted')
    }
    return isEnabled
}

export async function openCustomCommandDocsLink(): Promise<void> {
    const uri = 'https://sourcegraph.com/notebooks/Tm90ZWJvb2s6MzA1NQ=='
    await vscode.env.openExternal(vscode.Uri.parse(uri))
}
