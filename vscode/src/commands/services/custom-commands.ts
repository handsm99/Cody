import { omit } from 'lodash'
import * as vscode from 'vscode'
import os from 'os'

import type { CodyCommand } from '@sourcegraph/cody-shared'

import { logDebug, logError } from '../../log'

import { ConfigFiles, type CodyCommandsFile } from '../types'
import { createFileWatchers, createJSONFile, saveJSONFile } from '../utils/config-file'
import { showNewCustomCommandMenu } from '../menus'
import { URI, Utils } from 'vscode-uri'
import { buildCodyCommandMap } from '../utils/get-commands'
import { CustomCommandType } from '@sourcegraph/cody-shared/src/commands/types'
import { getConfiguration } from '../../configuration'
import { isMac } from '@sourcegraph/cody-shared/src/common/platform'
import { getDocText } from '../utils/workspace-files'

const isTesting = process.env.CODY_TESTING === 'true'
const isMacOS = isMac()
const userHomePath = os.homedir() || process.env.HOME || process.env.USERPROFILE || ''

/**
 * Handles loading, building, and maintaining Custom Commands retrieved from cody.json files
 */
export class CustomCommandsManager implements vscode.Disposable {
    // Watchers for the cody.json files
    private fileWatcherDisposables: vscode.Disposable[] = []
    private registeredCommands: vscode.Disposable[] = []
    private disposables: vscode.Disposable[] = []

    public customCommandsMap = new Map<string, CodyCommand>()

    // Configuration files
    protected configFileName
    private userConfigFile
    private get workspaceConfigFile(): vscode.Uri | undefined {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri
        if (!workspaceRoot) {
            return undefined
        }
        return Utils.joinPath(workspaceRoot, this.configFileName)
    }

    constructor() {
        // TODO (bee) Migrate to use .cody/commands.json for VS Code
        // Right now agent is using .cody/commands.json for Custom Commands,
        // .vscode/cody.json in VS Code.
        const workspaceConfig = vscode.workspace.getConfiguration()
        const config = getConfiguration(workspaceConfig)
        this.configFileName = config.isRunningInsideAgent ? ConfigFiles.COMMAND : ConfigFiles.VSCODE
        this.userConfigFile = Utils.joinPath(URI.file(userHomePath), this.configFileName)

        this.disposables.push(
            vscode.commands.registerCommand('cody.menu.custom.build', () =>
                this.newCustomCommandQuickPick()
            ),
            vscode.commands.registerCommand('cody.commands.open.json', type =>
                this.configFileActions(type, 'open')
            ),
            vscode.commands.registerCommand('cody.commands.delete.json', type =>
                this.configFileActions(type, 'delete')
            )
        )
    }

    public getCommands(): [string, CodyCommand][] {
        return [...this.customCommandsMap].sort((a, b) => a[0].localeCompare(b[0]))
    }

    /**
     // TODO (bee) Migrate to use .cody/commands.json
     * Create file watchers for cody.json files.
     * Automatically update the command map when the cody.json files are changed
     */
    public init(): void {
        const userConfigWatcher = createFileWatchers(this.userConfigFile)
        if (userConfigWatcher) {
            this.fileWatcherDisposables.push(
                userConfigWatcher,
                userConfigWatcher.onDidChange(() => this.refresh?.()),
                userConfigWatcher.onDidDelete(() => this.refresh?.())
            )
        }

        // Create file watchers in trusted workspaces only
        if (vscode.workspace.isTrusted) {
            const wsConfigWatcher = createFileWatchers(this.workspaceConfigFile)
            if (wsConfigWatcher) {
                this.fileWatcherDisposables.push(
                    wsConfigWatcher,
                    wsConfigWatcher.onDidChange(() => this.refresh?.()),
                    wsConfigWatcher.onDidDelete(() => this.refresh?.())
                )
            }
        }

        if (this.fileWatcherDisposables.length) {
            logDebug('CommandsController:init', 'watchers created')
        }
    }

