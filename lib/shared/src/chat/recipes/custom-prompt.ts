import * as vscode from 'vscode'

import { CodebaseContext } from '../../codebase-context'
import { ContextMessage, getContextMessageWithResponse } from '../../codebase-context/messages'
import { ActiveTextEditorSelection, Editor } from '../../editor'
import {
    MAX_CURRENT_FILE_TOKENS,
    MAX_HUMAN_INPUT_TOKENS,
    NUM_CODE_RESULTS,
    NUM_TEXT_RESULTS,
} from '../../prompt/constants'
import {
    populateCodeContextTemplate,
    populateCurrentEditorContextTemplate,
    populateCurrentEditorSelectedContextTemplate,
    populateTerminalOutputContextTemplate,
} from '../../prompt/templates'
import { truncateText } from '../../prompt/truncation'
import { CodyPromptContext, defaultCodyPromptContext } from '../prompts'
import { Interaction } from '../transcript/interaction'

import { ChatQuestion } from './chat-question'
import { getFileExtension, numResults } from './helpers'
import { InlineTouch } from './inline-touch'
import { Recipe, RecipeContext, RecipeID } from './recipe'

/** ======================================================
 * Recipe for running custom prompts from the cody.json files
 * Works with VS Code only
====================================================== **/
// TODO (bee) clean up
export class CustomPrompt implements Recipe {
    public id: RecipeID = 'custom-prompt'

    public async getInteraction(humanChatInput: string, context: RecipeContext): Promise<Interaction | null> {
        const contextConfig = await context.editor.controllers?.command?.get('context')
        const isContextRequired = contextConfig
            ? (JSON.parse(contextConfig) as CodyPromptContext)
            : defaultCodyPromptContext
        // Check if selection is required
        const selection = context.editor.getActiveTextEditorSelection() || context.editor.controllers?.inline?.selection
        if (isContextRequired?.selection && !selection?.selectedText) {
            await vscode.window.showErrorMessage('This command requires text to be selected in the editor.')
            return null
        }
        // Make prompt text
        const humanInput = humanChatInput.trim()
        // Match human input with key from promptStore to get prompt text when there is none
        const promptText = humanInput || (await context.editor.controllers?.command?.get()) || null
        if (!promptText) {
            await vscode.window.showErrorMessage('Please enter a valid prompt for the custom command.')
            return null
        }
        // get output from the command if any
        const commandOutput = await context.editor.controllers?.command?.get('output')

        const selectionPromptText =
            !isContextRequired?.none && isContextRequired?.selection && selection?.fileName
                ? selection_prompt
                      .replace('{selectedText}', selection.selectedText)
                      .replace('{fileName}', selection?.fileName)
                : ''
        const codyPromptText = selectionPromptText + instruction_prompt.replace('{humanInput}', promptText)

        const truncatedText = truncateText(codyPromptText, MAX_HUMAN_INPUT_TOKENS)

        // Add selection file name as display when available
        const displayText = selection?.fileName ? this.getHumanDisplayText(humanInput, selection?.fileName) : humanInput

        return Promise.resolve(
            new Interaction(
                { speaker: 'human', text: truncatedText, displayText },
                { speaker: 'assistant' },
                this.getContextMessages(
                    truncatedText,
                    context.editor,
                    context.codebaseContext,
                    isContextRequired,
                    selection,
                    commandOutput
                ),
                []
            )
        )
    }

    // Get display text for human
    private getHumanDisplayText(humanChatInput: string, fileName: string): string {
        return humanChatInput + InlineTouch.displayPrompt + fileName
    }

