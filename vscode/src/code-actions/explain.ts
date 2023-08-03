import * as vscode from 'vscode'

export class ExplainCodeAction implements vscode.CodeActionProvider {
    public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix]

    public provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range,
        context: vscode.CodeActionContext
    ): vscode.CodeAction[] {
        console.log(range)
        const diagnostics = context.diagnostics.filter(
            diagnostic =>
                diagnostic.severity === vscode.DiagnosticSeverity.Error ||
                diagnostic.severity === vscode.DiagnosticSeverity.Warning
        )
        if (diagnostics.length === 0) {
            return []
        }
        return [this.createCommandCodeAction(diagnostics, range)]
    }

    private createCommandCodeAction(diagnostics: vscode.Diagnostic[], range: vscode.Range): vscode.CodeAction {
        const action = new vscode.CodeAction('Explain with Cody', vscode.CodeActionKind.QuickFix)
        const instruction = this.getCodeActionInstruction(diagnostics)
        action.command = {
            command: 'cody.inline.add',
            arguments: [instruction, range],
            title: 'Explain with Cody',
        }
        return action
    }

    private getCodeActionInstruction = (diagnostics: vscode.Diagnostic[]): string =>
        `Explain the following error${diagnostics.length > 1 ? 's' : ''}:\n${diagnostics
            .map(({ message }) => `\`\`\`${message}\`\`\``)
            .join('\n')}`
}
