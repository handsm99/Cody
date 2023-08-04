import { QuickPickItem } from 'vscode'

import { CodyPromptType } from '@sourcegraph/cody-shared/src/chat/prompts'

export type CustomCommandMenuAction = 'add' | 'file' | 'delete' | 'list' | 'open' | 'cancel' | 'example' | 'back'

export interface CustomCommandMenuAnswer {
    actionID: CustomCommandMenuAction
    commandType: CodyPromptType
}

export interface UserWorkspaceInfo {
    homeDir: string
    workspaceRoot?: string
    currentFilePath?: string
    appRoot: string
}

export interface CustomCommandsItem extends QuickPickItem {
    id?: CustomCommandMenuAction
    type: CodyPromptType
}

export interface ContextOption {
    id: string
    label: string
    detail: string
    picked: boolean
    description?: string
}