    private async getContextMessages(
        text: string,
        editor: Editor,
        codebaseContext: CodebaseContext,
        isContextRequired: CodyPromptContext,
        selection?: ActiveTextEditorSelection | null,
        commandOutput?: string | null
    ): Promise<ContextMessage[]> {
        const contextMessages: ContextMessage[] = []
        // Return empty array if no context is required
        if (isContextRequired.none) {
            return []
        }
        // Codebase context is not included by default
        if (isContextRequired.codebase) {
            const codebaseContextMessages = await codebaseContext.getContextMessages(text, numResults)
            contextMessages.push(...codebaseContextMessages)
        }
        // Create context messages from open tabs
        if (isContextRequired.openTabs) {
            const openTabsContext = await CustomPrompt.getEditorOpenTabsContext()
            contextMessages.push(...openTabsContext)
        }
        // Create context messages from current directory
        if (isContextRequired.currentDir) {
            // Select test files from the directory only if the prompt text includes 'test'
            const isTestRequest = text.includes('test')
            const currentDirContext = await CustomPrompt.getCurrentDirContext(isTestRequest)
            contextMessages.push(...currentDirContext)
            // Add package.json context if it's available for test requests
            if (isTestRequest) {
                const packageJSONContextMessage = await CustomPrompt.getPackageJsonContext(selection?.fileName)
                contextMessages.push(...packageJSONContextMessage)
            }
        }
        // Create context messages from a fsPath of a workspace directory
        if (isContextRequired.directoryPath?.length) {
            const fileContext = await CustomPrompt.getEditorDirContext(
                isContextRequired.directoryPath,
                selection?.fileName
            )
            contextMessages.push(...fileContext)
        }
        // Create context messages from a fsPath of a file
        if (isContextRequired.filePath?.length) {
            const fileContext = await CustomPrompt.getFilePathContext(isContextRequired.filePath)
            contextMessages.push(...fileContext)
        }
        // Create context messages from current file
        if (isContextRequired.currentFile) {
            contextMessages.push(...ChatQuestion.getEditorContext(editor))
        }

        // Add selected text as context when available
        // if (selection?.selectedText && isContextRequired.selection) {
        //     contextMessages.push(...CustomPrompt.getEditorSelectionContext(selection))
        // }

        // Create context messages from terminal output if any
        if (isContextRequired.command?.length && commandOutput) {
            contextMessages.push(...CustomPrompt.getTerminalOutputContext(commandOutput))
        }
        // Return the last n context messages in case there are too many
        // Make sure numResults is an even number and times 2 again to get the last n pairs
        const maxResults = Math.floor((NUM_CODE_RESULTS + NUM_TEXT_RESULTS) / 2) * 2
        return contextMessages.slice(-maxResults * 2)
    }

    public static getEditorSelectionContext(selection: ActiveTextEditorSelection): ContextMessage[] {
        const truncatedContent = truncateText(selection.selectedText, MAX_CURRENT_FILE_TOKENS)
        return getContextMessageWithResponse(
            populateCurrentEditorSelectedContextTemplate(truncatedContent, selection.fileName, selection.repoName),
            selection,
            'Noted. I will refer to this code you selected in the editor to answer your question.'
        )
    }

    // Get context from current editor open tabs
    // If a fsPath is provided for a directory, skip all the matches in that directory,
    // which is helpful when used with getCurrentDirContext to avoid duplication
    public static async getEditorOpenTabsContext(dirPath?: string): Promise<ContextMessage[]> {
        const contextMessages: ContextMessage[] = []
        // Get a list of the open tabs
        const openTabs = vscode.window.tabGroups.all
        const files = openTabs.flatMap(group => group.tabs.map(tab => tab.input)) as vscode.TabInputText[]
        for (const doc of files) {
            // Skip directories
            if (doc.uri.scheme !== 'file') {
                continue
            }
            // Skip if the file is in the same directory as the current file to avoid redundancy
            if (dirPath && doc.uri.fsPath.includes(dirPath)) {
                continue
            }
            // remove workspace root path from fileName
            const fileContent = await vscode.workspace.openTextDocument(doc.uri)
            const fileName = vscode.workspace.asRelativePath(doc.uri.fsPath)
            const truncatedContent = truncateText(fileContent.getText(), MAX_CURRENT_FILE_TOKENS)
            const docAsMessage = getContextMessageWithResponse(
                populateCurrentEditorContextTemplate(toJSON(truncatedContent), fileName),
                { fileName }
            )
            contextMessages.push(...docAsMessage)
        }
        return contextMessages
    }

