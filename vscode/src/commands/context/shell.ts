import { exec } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
    type ContextItem,
    ContextItemSource,
    TokenCounterUtils,
    wrapInActiveSpan,
} from '@sourcegraph/cody-shared'
import * as vscode from 'vscode'
import { logError } from '../../log'

const execAsync = promisify(exec)

const OUTPUT_WRAPPER = `
Terminal output from the \`{command}\` command enclosed between <OUTPUT0412> tags:
<OUTPUT0412>
{output}
</OUTPUT0412>`

export async function getContextFileFromShell(command: string): Promise<ContextItem[]> {
    return wrapInActiveSpan('commands.context.command', async () => {
        if (!vscode.env.shell) {
            void vscode.window.showErrorMessage(
                'Shell command is not supported in your current workspace.'
            )
            return []
        }

        const homeDir = os.homedir() || process.env.HOME || process.env.USERPROFILE || ''
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath
        const filteredCommand = command.replaceAll(/(\s~\/)/g, ` ${homeDir}${path.sep}`)

        try {
            const { stdout, stderr } = await execAsync(filteredCommand, { cwd, encoding: 'utf8' })
            const output = JSON.stringify(stdout || stderr).trim()
            if (!output) {
                throw new Error('Empty output')
            }

            const content = OUTPUT_WRAPPER.replace('{command}', command).replace('{output}', output)
            const size = await TokenCounterUtils.countTokens(content)

            return [
                {
                    type: 'file',
                    content,
                    title: 'Terminal Output',
                    uri: vscode.Uri.file(command),
                    source: ContextItemSource.Terminal,
                    size,
                },
            ]
        } catch (error) {
            logError('getContextFileFromShell', 'failed', { verbose: error })
            const errorContent = `${error}`
            const size = await TokenCounterUtils.countTokens(errorContent)

            return [
                {
                    type: 'file',
                    content: errorContent,
                    title: 'Terminal Output',
                    uri: vscode.Uri.file(command),
                    source: ContextItemSource.Terminal,
                    size,
                },
            ]
        }
    })
}
