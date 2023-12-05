import * as assert from 'assert'

import * as vscode from 'vscode'

import { afterIntegrationTest, beforeIntegrationTest, getFixupTasks, getTranscript, waitUntil } from './helpers'

suite('Commands', function () {
    this.beforeEach(beforeIntegrationTest)
    this.afterEach(afterIntegrationTest)

    async function getTextEditorWithSelection(): Promise<void> {
        // Open Main.java
        assert.ok(vscode.workspace.workspaceFolders)
        const mainJavaUri = vscode.Uri.parse(`${vscode.workspace.workspaceFolders[0].uri.toString()}/Main.java`)
        const textEditor = await vscode.window.showTextDocument(mainJavaUri)

        // Select the "main" method
        textEditor.selection = new vscode.Selection(5, 0, 7, 0)
    }

    // regex for /^hello from the assistant$/
    const assistantRegex = /^hello from the assistant$/

    test('Explain Code', async () => {
        await getTextEditorWithSelection()

        // Run the "explain" command
        await vscode.commands.executeCommand('cody.command.explain-code')

        // Check the chat transcript contains markdown
        // const humanMessage = await getTranscript(0)
        // assert.match(humanMessage.displayText || '', /^\/explain/)
        assert.match((await getTranscript(0)).displayText || '', /^\/explain/)
        await waitUntil(async () => assistantRegex.test((await getTranscript(1)).displayText || ''))
    })

    test('Find Code Smells', async () => {
        await getTextEditorWithSelection()

        // Run the "/smell" command
        await vscode.commands.executeCommand('cody.command.smell-code')

        // Check the chat transcript contains markdown
        const humanMessage = await getTranscript(0)
        assert.match(humanMessage.displayText || '', /^\/smell/)

        await waitUntil(async () => assistantRegex.test((await getTranscript(1)).displayText || ''))
    })

    test('Generate Unit Tests', async () => {
        await getTextEditorWithSelection()

        // Run the "/test" command
        await vscode.commands.executeCommand('cody.command.generate-tests')

        // Check the chat transcript contains markdown
        const humanMessage = await getTranscript(0)
        assert.match(humanMessage.displayText || '', /^\/test/)

        await waitUntil(async () => assistantRegex.test((await getTranscript(1)).displayText || ''))
    })

    test('Document Code', async () => {
        await getTextEditorWithSelection()

        // Run the "/doc" command
        await vscode.commands.executeCommand('cody.command.document-code')

        await new Promise(resolve => setTimeout(resolve, 200)) // Make sure the command has finished

        // Check the Fixup Tasks from Task Controller contains the new task
        const tasks = await getFixupTasks()
        // Tasks length should be larger than 0
        assert.ok(tasks.length > 0)

        // Check the chat transcript to make sure text contains the fixup response
        await waitUntil(async () => ((await getTranscript(1)).text || '').includes('<title>'))
    })
})
