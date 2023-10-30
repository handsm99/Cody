import * as vscode from 'vscode'

import { getSingleLineRange } from '../services/InlineAssist'

import { FixupTask } from './FixupTask'
import { CodyTaskState } from './utils'

// Create Lenses based on state
export function getLensesForTask(task: FixupTask): vscode.CodeLens[] {
    const codeLensRange = getSingleLineRange(task.selectionRange.start.line)
    switch (task.state) {
        case CodyTaskState.working: {
            const title = getWorkingLens(codeLensRange)
            const cancel = getCancelLens(codeLensRange, task.id)
            return [title, cancel]
        }
        case CodyTaskState.applying: {
            const title = getApplyingLens(codeLensRange)
            return [title]
        }
        case CodyTaskState.applied: {
            const title = getAppliedLens(codeLensRange, task.id)
            const retry = getRetryLens(codeLensRange, task.id)
            const undo = getUndoLens(codeLensRange, task.id)
            const accept = getAcceptLens(codeLensRange, task.id)
            return [title, retry, undo, accept]
        }
        case CodyTaskState.error: {
            const title = getErrorLens(codeLensRange, task.id)
            const discard = getDiscardLens(codeLensRange, task.id)
            return [title, discard]
        }
        default:
            return []
    }
}

// List of lenses
function getErrorLens(codeLensRange: vscode.Range, id: string): vscode.CodeLens {
    const lens = new vscode.CodeLens(codeLensRange)
    lens.command = {
        title: '$(warning) Applying edits failed',
        command: 'cody.fixup.codelens.error',
        arguments: [id],
    }
    return lens
}

function getWorkingLens(codeLensRange: vscode.Range): vscode.CodeLens {
    const lens = new vscode.CodeLens(codeLensRange)
    lens.command = {
        title: '$(sync~spin) Cody is working...',
        command: 'cody.focus',
    }
    return lens
}

function getApplyingLens(codeLensRange: vscode.Range): vscode.CodeLens {
    const lens = new vscode.CodeLens(codeLensRange)
    lens.command = {
        title: '$(sync~spin) Applying...',
        command: 'cody.focus',
    }
    return lens
}

function getCancelLens(codeLensRange: vscode.Range, id: string): vscode.CodeLens {
    const lens = new vscode.CodeLens(codeLensRange)
    lens.command = {
        title: 'Cancel',
        command: 'cody.fixup.codelens.cancel',
        arguments: [id],
    }
    return lens
}

function getDiscardLens(codeLensRange: vscode.Range, id: string): vscode.CodeLens {
    const lens = new vscode.CodeLens(codeLensRange)
    lens.command = {
        title: 'Discard',
        command: 'cody.fixup.codelens.cancel',
        arguments: [id],
    }
    return lens
}

function getAppliedLens(codeLensRange: vscode.Range, id: string): vscode.CodeLens {
    const lens = new vscode.CodeLens(codeLensRange)
    lens.command = {
        title: '$(cody-logo) Edits Applied',
        command: 'cody.fixup.codelens.diff',
        arguments: [id],
    }
    return lens
}

function getRetryLens(codeLensRange: vscode.Range, id: string): vscode.CodeLens {
    const lens = new vscode.CodeLens(codeLensRange)
    lens.command = {
        title: 'Retry',
        command: 'cody.fixup.codelens.retry',
        arguments: [id],
    }
    return lens
}

function getUndoLens(codeLensRange: vscode.Range, id: string): vscode.CodeLens {
    const lens = new vscode.CodeLens(codeLensRange)
    lens.command = {
        title: 'Undo',
        command: 'cody.fixup.codelens.undo',
        arguments: [id],
    }
    return lens
}

function getAcceptLens(codeLensRange: vscode.Range, id: string): vscode.CodeLens {
    const lens = new vscode.CodeLens(codeLensRange)
    lens.command = {
        title: 'Done',
        command: 'cody.fixup.codelens.accept',
        arguments: [id],
    }
    return lens
}