    /**
     * Get the uri of the cody.json file for the given type
     */
    private getConfigFileByType(type: CustomCommandType): vscode.Uri | undefined {
        const configFileUri =
            type === CustomCommandType.User ? this.userConfigFile : this.workspaceConfigFile
        return configFileUri
    }

    /**
     * Rebuild the Custom Commands Map from the cody.json files
     */
    public async refresh(): Promise<CodyCommandsFile> {
        try {
            // Deregister all commands before rebuilding them to avoid duplicates
            this.disposeRegisteredCommands()
            // Reset the map before rebuilding
            this.customCommandsMap = new Map<string, CodyCommand>()
            // user commands
            if (this.userConfigFile?.path) {
                await this.build(CustomCommandType.User)
            }
            // 🚨 SECURITY: Only build workspace command in trusted workspace
            if (vscode.workspace.isTrusted) {
                await this.build(CustomCommandType.Workspace)
            }
        } catch (error) {
            logError('CustomCommandsProvider:refresh', 'failed', { verbose: error })
        }
        return { commands: this.customCommandsMap }
    }

    /**
     * Handles building the Custom Commands Map from the cody.json files
     *
     * 🚨 SECURITY: Only build workspace command in trusted workspace
     */
    public async build(type: CustomCommandType): Promise<Map<string, CodyCommand> | null> {
        const uri = this.getConfigFileByType(type)
        if (!uri || (type === CustomCommandType.Workspace && !vscode.workspace.isTrusted)) {
            return null
        }
        try {
            const content = await getDocText(uri)
            if (!content.trim()) {
                return null
            }
            const customCommandsMap = buildCodyCommandMap(type, content)
            this.customCommandsMap = new Map([...this.customCommandsMap, ...customCommandsMap])

            // Register Custom Commands as VS Code commands
            for (const [key, _command] of customCommandsMap) {
                this.registeredCommands.push(
                    vscode.commands.registerCommand(`cody.command.custom.${key}`, () =>
                        vscode.commands.executeCommand('cody.action.command', key, {
                            source: 'keybinding',
                        })
                    )
                )
            }
        } catch (error) {
            console.error('CustomCommandsProvider:build', 'failed', { verbose: error })
        }
        return this.customCommandsMap
    }

    /**
     * Quick pick for creating a new custom command
     */
    private async newCustomCommandQuickPick(): Promise<void> {
        const commands = [...this.customCommandsMap.values()].map(c => c.key)
        const newCommand = await showNewCustomCommandMenu(commands)
        if (!newCommand) {
            return
        }

        // Save the prompt to the current Map and Extension storage
        await this.save(newCommand.key, newCommand.prompt, newCommand.type)
        await this.refresh()

        // Notify user
        const isUserCommand = newCommand.type === CustomCommandType.User
        const buttonTitle = `Open ${isUserCommand ? 'User' : 'Workspace'} Settings (JSON)`
        void vscode.window
            .showInformationMessage(
                `New ${newCommand.key} command saved to ${newCommand.type} settings`,
                buttonTitle
            )
            .then(async choice => {
                if (choice === buttonTitle) {
                    await this.configFileActions(newCommand.type, 'open')
                }
            })

        logDebug('CustomCommandsProvider:newCustomCommandQuickPick:', 'saved', {
            verbose: newCommand,
        })
    }

    /**
     * Add the newly create command via quick pick to the cody.json file on disk
     */
    private async save(
        id: string,
        command: CodyCommand,
        type: CustomCommandType = CustomCommandType.User
    ): Promise<void> {
        const uri = this.getConfigFileByType(type)
        if (!uri) {
            return
        }
        const fileContent = await getDocText(uri)
        const parsed = JSON.parse(fileContent) as Record<string, any>
        const commands = parsed.commands ?? parsed
        commands[id] = omit(command, 'key')
        await saveJSONFile(parsed, uri)
    }

