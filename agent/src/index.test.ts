import assert from 'assert'
import { execSync, spawn } from 'child_process'
import path from 'path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Uri } from 'vscode'

import { ChatMessage } from '@sourcegraph/cody-shared'
import { RecipeID } from '@sourcegraph/cody-shared/src/chat/recipes/recipe'

import { MessageHandler } from './jsonrpc-alias'
import { ClientInfo } from './protocol-alias'

export class TestClient extends MessageHandler {
    constructor() {
        super()
        this.registerNotification('debug/message', message => {
            console.log(`${message.channel}: ${message.message}`)
        })
    }
    public async handshake(clientInfo: ClientInfo) {
        const info = await this.request('initialize', clientInfo)
        this.notify('initialized', null)
        return info
    }

    public listRecipes() {
        return this.request('recipes/list', null)
    }

    public async executeRecipe(id: RecipeID, humanChatInput: string) {
        return this.request('recipes/execute', {
            id,
            humanChatInput,
        })
    }

    public async shutdownAndExit() {
        await this.request('shutdown', null)
        this.notify('exit', null)
    }
}

const dotcom = 'https://sourcegraph.com'
const clientInfo: ClientInfo = {
    name: 'test-client',
    version: 'v1',
    workspaceRootUri: 'file:///path/to/foo',
    workspaceRootPath: '/path/to/foo',
    extensionConfiguration: {
        anonymousUserID: 'abcde1234',
        accessToken: process.env.SRC_ACCESS_TOKEN ?? 'sgp_RRRRRRRREEEEEEEDDDDDDAAACCCCCTEEEEEEEDDD',
        serverEndpoint: dotcom,
        customHeaders: {},
        autocompleteAdvancedProvider: 'anthropic',
        autocompleteAdvancedAccessToken: '',
        autocompleteAdvancedServerEndpoint: '',
        debug: false,
        verboseDebug: false,
    },
}

const cwd = process.cwd()
const agentDir = path.basename(cwd) === 'agent' ? cwd : path.join(cwd, 'agent')
const recordingDirectory = path.join(agentDir, 'recordings')
const agentScript = path.join(agentDir, 'dist', 'index.js')

