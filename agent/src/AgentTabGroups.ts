import type * as vscode from 'vscode'

import { emptyEvent } from '../../vscode/src/testutils/mocks'

export class AgentTabGroups implements vscode.TabGroups {
    all: vscode.TabGroup[] = []
    activeTabGroup: vscode.TabGroup = { activeTab: undefined, isActive: true, tabs: [], viewColumn: 1 }
    public onDidChangeTabGroups: vscode.Event<vscode.TabGroupChangeEvent> = emptyEvent()
    public onDidChangeTabs: vscode.Event<vscode.TabChangeEvent> = emptyEvent()
    public close(): Thenable<boolean> {
        throw new Error('Method not implemented.')
    }
}