    // Create context message for a terminal output
    public static getTerminalOutputContext(output: string): ContextMessage[] {
        const truncatedContent = truncateText(output, MAX_CURRENT_FILE_TOKENS)
        return [
            { speaker: 'human', text: populateTerminalOutputContextTemplate(truncatedContent) },
            {
                speaker: 'assistant',
                text: 'Noted. I will answer your next question based on this terminal output with the code you just shared.',
            },
        ]
    }

    // Get context from a file path
    public static async getFilePathContext(filePath: string): Promise<ContextMessage[]> {
        const fileUri = vscode.Uri.file(filePath)
        const fileName = vscode.workspace.asRelativePath(filePath)
        try {
            const bytes = await vscode.workspace.fs.readFile(fileUri)
            const decoded = new TextDecoder('utf-8').decode(bytes)
            const truncatedContent = truncateText(decoded, MAX_CURRENT_FILE_TOKENS)
            // Make sure the truncatedContent is in JSON format
            return getContextMessageWithResponse(populateCodeContextTemplate(truncatedContent, fileName), {
                fileName,
            })
        } catch (error) {
            console.log(error)
            return []
        }
    }

    // Create Context from files within a directory
    public static async getCurrentDirContext(isTestRequest: boolean): Promise<ContextMessage[]> {
        // Get current document file path
        const currentFileName = vscode.window.activeTextEditor?.document?.fileName
        if (!currentFileName) {
            return []
        }
        const currentDirPath = getCurrentDirPath(currentFileName)
        return CustomPrompt.getEditorDirContext(currentDirPath, currentFileName, isTestRequest)
    }

    // Create Context from Current Directory of the Active Document
    // Return tests files only if testOnly is true
    public static async getEditorDirContext(
        dirPath: string,
        currentFileName?: string,
        testOnly?: boolean
    ): Promise<ContextMessage[]> {
        try {
            // get a list of files from the current directory path
            const dirUri = vscode.Uri.file(dirPath)
            // Get the list of files in the current directory then filter out:
            // directories, non-test files, and dot files
            // then returns the first 10 results
            if (testOnly) {
                const contextMessages: ContextMessage[] = []
                const filesInDir = (await vscode.workspace.fs.readDirectory(dirUri)).filter(
                    file => file[1] === 1 && !file[0].startsWith('.') && (testOnly ? file[0].includes('test') : true)
                )
                contextMessages.push(...(await populateVscodeDirContextMessage(dirUri, filesInDir)))
                if (filesInDir.length > 1) {
                    return contextMessages
                }
                const parentDirName = getParentDirName(dirPath)
                const fileExt = currentFileName ? getFileExtension(currentFileName) : '*'
                // Search for files in directory with test(s) in the name
                const testDirFiles = await vscode.workspace.findFiles(`**/test*/**/*.${fileExt}`, undefined, 2)
                contextMessages.push(...(await getContextMessageFromFiles(testDirFiles)))
                // Search for test files from the parent directory
                const testFile = await vscode.workspace.findFiles(
                    `**/${parentDirName}/**/*test*.${fileExt}}`,
                    undefined,
                    2
                )
                contextMessages.push(...(await getContextMessageFromFiles(testFile)))
                // Return the context messages if there are any
                if (contextMessages.length) {
                    return contextMessages
                }
            }
            // Get first 10 files in the directory
            const filesInDir = await getFirstNFilesFromDir(dirUri, 10)
            // When there is no test files, Try to add the package.json context if it's available
            return await populateVscodeDirContextMessage(dirUri, filesInDir)
        } catch {
            return []
        }
    }