describe('Agent', () => {
    // Uncomment the code block below to disable agent tests. Feel free to do this to unblock
    // merging a PR if the agent tests are failing. If you decide to uncomment this block, please
    // post in #wg-cody-agent to let the team know the tests have been disabled so that we can
    // investigate the problem and get the passing again.
    // if (process.env.SRC_ACCESS_TOKEN === undefined || process.env.SRC_ENDPOINT === undefined) {
    //     it('no-op test because SRC_ACCESS_TOKEN is not set. To actually run the Cody Agent tests, set the environment variables SRC_ENDPOINT and SRC_ACCESS_TOKEN', () => {})
    //     return
    // }

    if (process.env.VITEST_ONLY && !process.env.VITEST_ONLY.includes('Agent')) {
        it('Agent tests are skipped due to VITEST_ONLY environment variable', () => {})
        return
    }
    const client = new TestClient()

    // Bundle the agent. When running `pnpm run test`, vitest doesn't re-run this step.
    execSync('pnpm run build', { cwd: agentDir, stdio: 'inherit' })

    if (process.env.CODY_RECORDING_MODE === 'record') {
        console.log('Because CODY_RECORDING_MODE=record, validating that you are authenticated to sourcegraph.com')
        execSync('src login', { stdio: 'inherit' })
        assert.strictEqual(
            process.env.SRC_ENDPOINT,
            clientInfo.extensionConfiguration?.serverEndpoint,
            'SRC_ENDPOINT must match clientInfo.extensionConfiguration.serverEndpoint'
        )
    }
    const agentProcess = spawn('node', ['--enable-source-maps', agentScript, 'jsonrpc'], {
        stdio: 'pipe',
        cwd: agentDir,
        env: {
            CODY_SHIM_TESTING: 'true',
            CODY_RECORDING_MODE: 'replay', // can be overwritten with process.env.CODY_RECORDING_MODE
            CODY_RECORDING_DIRECTORY: recordingDirectory,
            CODY_RECORDING_NAME: 'FullConfig',
            ...process.env,
        },
    })

    client.connectProcess(agentProcess)

    // Initialize inside beforeAll so that subsequent tests are skipped if initialization fails.
    beforeAll(async () => {
        const serverInfo = await client.handshake(clientInfo)
        assert.deepStrictEqual(serverInfo.name, 'cody-agent', 'Agent should be cody-agent')
    })

    it('handles config changes correctly', () => {
        // Send two config change notifications because this is what the
        // JetBrains client does and there was a bug where everything worked
        // fine as long as we didn't send the second unauthenticated config
        // change.
        client.notify('extensionConfiguration/didChange', {
            anonymousUserID: 'abcde1234',
            accessToken: '',
            serverEndpoint: 'https://sourcegraph.com/',
            customHeaders: {},
        })
        client.notify('extensionConfiguration/didChange', {
            anonymousUserID: 'abcde1234',
            accessToken: clientInfo.extensionConfiguration?.accessToken ?? 'invalid',
            serverEndpoint: clientInfo.extensionConfiguration?.serverEndpoint ?? dotcom,
            customHeaders: {},
        })
    })

    it('lists recipes correctly', async () => {
        const recipes = await client.listRecipes()
        assert.equal(9, recipes.length, JSON.stringify(recipes))
    })

    it('returns non-empty autocomplete', async () => {
        const filePath = '/path/to/foo/file.ts'
        const uri = Uri.file(filePath)
        const content = 'function sum(a: number, b: number) {\n    \n}'
        client.notify('textDocument/didOpen', {
            uri: uri.toString(),
            content,
            selection: { start: { line: 1, character: 0 }, end: { line: 1, character: 0 } },
        })
        const completions = await client.request('autocomplete/execute', {
            uri: uri.toString(),
            position: { line: 1, character: 3 },
            triggerKind: 'Invoke',
        })
        const texts = completions.items.map(item => item.insertText)
        expect(completions.items.length).toBeGreaterThan(0)
        expect(texts).toMatchInlineSnapshot(`
          [
            "   return a + b;",
          ]
        `)
        client.notify('autocomplete/completionAccepted', { completionID: completions.items[0].id })
    }, 10_000)

    const messages: ChatMessage[] = []
    const streamingChatMessages = new Promise<void>((resolve, reject) => {
        let isResolved = false
        client.registerNotification('chat/updateMessageInProgress', msg => {
            if (msg === null) {
                if (isResolved) {
                    return
                }
                isResolved = true
                if (messages.length > 0) {
                    resolve()
                } else {
                    reject(new Error('Received null message before non-null message'))
                }
            } else {
                messages.push(msg)
            }
        })
    })

    it.skip('allows us to execute recipes properly', async () => {
        await client.executeRecipe('chat-question', 'How do I implement sum in JavaScript?')
    }, 20_000)

    // Timeout is 100ms because we await on `recipes/execute` in the previous test
    it.skip('executing a recipe sends chat/updateMessageInProgress notifications', async () => {
        await streamingChatMessages
        const actual = messages.at(-1)
        if (actual?.text) {
            // trim trailing whitespace from the autocomplete result that Prettier removes causing the inline snapshot assertion to fail.
            actual.text = actual.text
                .split('\n')
                .map(line => line.trimEnd())
                .join('\n')
        }
        expect(actual).toMatchInlineSnapshot(`
          {
            "contextFiles": [],
            "preciseContext": [],
            "speaker": "assistant",
            "text": " Here is how to implement a sum function in JavaScript:

          \`\`\`js
          function sum(arr) {
            let total = 0;
            for (let i = 0; i < arr.length; i++) {
              total += arr[i];
            }
            return total;
          }
          \`\`\`

          To use:

          \`\`\`js
          const numbers = [1, 2, 3, 4, 5];

          const result = sum(numbers);
          // result = 15
          \`\`\`

          This implements a simple sum function that takes an array of numbers, iterates through the array, and returns the total sum of the numbers.",
          }
        `)
    }, 100)

    // TODO Fix test - fails intermittently on macOS on Github Actions
    // e.g. https://github.com/sourcegraph/cody/actions/runs/7191096335/job/19585263054#step:9:1723
    it.skip('allows us to cancel chat', async () => {
        setTimeout(() => client.notify('$/cancelRequest', { id: client.id - 1 }), 300)
        await client.executeRecipe('chat-question', 'How do I implement sum?')
    }, 600)

    afterAll(async () => {
        await client.shutdownAndExit()
        // Long timeout because to allow Polly.js to persist HTTP recordings
    }, 20_000)
})
