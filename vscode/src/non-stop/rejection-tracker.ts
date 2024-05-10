import * as vscode from 'vscode'
import type { FixupTaskID } from './FixupTask'

interface TrackerCallbacks {
    onRejected: () => void
    onAccepted: () => void
}

interface TargetTask {
    id: FixupTaskID
    undoEvent: vscode.EventEmitter<FixupTaskID>
}

export const trackRejection = (
    document: vscode.TextDocument,
    workspace: Pick<typeof vscode.workspace, 'onDidChangeTextDocument' | 'onDidDeleteFiles'>,
    { onAccepted, onRejected }: TrackerCallbacks,
    task: TargetTask
) => {
    const stopTrackingRejection = () => {
        rejectionEditListener.dispose()
        rejectionFileListener.dispose()
        commandUndoListener.dispose()
    }

    /**
     * Tracks when a user clicks "Undo" in the Edit codelens.
     * This is important as VS Code doesn't let us easily differentiate between
     * document changes made by specific commands.
     *
     * This logic ensures we can still mark as task as rejected if a user clicks "Undo".
     */
    const commandUndoListener = task.undoEvent.event(id => {
        if (id !== task.id) {
            return
        }

        // Immediately dispose of the rejectionListener, otherwise this will also run
        // and mark the "Undo" change here as an "acccepted" change made by the user.
        stopTrackingRejection()

        // If a user manually clicked "Undo", we can be confident that they reject the fixup.
        onRejected()
    })

    let undoCount = 0
    /**
     * Tracks the rejection of a Fixup task via the users' next in-file action.
     * As in, if the user immediately undos the change via the system undo command,
     * or if they persist to make new edits to the file.
     *
     * Will listen for changes to the text document and tracks whether the Edit changes were undone or redone.
     * When a change is made, it logs telemetry about whether the change was rejected or accepted.
     */
    const rejectionEditListener = workspace.onDidChangeTextDocument(event => {
        if (
            event.document.uri.toString() !== document.uri.toString() ||
            event.contentChanges.length === 0
        ) {
            // Irrelevant change, ignore
            return
        }

        if (event.reason === vscode.TextDocumentChangeReason.Undo) {
            // Set state, but don't fire telemetry yet as the user could still "Redo".
            undoCount = undoCount + 1
            return
        }

        if (event.reason === vscode.TextDocumentChangeReason.Redo) {
            // User re-did the change, so reset state
            undoCount = undoCount - 1
            return
        }

        /**
         * Determine if this change is coming from a single-character edit,
         * i.e. if the user has continued typing something in the document.
         *
         * We filter out multi-character edits because it is much more likely that they are coming
         * from commands, e.g. the change may have been applied by a formatter.
         */
        const isSingleEdit =
            event.contentChanges.length === 1 && event.contentChanges[0].text.trim().length === 1

        if (!isSingleEdit) {
            // Not suitable to treat this as an edit acceptance,
            // do nothing, but update the undo count so we accurate track if a user
            // undos here.
            undoCount = undoCount - 1
            return
        }

        // User has made a change, we can now fire our stored state as to if the change was undone or not
        undoCount > 0 ? onRejected() : onAccepted()

        // We no longer need to track this change, so dispose of our listeners
        stopTrackingRejection()
    })

    /**
     * Tracks the rejection of a Fixup task through if the source file
     * was deleted before we marked the task as "accepted".
     */
    const rejectionFileListener = workspace.onDidDeleteFiles(event => {
        if (event.files.some(uri => uri.toString() !== document.uri.toString())) {
            // Irrelevant deletion, ignore
            return
        }

        // File was deleted, mark this change as rejected
        onRejected()

        // We no longer need to track this change, so dispose of our listeners
        stopTrackingRejection()
    })
}