    // Get context from the last package.json in the current file path
    public static async getPackageJsonContext(filePath?: string): Promise<ContextMessage[]> {
        const currentFilePath = filePath || vscode.window.activeTextEditor?.document.uri.fsPath
        if (!currentFilePath) {
            return []
        }
        // Search for the package.json from the root of the repository
        const packageJsonPath = await vscode.workspace.findFiles('**/package.json', '**/node_modules/**', 1)
        if (!packageJsonPath.length) {
            return []
        }
        try {
            const packageJsonUri = packageJsonPath[0]
            const packageJsonContent = await vscode.workspace.fs.readFile(packageJsonUri)
            const decoded = new TextDecoder('utf-8').decode(packageJsonContent)
            // Turn the content into a json and get the scripts object only
            const packageJson = JSON.parse(decoded) as Record<string, unknown>
            const scripts = packageJson.scripts
            const devDependencies = packageJson.devDependencies
            // stringify the scripts object with devDependencies
            const context = JSON.stringify({ scripts, devDependencies })
            const truncatedContent = truncateText(context.toString() || decoded.toString(), MAX_CURRENT_FILE_TOKENS)
            const fileName = vscode.workspace.asRelativePath(packageJsonUri.fsPath)
            return getContextMessageWithResponse(populateCodeContextTemplate(truncatedContent, fileName), {
                fileName,
            })
        } catch {
            return []
        }
    }
}

/**
 * Populates context messages for files in a VS Code directory.
 *
 * @param dirUri - The VS Code Uri of the directory to get files from.
 * @param filesInDir - An array of file name and file type tuples for the files in the director
 *
 */

async function populateVscodeDirContextMessage(
    dirUri: vscode.Uri,
    filesInDir: [string, vscode.FileType][]
): Promise<ContextMessage[]> {
    const contextMessages: ContextMessage[] = []
    for (const file of filesInDir) {
        // Get the context from each file
        const fileUri = vscode.Uri.joinPath(dirUri, file[0])
        const fileName = vscode.workspace.asRelativePath(fileUri.fsPath)
        // check file size before opening the file
        // skip file if it's larger than 1MB
        const fileSize = await vscode.workspace.fs.stat(fileUri)
        if (fileSize.size > 1000000 || !fileSize.size) {
            continue
        }
        try {
            const fileContent = await vscode.workspace.fs.readFile(fileUri)
            const decoded = new TextDecoder('utf-8').decode(fileContent)
            const truncatedContent = truncateText(decoded, MAX_CURRENT_FILE_TOKENS)
            const contextMessage = getContextMessageWithResponse(
                populateCurrentEditorContextTemplate(toJSON(truncatedContent), fileName),
                { fileName }
            )
            contextMessages.push(...contextMessage)
        } catch (error) {
            console.error(error)
        }
    }
    return contextMessages
}

// Clean up the string to be used as value in JSON format
// Escape double quotes and backslashes and forward slashes
function toJSON(context: string): string {
    const escaped = context.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\//g, '\\/').replace('/\n//', '\n')
    return JSON.stringify(escaped)
}

// Split the directory path into parts and remove the last part to get the parent directory path
const getParentDirName = (dirPath: string): string => {
    const pathParts = dirPath.split('/')
    pathParts.pop()
    return pathParts.pop() || ''
}

// Get the current directory path from the file path
const getCurrentDirPath = (filePath: string): string => filePath?.replace(/\/[^/]+$/, '')

// Get the first n files from a directory Uri
const getFirstNFilesFromDir = async (dirUri: vscode.Uri, n: number): Promise<[string, vscode.FileType][]> =>
    (await vscode.workspace.fs.readDirectory(dirUri))
        .filter(file => file[1] === 1 && !file[0].startsWith('.'))
        .slice(0, n)

async function getContextMessageFromFiles(files: vscode.Uri[]): Promise<ContextMessage[]> {
    const contextMessages: ContextMessage[] = []
    for (const file of files) {
        const contextMessage = await CustomPrompt.getFilePathContext(file.fsPath)
        contextMessages.push(...contextMessage)
    }
    return contextMessages
}

const selection_prompt = `
I have questions about this selected code from {fileName}:
\`\`\`
{selectedText}
\`\`\`
`

const instruction_prompt = `Please follow these rules when answering my question:
- Do not remove code that might be being used by the other part of the code that was not shared.
- Your answers and suggestions should based on the shared context only.
- Do not suggest anything that would break the working code.
- Provides full workable code when possible.

Questions: {humanInput}
`