    private async configFileActions(
        type: CustomCommandType,
        action: 'open' | 'delete' | 'create'
    ): Promise<void> {
        const uri = this.getConfigFileByType(type)
        if (!uri) {
            return
        }
        switch (action) {
            case 'open':
                void vscode.commands.executeCommand('vscode.open', uri)
                break
            case 'delete': {
                let fileType = 'user settings file (~/.vscode/cody.json)'
                if (type === CustomCommandType.Workspace) {
                    fileType = 'workspace settings file (.vscode/cody.json)'
                }
                const bin = isMacOS ? 'Trash' : 'Recycle Bin'
                const confirmationKey = `Move to ${bin}`
                // Playwright cannot capture and interact with pop-up modal in VS Code,
                // so we need to turn off modal mode for the display message during tests.
                const modal = !isTesting
                vscode.window
                    .showInformationMessage(
                        `Are you sure you want to delete your Cody ${fileType}?`,
                        { detail: `You can restore this file from the ${bin}.`, modal },
                        confirmationKey
                    )
                    .then(async choice => {
                        if (choice === confirmationKey) {
                            void vscode.workspace.fs.delete(uri)
                        }
                    })
                break
            }
            case 'create':
                await createJSONFile(uri)
                    .then(() => {
                        vscode.window
                            .showInformationMessage(
                                `Cody ${type} settings file created`,
                                'View Documentation'
                            )
                            .then(async choice => {
                                if (choice === 'View Documentation') {
                                    await openCustomCommandDocsLink()
                                }
                            })
                    })
                    .catch(error => {
                        const errorMessage = 'Failed to create cody.json file: '
                        void vscode.window.showErrorMessage(`${errorMessage} ${error}`)
                        logDebug('CustomCommandsProvider:configActions:create', 'failed', {
                            verbose: error,
                        })
                    })
                break
        }
    }

    /**
     * Reset
     */
    public dispose(): void {
        for (const disposable of this.disposables) {
            disposable.dispose()
        }
        this.disposeRegisteredCommands()
        this.disposeWatchers()
        this.customCommandsMap = new Map<string, CodyCommand>()
    }

    private disposeWatchers(): void {
        for (const disposable of this.fileWatcherDisposables) {
            disposable.dispose()
        }
        this.fileWatcherDisposables = []
    }

    private disposeRegisteredCommands(): void {
        for (const rc of this.registeredCommands) {
            rc.dispose()
        }
        this.registeredCommands = []
    }
}

export async function openCustomCommandDocsLink(): Promise<void> {
    const uri = 'https://sourcegraph.com/docs/cody/custom-commands'
    await vscode.env.openExternal(vscode.Uri.parse(uri))
}

// TODO (bee) Migrate cody.json to new config file location
// Rename the old config files to the new location
export async function migrateCommandFiles(): Promise<void> {
    // WORKSPACE
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri
    if (workspaceRoot) {
        const oldWsPath = Utils.joinPath(workspaceRoot, ConfigFiles.VSCODE)
        const newWSPath = Utils.joinPath(workspaceRoot, ConfigFiles.COMMAND)
        await migrateContent(oldWsPath, newWSPath).then(
            () => {},
            error => undefined
        )
    }

    // USER
    if (userHomePath) {
        const oldUserPath = Utils.joinPath(URI.file(userHomePath), ConfigFiles.VSCODE)
        const newUserPath = Utils.joinPath(URI.file(userHomePath), ConfigFiles.COMMAND)
        await migrateContent(oldUserPath, newUserPath).then(
            () => {},
            error => undefined
        )
    }
}

async function migrateContent(oldFile: vscode.Uri, newFile: vscode.Uri): Promise<void> {
    const oldUserContent = await getDocText(newFile)
    if (!oldUserContent.trim()) {
        return
    }

    const oldContent = await getDocText(oldFile)
    const workspaceEditor = new vscode.WorkspaceEdit()
    workspaceEditor.createFile(newFile, { ignoreIfExists: true })
    workspaceEditor.insert(newFile, new vscode.Position(0, 0), JSON.stringify(oldContent, null, 2))
    await vscode.workspace.applyEdit(workspaceEditor)
    workspaceEditor.deleteFile(oldFile, { ignoreIfNotExists: true })
    await vscode.workspace.openTextDocument(newFile).then(doc => doc.save())
}
