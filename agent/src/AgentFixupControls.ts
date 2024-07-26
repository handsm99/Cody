import type { FixupFile } from '../../vscode/src/non-stop/FixupFile'
import type { FixupTask, FixupTaskID } from '../../vscode/src/non-stop/FixupTask'
import type { FixupActor, FixupFileCollection } from '../../vscode/src/non-stop/roles'
import type { FixupControlApplicator } from '../../vscode/src/non-stop/strategies'
import { type Agent, errorToCodyError } from './agent'
import type { EditTask } from './protocol-alias'
import * as vscode from 'vscode'

export class AgentFixupControls implements FixupControlApplicator {
    constructor(
        private readonly fixups: FixupActor & FixupFileCollection,
        private readonly notify: typeof Agent.prototype.notify
    ) {}

    public acceptAll(id: FixupTaskID): void {
        const task = this.fixups.taskForId(id)
        if (task) {
            this.fixups.acceptAll(task)
        }
    }

    public accept(id: FixupTaskID, range: vscode.Range): void {
        const task = this.fixups.taskForId(id)
        if (task) {
            this.fixups.accept(task, range)
        }
    }

    public reject(id: FixupTaskID, range: vscode.Range ): void {
        const task = this.fixups.taskForId(id)
        if (task) {
            this.fixups.reject(task, range)
        }
    }

    public undo(id: FixupTaskID): void {
        const task = this.fixups.taskForId(id)
        if (task) {
            this.fixups.undo(task)
        }
    }

    public cancel(id: FixupTaskID): void {
        const task = this.fixups.taskForId(id)
        if (task) {
            this.fixups.cancel(task)
        }
    }

    // FixupControlApplicator

    didUpdateTask(task: FixupTask): void {
        this.notify('editTask/didUpdate', AgentFixupControls.serialize(task))
    }
    didDeleteTask(task: FixupTask): void {
        this.notify('editTask/didDelete', AgentFixupControls.serialize(task))
    }

    visibleFilesWithTasksMaybeChanged(files: readonly FixupFile[]): void {}

    dispose() {}

    public static serialize(task: FixupTask): EditTask {
        return {
            id: task.id,
            state: task.state,
            error: errorToCodyError(task.error),
            selectionRange: task.selectionRange,
            instruction: task.instruction?.toString().trim(),
        }
    }
}
