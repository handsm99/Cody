import * as vscode from 'vscode'

/**
 * A development helper that runs on activation to make the edit-debug loop easier.
 *
 * The following VS Code settings are respected. (They are not part of this extension's contributed
 * configuration JSON Schema, so they will not validate in your VS Code user settings file.)
 *
 * - `cody.dev.openAutocompleteTraceView`: boolean
 */
export function onActivationDevelopmentHelpers(): void {
    const settings = vscode.workspace.getConfiguration('cody.dev')

    if (settings.get('openAutocompleteTraceView')) {
        void vscode.commands.executeCommand('cody.autocomplete.openTraceView')
    }
}
