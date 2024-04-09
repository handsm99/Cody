import { exec } from 'node:child_process'
import os from 'node:os'
import { promisify } from 'node:util'

import * as vscode from 'vscode'

import { logError } from '../../log'

import path from 'node:path/posix'
import {
    type ContextItem,
    ContextItemSource,
    TokenCounter,
    USER_CONTEXT_TOKEN_BUDGET,
    USER_CONTEXT_TOKEN_BUDGET_IN_BYTES,
    truncateText,
    wrapInActiveSpan,
} from '@sourcegraph/cody-shared'
import { tokensToBytes } from '@sourcegraph/cody-shared/src/token/utils'

const _exec = promisify(exec)

/**
 * Creates a context file from executing a shell command. Used by CommandsController.
 *
 * Executes the given shell command, captures the output, wraps it in a context format,
 * and returns it as a ContextFile.
 */
export async function getContextFileFromShell(command: string): Promise<ContextItem[]> {
    return wrapInActiveSpan('commands.context.command', async span => {
        const rootDir = os.homedir() || process.env.HOME || process.env.USERPROFILE || ''

        if (!vscode.env.shell) {
            void vscode.window.showErrorMessage('Shell command is not supported your current workspace.')
            return []
        }

        // Expand the ~/ in command with the home directory if any of the substring starts with ~/ with a space before it
        const filteredCommand = command.replaceAll(/(\s~\/)/g, ` ${rootDir}${path.sep}`)
        // NOTE: Use fsPath to get path with platform specific path separator
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath
        try {
            const { stdout, stderr } = await _exec(filteredCommand, { cwd, encoding: 'utf8' })
            const output = stdout ?? stderr
            const outputString = JSON.stringify(output.trim())
            if (!outputString) {
                throw new Error('Empty output')
            }

            const context = outputWrapper.replace('{command}', command).replace('{output}', outputString)
            const truncatedContent = truncateText(context, USER_CONTEXT_TOKEN_BUDGET_IN_BYTES)
            const tokenCount = TokenCounter.countTokens(truncatedContent)
            const size = tokensToBytes(tokenCount)

            const file = {
                type: 'file',
                content: truncatedContent,
                title: 'Terminal Output',
                uri: vscode.Uri.file('terminal-output'),
                source: ContextItemSource.Terminal,
                size,
                isTooLarge: USER_CONTEXT_TOKEN_BUDGET < tokenCount,
            } satisfies ContextItem

            return [file]
        } catch (error) {
            // Handles errors and empty output
            logError('getContextFileFromShell', 'failed', { verbose: error })
            void vscode.window.showErrorMessage((error as Error).message)
            throw new Error('Failed to get shell output for Custom Command.')
        }
    })
}

const outputWrapper = `
Terminal output from the \`{command}\` command enclosed between <OUTPUT0412> tags:
<OUTPUT0412>
{output}
</OUTPUT0412>`
