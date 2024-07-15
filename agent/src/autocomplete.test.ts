import path from 'node:path'

import { describe, expect, it } from 'vitest'
import { TESTING_CREDENTIALS } from '../../vscode/src/testutils/testing-credentials'
import { TestClient } from './TestClient'
import { TestWorkspace } from './TestWorkspace'

describe('Autocomplete', () => {
    const workspace = new TestWorkspace(path.join(__dirname, '__tests__', 'autocomplete'))
    const client = TestClient.create({
        workspaceRootUri: workspace.rootUri,
        name: 'autocomplete',
        credentials: TESTING_CREDENTIALS.dotcom,
    })

    it('autocomplete/execute (non-empty result)', async () => {
        const uri = workspace.file('src', 'sum.ts')
        await client.openFile(uri)
        const completions = await client.request('autocomplete/execute', {
            uri: uri.toString(),
            position: { line: 1, character: 4 },
            triggerKind: 'Invoke',
        })
        const texts = completions.items.map(item => item.insertText)
        expect(completions.items.length).toBeGreaterThan(0)
        expect(texts).toMatchInlineSnapshot(
            `
          [
            "    return a + b;",
          ]
        `
        )
        client.notify('autocomplete/completionAccepted', {
            completionID: completions.items[0].id,
        })
    }, 10_000)

    it('autocomplete/execute multiline(non-empty result)', async () => {
        const uri = workspace.file('src', 'bubbleSort.ts')
        await client.openFile(uri)
        const completions = await client.request('autocomplete/execute', {
            uri: uri.toString(),
            position: { line: 1, character: 4 },
            triggerKind: 'Invoke',
        })
        const texts = completions.items.map(item => item.insertText)
        expect(completions.items.length).toBeGreaterThan(0)
        expect(texts).toMatchInlineSnapshot(
            `
          [
            "    for (let i = 0; i < nums.length; i++) {
                  for (let j = 0; j < nums.length - 1; j++) {
                      if (nums[j] > nums[j + 1]) {
                          [nums[j], nums[j + 1]] = [nums[j + 1], nums[j]]
                      }
                  }
              }",
          ]
        `
        )
        client.notify('autocomplete/completionAccepted', {
            completionID: completions.items[0].id,
        })
    }, 10_000)
})
