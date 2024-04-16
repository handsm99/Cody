import assert from 'node:assert'
import { execSync } from 'node:child_process'
import fspromises from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as vscode from 'vscode'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { ModelUsage, isWindows } from '@sourcegraph/cody-shared'

import { URI } from 'vscode-uri'
import { TestClient, asTranscriptMessage } from './TestClient'
import { decodeURIs } from './decodeURIs'
import { isNode16 } from './isNode16'
import type {
    CustomChatCommandResult,
    CustomEditCommandResult,
    EditTask,
    Requests,
} from './protocol-alias'

const explainPollyError = `

    ===================================================[ NOTICE ]=======================================================
    If you get PollyError or unexpected diff, you might need to update recordings to match your changes.
    Run the following commands locally to update the recordings:

      export SRC_ACCESS_TOKEN=YOUR_TOKEN
      export SRC_ACCESS_TOKEN_WITH_RATE_LIMIT=RATE_LIMITED_TOKEN # see https://sourcegraph.slack.com/archives/C059N5FRYG3/p1702990080820699
      export SRC_ENDPOINT=https://sourcegraph.com
      pnpm update-agent-recordings
      # Press 'u' to update the snapshots if the new behavior makes sense. It's
      # normal that the LLM returns minor changes to the wording.
      git commit -am "Update agent recordings"


    More details in https://github.com/sourcegraph/cody/tree/main/agent#updating-the-polly-http-recordings
    ====================================================================================================================

    `

const prototypePath = path.join(__dirname, '__tests__', 'example-ts')
const workspaceRootUri = vscode.Uri.file(path.join(os.tmpdir(), 'cody-vscode-shim-test'))
const workspaceRootPath = workspaceRootUri.fsPath

const mayRecord =
    process.env.CODY_RECORDING_MODE === 'record' || process.env.CODY_RECORD_IF_MISSING === 'true'

describe('Agent', () => {
    const dotcom = 'https://sourcegraph.com'
    if (mayRecord) {
        execSync('src login', { stdio: 'inherit' })
        assert.strictEqual(
            process.env.SRC_ENDPOINT,
            dotcom,
            'SRC_ENDPOINT must be https://sourcegraph.com'
        )
    }

    if (process.env.VITEST_ONLY && !process.env.VITEST_ONLY.includes('Agent')) {
        it('Agent tests are skipped due to VITEST_ONLY environment variable', () => {})
        return
    }

    const client = new TestClient({
        name: 'defaultClient',
        // The redacted ID below is copy-pasted from the recording file and
        // needs to be updated whenever we change the underlying access token.
        // We can't return a random string here because then Polly won't be able
        // to associate the HTTP requests between record mode and replay mode.
        accessToken:
            process.env.SRC_ACCESS_TOKEN ??
            'REDACTED_b09f01644a4261b32aa2ee4aea4f279ba69a57cff389f9b119b5265e913c0ea4',
    })

    // Bundle the agent. When running `pnpm run test`, vitest doesn't re-run this step.
    //
    // ⚠️ If this line fails when running unit tests, chances are that the error is being swallowed.
    // To see the full error, run this file in isolation:
    //
    //   pnpm test agent/src/index.test.ts
    execSync('pnpm run build:agent', {
        cwd: client.getAgentDir(),
        stdio: 'inherit',
    })

    // Initialize inside beforeAll so that subsequent tests are skipped if initialization fails.
    beforeAll(async () => {
        await fspromises.mkdir(workspaceRootPath, { recursive: true })
        await fspromises.cp(prototypePath, workspaceRootPath, {
            recursive: true,
        })
        const serverInfo = await client.initialize({
            serverEndpoint: 'https://sourcegraph.com',
            // Initialization should always succeed even if authentication fails
            // because otherwise clients need to restart the process to test
            // with a new access token.
            accessToken: 'sgp_INVALIDACCESSTOK_ENTHISSHOULDFAILEEEEEEEEEEEEEEEEEEEEEEE2',
        })
        expect(serverInfo?.authStatus?.isLoggedIn).toBeFalsy()

        // Log in so test cases are authenticated by default
        const valid = await client.request('extensionConfiguration/change', {
            ...client.info.extensionConfiguration,
            anonymousUserID: 'abcde1234',
            accessToken: client.info.extensionConfiguration?.accessToken ?? 'invalid',
            serverEndpoint: client.info.extensionConfiguration?.serverEndpoint ?? dotcom,
            customHeaders: {},
        })
        expect(valid?.isLoggedIn).toBeTruthy()

        // Confirm .cody/ignore is active at start up
        const codyIgnore = await client.request('check/isCodyIgnoredFile', {
            urls: [ignoredPath],
        })
        expect(codyIgnore).toBeTruthy()
    }, 10_000)

    beforeEach(async () => {
        await client.request('testing/reset', null)
    })

    const sumPath = path.join(workspaceRootPath, 'src', 'sum.ts')
    const sumUri = vscode.Uri.file(sumPath)
    const animalPath = path.join(workspaceRootPath, 'src', 'animal.ts')
    const animalUri = vscode.Uri.file(animalPath)
    const squirrelPath = path.join(workspaceRootPath, 'src', 'squirrel.ts')
    const squirrelUri = vscode.Uri.file(squirrelPath)
    const multipleSelections = path.join(workspaceRootPath, 'src', 'multiple-selections.ts')
    const multipleSelectionsUri = vscode.Uri.file(multipleSelections)

    // Context files ends with 'Ignored.ts' will be excluded by .cody/ignore
    const ignoredPath = path.join(workspaceRootPath, 'src', 'isIgnored.ts')
    const ignoredUri = vscode.Uri.file(ignoredPath)

    it('extensionConfiguration/change (handle errors)', async () => {
        // Send two config change notifications because this is what the
        // JetBrains client does and there was a bug where everything worked
        // fine as long as we didn't send the second unauthenticated config
        // change.
        const invalid = await client.request('extensionConfiguration/change', {
            ...client.info.extensionConfiguration,
            anonymousUserID: 'abcde1234',
            // Redacted format of an invalid access token (just random string). Tests fail in replay mode
            // if we don't use the redacted format here.
            accessToken: 'REDACTED_0ba08837494d00e3943c46999589eb29a210ba8063f084fff511c8e4d1503909',
            serverEndpoint: 'https://sourcegraph.com/',
            customHeaders: {},
        })
        expect(invalid?.isLoggedIn).toBeFalsy()
        const valid = await client.request('extensionConfiguration/change', {
            ...client.info.extensionConfiguration,
            anonymousUserID: 'abcde1234',
            accessToken: client.info.extensionConfiguration?.accessToken ?? 'invalid',
            serverEndpoint: client.info.extensionConfiguration?.serverEndpoint ?? dotcom,
            customHeaders: {},
        })
        expect(valid?.isLoggedIn).toBeTruthy()

        // Please don't update the recordings to use a different account without consulting #wg-cody-agent.
        // When changing an account, you also need to update the REDACTED_ hash above.
        //
        // To update the recordings with the correct account, run the following command
        // from the root of this repository:
        //
        //    source agent/scripts/export-cody-http-recording-tokens.sh
        //
        // If you don't have access to this private file then you need to ask
        expect(valid?.username).toStrictEqual('sourcegraphbot9k-fnwmu')
    }, 10_000)

    describe('Autocomplete', () => {
        it('autocomplete/execute (non-empty result)', async () => {
            await client.openFile(sumUri)
            const completions = await client.request('autocomplete/execute', {
                uri: sumUri.toString(),
                position: { line: 1, character: 3 },
                triggerKind: 'Invoke',
            })
            const texts = completions.items.map(item => item.insertText)
            expect(completions.items.length).toBeGreaterThan(0)
            expect(texts).toMatchInlineSnapshot(
                `
          [
            "   return a + b;",
          ]
        `
            )
            client.notify('autocomplete/completionAccepted', {
                completionID: completions.items[0].id,
            })
        }, 10_000)
    })

    it('graphql/getCurrentUserCodySubscription', async () => {
        const currentUserCodySubscription = await client.request(
            'graphql/getCurrentUserCodySubscription',
            null
        )
        expect(currentUserCodySubscription).toMatchInlineSnapshot(`
          {
            "applyProRateLimits": true,
            "currentPeriodEndAt": "2024-04-14T22:11:32Z",
            "currentPeriodStartAt": "2024-03-14T22:11:32Z",
            "plan": "PRO",
            "status": "ACTIVE",
          }
        `)
    }, 10_000)

    describe('Chat', () => {
        it('chat/submitMessage (short message)', async () => {
            const lastMessage = await client.sendSingleMessageToNewChat('Hello!')
            expect(lastMessage).toMatchInlineSnapshot(
                `
              {
                "speaker": "assistant",
                "text": "Hello! I'm Claude, an AI assistant created by Anthropic. It's nice to meet you. How can I help you today?",
              }
            `
            )
        }, 30_000)

        it('chat/submitMessage (long message)', async () => {
            const lastMessage = await client.sendSingleMessageToNewChat(
                'Generate simple hello world function in java!'
            )
            const trimmedMessage = trimEndOfLine(lastMessage?.text ?? '')
            expect(trimmedMessage).toMatchInlineSnapshot(
                `
              "Sure, here's a simple "Hello World" function in Java:

              \`\`\`java
              public class HelloWorld {
                  public static void main(String[] args) {
                      System.out.println("Hello World!");
                  }
              }
              \`\`\`

              To explain:

              1. \`public class HelloWorld { ... }\` defines a new class named \`HelloWorld\`.
              2. \`public static void main(String[] args)\` is the main method that serves as the entry point of the Java program.
              3. \`System.out.println("Hello World!");\` prints the string "Hello World!" to the console.

              To run this program, you'll need to save it in a file with a \`.java\` extension (e.g., \`HelloWorld.java\`), compile it using the Java compiler (\`javac HelloWorld.java\`), and then run the compiled bytecode with the Java Virtual Machine (\`java HelloWorld\`)."
            `,
                explainPollyError
            )
        }, 30_000)

        it('chat/restore', async () => {
            // Step 1: create a chat session where I share my name.
            const id1 = await client.request('chat/new', null)
            const reply1 = asTranscriptMessage(
                await client.request('chat/submitMessage', {
                    id: id1,
                    message: {
                        command: 'submit',
                        text: 'My name is Lars Monsen',
                        submitType: 'user',
                        addEnhancedContext: false,
                    },
                })
            )

            // Step 2: restore a new chat session with a transcript including my name, and
            //  and assert that it can retrieve my name from the transcript.
            const {
                models: [model],
            } = await client.request('chat/models', { modelUsage: ModelUsage.Chat })

            const id2 = await client.request('chat/restore', {
                modelID: model.model,
                messages: reply1.messages,
                chatID: new Date().toISOString(), // Create new Chat ID with a different timestamp
            })
            const reply2 = asTranscriptMessage(
                await client.request('chat/submitMessage', {
                    id: id2,
                    message: {
                        command: 'submit',
                        text: 'What is my name?',
                        submitType: 'user',
                        addEnhancedContext: false,
                    },
                })
            )
            expect(reply2.messages.at(-1)?.text).toMatchInlineSnapshot(
                `"You told me your name is Lars Monsen."`,
                explainPollyError
            )
        }, 30_000)

        it('chat/restore (With null model)', async () => {
            // Step 1: Create a chat session asking what model is used.
            const id1 = await client.request('chat/new', null)
            const reply1 = asTranscriptMessage(
                await client.request('chat/submitMessage', {
                    id: id1,
                    message: {
                        command: 'submit',
                        text: 'What model are you?',
                        submitType: 'user',
                        addEnhancedContext: false,
                    },
                })
            )

            // Step 2: Restoring chat session without model.
            const id2 = await client.request('chat/restore', {
                messages: reply1.messages,
                chatID: new Date().toISOString(), // Create new Chat ID with a different timestamp
            })
            // Step 2: Asking again what model is used
            const reply2 = asTranscriptMessage(
                await client.request('chat/submitMessage', {
                    id: id2,
                    message: {
                        command: 'submit',
                        text: 'What model are you?',
                        submitType: 'user',
                        addEnhancedContext: false,
                    },
                })
            )
            expect(reply2.messages.at(-1)?.text).toMatchInlineSnapshot(
                `"I'm afraid I don't know the specific details of what model architecture or training approach was used to create me. That information hasn't been shared publicly by the Anthropic team that developed me. What I can say is that I am a large language model focused on coding assistance and technical topics. But the exact model name or type is not something I'm aware of. Please let me know if there are any other ways I can try to help!"`,
                explainPollyError
            )
        }, 30_000)

        it('chat/restore (multiple) & export', async () => {
            const date = new Date(1997, 7, 2, 12, 0, 0, 0)

            // Step 1: Restore multiple chats
            const NUMBER_OF_CHATS_TO_RESTORE = 300
            for (let i = 0; i < NUMBER_OF_CHATS_TO_RESTORE; i++) {
                const myDate = new Date(date.getTime() + i * 60 * 1000)
                await client.request('chat/restore', {
                    modelID: 'anthropic/claude-2.0',
                    messages: [
                        { text: 'What model are you?', speaker: 'human', contextFiles: [] },
                        {
                            text: " I'm Claude, an AI assistant created by Anthropic.",
                            speaker: 'assistant',
                        },
                    ],
                    chatID: myDate.toISOString(), // Create new Chat ID with a different timestamp
                })
            }

            // Step 2: export history
            const chatHistory = await client.request('chat/export', null)

            chatHistory.forEach((result, index) => {
                const myDate = new Date(date.getTime() + index * 60 * 1000).toISOString()

                expect(result.transcript).toMatchInlineSnapshot(`{
  "chatModel": "anthropic/claude-2.0",
  "id": "${myDate}",
  "interactions": [
    {
      "assistantMessage": {
        "speaker": "assistant",
        "text": " I'm Claude, an AI assistant created by Anthropic.",
      },
      "humanMessage": {
        "contextFiles": [],
        "speaker": "human",
        "text": "What model are you?",
      },
    },
  ],
  "lastInteractionTimestamp": "${myDate}",
}`)
            })
        }, 30_000)

        it('chat/submitMessage (addEnhancedContext: true)', async () => {
            await client.openFile(animalUri)
            await client.request('command/execute', {
                command: 'cody.search.index-update',
            })
            const lastMessage = await client.sendSingleMessageToNewChat(
                'Write a class Dog that implements the Animal interface in my workspace. Show the code only, no explanation needed.',
                {
                    addEnhancedContext: true,
                }
            )
            // TODO: make this test return a TypeScript implementation of
            // `animal.ts`. It currently doesn't do this because the workspace root
            // is not a git directory and symf reports some git-related error.
            expect(trimEndOfLine(lastMessage?.text ?? '')).toMatchInlineSnapshot(
                `
              "\`\`\`typescript
              class Dog implements Animal {
                name: string;
                isMammal: boolean = true;

                constructor(name: string) {
                  this.name = name;
                }

                makeAnimalSound(): string {
                  return "Woof!";
                }
              }
              \`\`\`"
            `,
                explainPollyError
            )
        }, 30_000)

        it('chat/submitMessage (addEnhancedContext: true, squirrel test)', async () => {
            await client.openFile(squirrelUri)
            await client.request('command/execute', {
                command: 'cody.search.index-update',
            })
            const { lastMessage, transcript } =
                await client.sendSingleMessageToNewChatWithFullTranscript('What is Squirrel?', {
                    addEnhancedContext: true,
                })
            expect(lastMessage?.text?.toLocaleLowerCase() ?? '').includes('code nav')
            expect(lastMessage?.text?.toLocaleLowerCase() ?? '').includes('sourcegraph')
            decodeURIs(transcript)
            const contextFiles = transcript.messages.flatMap(m => m.contextFiles ?? [])
            expect(contextFiles).not.toHaveLength(0)
            expect(contextFiles.map(file => file.uri.toString())).includes(squirrelUri.toString())
        }, 30_000)

        it('webview/receiveMessage (type: chatModel)', async () => {
            const id = await client.request('chat/new', null)
            {
                await client.setChatModel(id, 'openai/gpt-3.5-turbo')
                const lastMessage = await client.sendMessage(id, 'what color is the sky?')
                expect(lastMessage?.text?.toLocaleLowerCase().includes('blue')).toBeTruthy()
            }
        }, 30_000)

        it('webview/receiveMessage (type: reset)', async () => {
            const id = await client.request('chat/new', null)
            await client.setChatModel(id, 'fireworks/accounts/fireworks/models/mixtral-8x7b-instruct')
            await client.sendMessage(
                id,
                'The magic word is "kramer". If I say the magic word, respond with a single word: "quone".'
            )
            {
                const lastMessage = await client.sendMessage(id, 'kramer')
                expect(lastMessage?.text?.toLocaleLowerCase().includes('quone')).toBeTruthy()
            }
            await client.reset(id)
            {
                const lastMessage = await client.sendMessage(id, 'kramer')
                expect(lastMessage?.text?.toLocaleLowerCase().includes('quone')).toBeFalsy()
            }
        })

        // Tests for edits would fail on Node 16 (ubuntu16) possibly due to an API that is not supported
        describe.skipIf(isNode16())('chat/editMessage', () => {
            it(
                'edits the last human chat message',
                async () => {
                    const id = await client.request('chat/new', null)
                    await client.setChatModel(
                        id,
                        'fireworks/accounts/fireworks/models/mixtral-8x7b-instruct'
                    )
                    await client.sendMessage(
                        id,
                        'The magic word is "kramer". If I say the magic word, respond with a single word: "quone".'
                    )
                    await client.editMessage(
                        id,
                        'Another magic word is "georgey". If I say the magic word, respond with a single word: "festivus".'
                    )
                    {
                        const lastMessage = await client.sendMessage(id, 'kramer')
                        expect(lastMessage?.text?.toLocaleLowerCase().includes('quone')).toBeFalsy()
                    }
                    {
                        const lastMessage = await client.sendMessage(id, 'georgey')
                        expect(lastMessage?.text?.toLocaleLowerCase().includes('festivus')).toBeTruthy()
                    }
                },
                { timeout: mayRecord ? 10_000 : undefined }
            )

            it('edits messages by index', async () => {
                const id = await client.request('chat/new', null)
                await client.setChatModel(
                    id,
                    'fireworks/accounts/fireworks/models/mixtral-8x7b-instruct'
                )
                // edits by index replaces message at index, and erases all subsequent messages
                await client.sendMessage(
                    id,
                    'I have a turtle named "potter", reply single "ok" if you understand.'
                )
                await client.sendMessage(
                    id,
                    'I have a bird named "skywalker", reply single "ok" if you understand.'
                )
                await client.sendMessage(
                    id,
                    'I have a dog named "happy", reply single "ok" if you understand.'
                )
                await client.editMessage(
                    id,
                    'I have a tiger named "zorro", reply single "ok" if you understand',
                    { index: 2 }
                )
                {
                    const lastMessage = await client.sendMessage(id, 'What pets do I have?')
                    const answer = lastMessage?.text?.toLocaleLowerCase()
                    expect(answer?.includes('turtle')).toBeTruthy()
                    expect(answer?.includes('tiger')).toBeTruthy()
                    expect(answer?.includes('bird')).toBeFalsy()
                    expect(answer?.includes('dog')).toBeFalsy()
                }
            }, 30_000)
        })
    })

    describe('Cody Ignore', () => {
        beforeAll(async () => {
            // Make sure Cody ignore config exists and works
            const codyIgnoreConfig = vscode.Uri.file(path.join(workspaceRootPath, '.cody/ignore'))
            await client.openFile(codyIgnoreConfig)
            const codyIgnoreConfigFile = client.workspace.getDocument(codyIgnoreConfig)
            expect(codyIgnoreConfigFile?.content).toBeDefined()

            const result = await client.request('check/isCodyIgnoredFile', {
                urls: [ignoredPath],
            })
            expect(result).toBeTruthy()
        }, 10_000)

        it('autocomplete/execute on ignored file', async () => {
            await client.openFile(ignoredUri)
            const completions = await client.request('autocomplete/execute', {
                uri: ignoredUri.toString(),
                position: { line: 1, character: 3 },
                triggerKind: 'Invoke',
            })
            const texts = completions.items.map(item => item.insertText)
            expect(completions.items.length).toBe(0)
            expect(texts).toMatchInlineSnapshot(
                `
              []
            `
            )
        }, 10_000)

        it('chat/submitMessage on an ignored file (addEnhancedContext: true)', async () => {
            await client.openFile(ignoredUri)
            await client.request('command/execute', {
                command: 'cody.search.index-update',
            })
            const { transcript } = await client.sendSingleMessageToNewChatWithFullTranscript(
                'What files contain SELECTION_START?',
                { addEnhancedContext: true }
            )
            decodeURIs(transcript)
            const contextFiles = transcript.messages.flatMap(m => m.contextFiles ?? [])
            // Current file which is ignored, should not be included in context files
            expect(contextFiles.find(f => f.uri.toString() === ignoredUri.toString())).toBeUndefined()
            // Ignored file should not be included in context files
            const contextFilesUrls = contextFiles.map(f => f.uri?.path)
            const result = await client.request('check/isCodyIgnoredFile', {
                urls: contextFilesUrls,
            })
            expect(result).toBeFalsy()
            // Files that are not ignored should be used as context files
            expect(contextFiles.length).toBeGreaterThan(0)
        }, 30_000)

        it('chat/submitMessage on an ignored file (addEnhancedContext: false)', async () => {
            await client.openFile(ignoredUri)
            await client.request('command/execute', {
                command: 'cody.search.index-update',
            })
            const { transcript } = await client.sendSingleMessageToNewChatWithFullTranscript(
                'Which file is the isIgnoredByCody functions defined?',
                { addEnhancedContext: false }
            )
            decodeURIs(transcript)
            const contextFiles = transcript.messages.flatMap(m => m.contextFiles ?? [])
            const contextUrls = contextFiles.map(f => f.uri?.path)
            // Current file which is ignored, should not be included in context files
            expect(contextUrls.find(uri => uri === ignoredUri.toString())).toBeUndefined()
            // Since no enhanced context is requested, no context files should be included
            expect(contextFiles.length).toBe(0)
            // Ignored file should not be included in context files
            const result = await client.request('check/isCodyIgnoredFile', {
                urls: contextUrls,
            })
            expect(result).toBeFalsy()
        }, 30_000)

        it('chat command on an ignored file', async () => {
            await client.request('command/execute', {
                command: 'cody.search.index-update',
            })
            await client.openFile(ignoredUri)
            // Cannot execute commands in an ignored files, so this should throw error
            await client.request('commands/explain', null).catch(err => {
                expect(err).toBeDefined()
            })
        }, 30_000)

        it('inline edit on an ignored file', async () => {
            await client.request('command/execute', {
                command: 'cody.search.index-update',
            })
            await client.openFile(ignoredUri, { removeCursor: false })
            await client.request('editCommands/document', null).catch(err => {
                expect(err).toBeDefined()
            })
        })

        it('ignore rule is not case sensitive', async () => {
            const alsoIgnoredPath = path.join(workspaceRootPath, 'src/is_ignored.ts')
            const result = await client.request('check/isCodyIgnoredFile', {
                urls: [alsoIgnoredPath],
            })
            expect(result).toBeTruthy()
        })

        afterAll(async () => {
            // Makes sure cody ignore is still active after tests
            // as it should stay active for each workspace session.
            const result = await client.request('check/isCodyIgnoredFile', {
                urls: [ignoredPath],
            })
            expect(result).toBeTruthy()

            // Check the network requests to ensure no requests include context from ignored files
            const { requests } = await client.request('testing/networkRequests', null)

            const groupedMsgs = []
            for (const req of requests) {
                // Get the messages from the request body
                const messages = JSON.parse(req.body || '{}')?.messages as {
                    speaker: string
                    text: string
                }[]
                // Filter out messages that do not include context snippets.
                const text = messages
                    ?.filter(m => m.speaker === 'human' && m.text !== undefined)
                    ?.map(m => m.text)

                groupedMsgs.push(...(text ?? []))
            }
            expect(groupedMsgs.length).toBeGreaterThan(0)

            // Join all the string from each groupedMsgs[] together into
            // one block of text, and then check if it contains the ignored file name
            // to confirm context from the ignored file was not sent to the server.
            const groupedText = groupedMsgs.flat().join(' ')
            expect(groupedText).not.includes('src/isIgnored.ts')

            // Confirm the grouped text is valid by checking for known
            // context file names from the test.
            expect(groupedText).includes('src/squirrel.ts')
        }, 10_000)
    })

    describe('Text documents', () => {
        it('chat/submitMessage (understands the selected text)', async () => {
            await client.request('command/execute', {
                command: 'cody.search.index-update',
            })
            await client.openFile(multipleSelectionsUri)
            await client.changeFile(multipleSelectionsUri)
            await client.changeFile(multipleSelectionsUri, {
                selectionName: 'SELECTION_2',
            })
            const reply = await client.sendSingleMessageToNewChat(
                'What is the name of the function that I have selected? Only answer with the name of the function, nothing else',
                { addEnhancedContext: true }
            )
            expect(reply?.text?.trim()).includes('anotherFunction')
            expect(reply?.text?.trim()).not.includes('inner')
            await client.changeFile(multipleSelectionsUri)
            const reply2 = await client.sendSingleMessageToNewChat(
                'What is the name of the function that I have selected? Only answer with the name of the function, nothing else',
                { addEnhancedContext: true }
            )
            expect(reply2?.text?.trim()).includes('inner')
            expect(reply2?.text?.trim()).not.includes('anotherFunction')
        }, 20_000)
    })

    function checkDocumentCommand(
        documentClient: TestClient,
        name: string,
        filename: string,
        assertion: (obtained: string) => void
    ): void {
        it(
            name,
            async () => {
                await documentClient.request('command/execute', {
                    command: 'cody.search.index-update',
                })
                const uri = vscode.Uri.file(path.join(workspaceRootPath, 'src', filename))
                await documentClient.openFile(uri, { removeCursor: false })
                const task = await documentClient.request('editCommands/document', null)
                await documentClient.taskHasReachedAppliedPhase(task)
                const lenses = documentClient.codeLenses.get(uri.toString()) ?? []
                expect(lenses).toHaveLength(0) // Code lenses are now handled client side

                await documentClient.request('editTask/accept', { id: task.id })
                const newContent = documentClient.workspace.getDocument(uri)?.content
                assertion(trimEndOfLine(newContent))
            },
            20_000
        )
    }

    describe('Commands', () => {
        it('commands/explain', async () => {
            await client.request('command/execute', {
                command: 'cody.search.index-update',
            })
            await client.openFile(animalUri)
            const freshChatID = await client.request('chat/new', null)
            const id = await client.request('commands/explain', null)

            // Assert that the server is not using IDs between `chat/new` and
            // `chat/explain`. In VS Code, we try to reuse empty webview panels,
            // which is undesireable for agent clients.
            expect(id).not.toStrictEqual(freshChatID)

            const lastMessage = await client.firstNonEmptyTranscript(id)
            expect(trimEndOfLine(lastMessage.messages.at(-1)?.text ?? '')).toMatchInlineSnapshot(
                `
              "The code \`@src/animal.ts:1-6\` defines an interface called \`Animal\` in TypeScript. An interface is a way to define the structure of an object in TypeScript. It acts as a blueprint or contract that specifies the properties and methods that other objects must have to be considered an \`Animal\`.

              This particular \`Animal\` interface does not take any direct inputs. Instead, it outlines the requirements for any object that wants to be considered an \`Animal\`. Specifically, it states that an \`Animal\` must have the following:

              1. A property called \`name\` of type \`string\`.
              2. A method called \`makeAnimalSound()\` that returns a \`string\`.
              3. A property called \`isMammal\` of type \`boolean\`.

              The interface itself does not produce any output. It merely serves as a contract or set of rules that other objects must follow to be considered an \`Animal\`. When you create an object that implements this interface, you are essentially promising that the object will have the specified properties and methods.

              The purpose of this code is to provide a clear and consistent structure for representing animals in your TypeScript codebase. By defining the \`Animal\` interface, you ensure that any object representing an animal will have a \`name\`, a way to make a sound (\`makeAnimalSound()\`), and a flag indicating whether it is a mammal (\`isMammal\`). This consistency can help prevent bugs and make your code more maintainable, as you can rely on the fact that all \`Animal\` objects will have these properties and methods.

              While the interface itself does not contain any logic or algorithms, it serves as a blueprint that other parts of your codebase can rely on. For example, you might have a function that takes an \`Animal\` object as input and performs some operations based on the assumption that the object has a \`name\`, a \`makeAnimalSound()\` method, and an \`isMammal\` property."
            `,
                explainPollyError
            )
        }, 30_000)

        // This test seems extra sensitive on Node v16 for some reason.
        it.skipIf(isNode16() || isWindows())(
            'commands/test',
            async () => {
                await client.request('command/execute', {
                    command: 'cody.search.index-update',
                })
                await client.openFile(animalUri)
                const id = await client.request('commands/test', null)
                const lastMessage = await client.firstNonEmptyTranscript(id)
                expect(trimEndOfLine(lastMessage.messages.at(-1)?.text ?? '')).toMatchInlineSnapshot(
                    `
                  "Based on the provided code context, the test framework being used is Vitest. No additional imports or dependencies are needed beyond what is already included in the shared context.

                  The \`Animal\` interface defines the shape of an object with a \`name\` property (string), a \`makeAnimalSound\` method that returns a string, and a boolean \`isMammal\` property. The test suite should cover the following aspects:

                  1. Ensure that instances of objects conforming to the \`Animal\` interface have the required properties and methods.
                  2. Test the behavior of the \`makeAnimalSound\` method for different types of animals (mammals and non-mammals).

                  Here's a suite of unit tests that covers these aspects:

                  \`\`\`typescript
                  import { describe, it, expect } from 'vitest'
                  import { Animal } from './animal'

                  // Mock implementation of the Animal interface
                  class MockAnimal implements Animal {
                    name: string
                    isMammal: boolean

                    constructor(name: string, isMammal: boolean) {
                      this.name = name
                      this.isMammal = isMammal
                    }

                    makeAnimalSound(): string {
                      return this.isMammal ? 'Moo' : 'Chirp'
                    }
                  }

                  describe('Animal', () => {
                    it('should have the required properties and methods', () => {
                      const mockAnimal = new MockAnimal('Cow', true)
                      expect(mockAnimal).toHaveProperty('name')
                      expect(mockAnimal).toHaveProperty('isMammal')
                      expect(mockAnimal).toHaveProperty('makeAnimalSound')
                    })

                    it('should make the correct sound for mammals', () => {
                      const mammal = new MockAnimal('Cow', true)
                      expect(mammal.makeAnimalSound()).toBe('Moo')
                    })

                    it('should make the correct sound for non-mammals', () => {
                      const nonMammal = new MockAnimal('Bird', false)
                      expect(nonMammal.makeAnimalSound()).toBe('Chirp')
                    })
                  })
                  \`\`\`

                  This test suite ensures that objects conforming to the \`Animal\` interface have the required properties and methods, and that the \`makeAnimalSound\` method behaves correctly for both mammals and non-mammals.

                  Note that since the \`Animal\` interface is an abstract definition and does not have an implementation, we created a \`MockAnimal\` class that implements the \`Animal\` interface for testing purposes."
                `,
                    explainPollyError
                )
            },
            30_000
        )

        it('commands/smell', async () => {
            await client.openFile(animalUri)
            const id = await client.request('commands/smell', null)
            const lastMessage = await client.firstNonEmptyTranscript(id)

            expect(trimEndOfLine(lastMessage.messages.at(-1)?.text ?? '')).toMatchInlineSnapshot(
                `
              "Here are a few suggestions to potentially improve the provided code:

              1. **Use Type Aliases Instead of Interfaces**: Type aliases in TypeScript are more flexible and can be extended or composed more easily than interfaces. Consider using a type alias instead of an interface for the \`Animal\` type.

              Potential benefits: Improved code flexibility and composability.

              2. **Consider Adding a Return Type for the \`makeAnimalSound\` Method**: While TypeScript can infer the return type from the implementation, explicitly specifying the return type can improve code readability and maintainability.

              Potential benefits: Improved code readability and maintainability.

              3. **Add Documentation or Comments**: While the code is relatively simple, adding comments or documentation can improve the understandability of the code, especially for larger projects or when working in a team.

              Potential benefits: Improved code readability and maintainability.

              4. **Use Descriptive Names**: The name \`Animal\` is a bit generic, and the code might benefit from a more descriptive name that better represents the specific use case or domain.

              Potential benefits: Improved code readability and maintainability.

              5. **Consider Adding Default Values or Optional Properties**: If applicable, adding default values or making properties optional (using the \`?\` syntax) can make the interface more flexible and easier to work with in different scenarios.

              Potential benefits: Improved code flexibility and maintainability.

              Overall, the provided code appears to be relatively straightforward and follows reasonable design principles for a simple interface definition. While there are some potential areas for improvement, the code quality seems satisfactory for its intended purpose."
            `,
                explainPollyError
            )
        }, 30_000)

        // Skipped because it's timing out for some reason and the functionality
        // is still not working 100% correctly. Keeping the test so we can fix
        // the test later.
        it.skip('editCommand/test', async () => {
            const trickyLogicPath = path.join(workspaceRootPath, 'src', 'trickyLogic.ts')
            const uri = vscode.Uri.file(trickyLogicPath)

            await client.openFile(uri)
            const id = await client.request('editCommands/test', null)
            await client.taskHasReachedAppliedPhase(id)
            const originalDocument = client.workspace.getDocument(uri)!
            expect(trimEndOfLine(originalDocument.getText())).toMatchInlineSnapshot(`
              "export function trickyLogic(a: number, b: number): number {
                  if (a === 0) {
                      return 1
                  }
                  if (b === 2) {
                      return 1
                  }

                  return a - b
              }


              "
            `)

            const untitledDocuments = client.workspace
                .allUris()
                .filter(uri => vscode.Uri.parse(uri).scheme === 'untitled')
            expect(untitledDocuments).toHaveLength(1)
            const [untitledDocument] = untitledDocuments
            const testDocment = client.workspace.getDocument(vscode.Uri.parse(untitledDocument))
            expect(trimEndOfLine(testDocment?.getText())).toMatchInlineSnapshot(`
              "import { trickyLogic } from './trickyLogic';

              describe('trickyLogic', () => {
                it('should return 1 if a is 0', () => {
                  expect(trickyLogic(0, 1)).toBe(1);
                });

                it('should return 1 if b is 2', () => {
                  expect(trickyLogic(1, 2)).toBe(1);
                });

                it('should return a - b if neither a is 0 nor b is 2', () => {
                  expect(trickyLogic(3, 1)).toBe(2);
                });
              });
              "
            `)

            // Just to make sure the edit happened via `workspace/edit` instead
            // of `textDocument/edit`.
            expect(client.workspaceEditParams).toHaveLength(1)
        }, 30_000)

        describe('Document code', () => {
            checkDocumentCommand(client, 'commands/document (basic function)', 'sum.ts', obtained =>
                expect(obtained).toMatchInlineSnapshot(`
                  "/**
                   * Adds two numbers together and returns the result.
                   *
                   * @param a The first number to add.
                   * @param b The second number to add.
                   * @returns The sum of \`a\` and \`b\`.
                   */
                  export function sum(a: number, b: number): number {
                      /* CURSOR */
                  }
                  "
                `)
            )

            checkDocumentCommand(
                client,
                'commands/document (Method as part of a class)',
                'TestClass.ts',
                obtained =>
                    expect(obtained).toMatchInlineSnapshot(`
                      "const foo = 42

                      export class TestClass {
                          constructor(private shouldGreet: boolean) {}

                              /**
                           * Logs 'Hello World!' to the console if the \`shouldGreet\` parameter is true.
                           */
                      public functionName() {
                              if (this.shouldGreet) {
                                  console.log(/* CURSOR */ 'Hello World!')
                              }
                          }
                      }
                      "
                    `)
            )

            checkDocumentCommand(
                client,
                'commands/document (Function within a property)',
                'TestLogger.ts',
                obtained =>
                    expect(obtained).toMatchInlineSnapshot(`
                      "const foo = 42
                      export const TestLogger = {
                          startLogging: () => {
                              // Do some stuff

                                      /**
                               * Logs a message indicating that a log is being recorded.
                               */
                      function recordLog() {
                                  console.log(/* CURSOR */ 'Recording the log')
                              }

                              recordLog()
                          },
                      }
                      "
                    `)
            )

            checkDocumentCommand(
                client,
                'commands/document (nested test case)',
                'example.test.ts',
                obtained =>
                    expect(obtained).toMatchInlineSnapshot(`
                      "import { expect } from 'vitest'
                      import { it } from 'vitest'
                      import { describe } from 'vitest'

                      describe('test block', () => {
                          it('does 1', () => {
                              expect(true).toBe(true)
                          })

                          it('does 2', () => {
                              expect(true).toBe(true)
                          })

                          it('does something else', () => {
                              // This line will error due to incorrect usage of \`performance.now\`
                                      /**
                               * Returns the current high-resolution time in milliseconds.
                               * This can be used to measure the duration of an operation.
                               */
                      const startTime = performance.now(/* CURSOR */)
                          })
                      })
                      "
                    `)
            )
        })
    })

    describe('Custom Commands', () => {
        it('commands/custom, chat command, open tabs context', async () => {
            await client.request('command/execute', {
                command: 'cody.search.index-update',
            })
            // Note: The test editor has all the files opened from previous tests as open tabs,
            // so we will need to open a new file that has not been opened before,
            // to make sure this context type is working.
            const trickyLogicPath = path.join(workspaceRootPath, 'src', 'trickyLogic.ts')
            const trickyLogicUri = vscode.Uri.file(trickyLogicPath)
            await client.openFile(trickyLogicUri)

            const result = (await client.request('commands/custom', {
                key: '/countTabs',
            })) as CustomChatCommandResult
            expect(result.type).toBe('chat')
            const lastMessage = await client.firstNonEmptyTranscript(result?.chatResult as string)
            expect(trimEndOfLine(lastMessage.messages.at(-1)?.text ?? '')).toMatchInlineSnapshot(
                `
              "Based on the file paths and code snippets you've shared, the file names are:

              1. src/trickyLogic.ts
              2. src/TestLogger.ts
              3. src/TestClass.ts
              4. src/sum.ts
              5. src/squirrel.ts
              6. src/multiple-selections.ts
              7. src/example.test.ts
              8. src/animal.ts
              9. .cody/ignore"
            `,
                explainPollyError
            )
        }, 30_000)

        it('commands/custom, chat command, adds argument', async () => {
            await client.request('command/execute', {
                command: 'cody.search.index-update',
            })
            await client.openFile(animalUri)
            const result = (await client.request('commands/custom', {
                key: '/translate Python',
            })) as CustomChatCommandResult
            expect(result.type).toBe('chat')
            const lastMessage = await client.firstNonEmptyTranscript(result?.chatResult as string)
            expect(trimEndOfLine(lastMessage.messages.at(-1)?.text ?? '')).toMatchInlineSnapshot(
                `
              "Here's the equivalent Python code for the selected TypeScript code:

              \`\`\`python
              class Animal:
                  def __init__(self, name, is_mammal):
                      self.name = name
                      self.is_mammal = is_mammal

                  def make_animal_sound(self):
                      raise NotImplementedError("Subclasses must implement make_animal_sound method")
              \`\`\`

              Explanation:

              1. In Python, we use classes to define interfaces or abstract base classes.
              2. The \`Animal\` class has an \`__init__\` method that serves as a constructor and initializes the \`name\` and \`is_mammal\` attributes.
              3. The \`make_animal_sound\` method is defined as an abstract method using the \`NotImplementedError\` exception. Subclasses of \`Animal\` must override this method to provide their own implementation.

              In TypeScript, the \`Animal\` interface defines the structure of an object, including its properties and methods. In Python, we use a class with an abstract method to achieve a similar goal. Subclasses of \`Animal\` in Python will need to implement the \`make_animal_sound\` method to provide the specific behavior for that animal.

              Note that in Python, there is no direct equivalent to TypeScript interfaces. Instead, we use abstract base classes and inheritance to achieve similar functionality."
            `,
                explainPollyError
            )
        }, 30_000)

        it('commands/custom, chat command, no context', async () => {
            await client.request('command/execute', {
                command: 'cody.search.index-update',
            })
            await client.openFile(animalUri)
            const result = (await client.request('commands/custom', {
                key: '/none',
            })) as CustomChatCommandResult
            expect(result.type).toBe('chat')
            const lastMessage = await client.firstNonEmptyTranscript(result.chatResult as string)
            expect(trimEndOfLine(lastMessage.messages.at(-1)?.text ?? '')).toMatchInlineSnapshot(
                `"No"`,
                explainPollyError
            )
        }, 30_000)

        // The context files are presented in an order in the CI that is different
        // than the order shown in recordings when on Windows, causing it to fail.
        it('commands/custom, chat command, current directory context', async () => {
            await client.request('command/execute', {
                command: 'cody.search.index-update',
            })
            await client.openFile(animalUri)
            const result = (await client.request('commands/custom', {
                key: '/countDirFiles',
            })) as CustomChatCommandResult
            expect(result.type).toBe('chat')
            const lastMessage = await client.firstNonEmptyTranscript(result.chatResult as string)
            const reply = trimEndOfLine(lastMessage.messages.at(-1)?.text ?? '')
            expect(reply).not.includes('.cody/ignore') // file that's not located in the src/directory
            expect(reply).toMatchInlineSnapshot(
                `
              "You have shared codebase context from 10 different file paths:

              1. \`src/trickyLogic.ts\`
              2. \`src/TestLogger.ts\`
              3. \`src/TestClass.ts\`
              4. \`src/sum.ts\`
              5. \`src/squirrel.ts\`
              6. \`src/multiple-selections.ts\`
              7. \`src/example.test.ts\`
              8. \`src/animal.ts\`

              And you also shared the selected code snippet from \`src/animal.ts\`."
            `,
                explainPollyError
            )
        }, 30_000)

        it('commands/custom, edit command, insert mode', async () => {
            await client.request('command/execute', {
                command: 'cody.search.index-update',
            })
            await client.openFile(sumUri, { removeCursor: false })
            const result = (await client.request('commands/custom', {
                key: '/hello',
            })) as CustomEditCommandResult
            expect(result.type).toBe('edit')
            await client.taskHasReachedAppliedPhase(result.editResult as EditTask)

            const originalDocument = client.workspace.getDocument(sumUri)!
            expect(trimEndOfLine(originalDocument.getText())).toMatchInlineSnapshot(
                `
              "// hello
              export function sum(a: number, b: number): number {
                  /* CURSOR */
              }
              "
            `,
                explainPollyError
            )
        }, 30_000)

        it('commands/custom, edit command, edit mode', async () => {
            await client.request('command/execute', {
                command: 'cody.search.index-update',
            })
            await client.openFile(animalUri)

            const result = (await client.request('commands/custom', {
                key: '/newField',
            })) as CustomEditCommandResult
            expect(result.type).toBe('edit')
            await client.taskHasReachedAppliedPhase(result.editResult as EditTask)

            const originalDocument = client.workspace.getDocument(animalUri)!
            expect(trimEndOfLine(originalDocument.getText())).toMatchInlineSnapshot(`
              "/* SELECTION_START */
              export interface Animal {
                  name: string
                  makeAnimalSound(): string
                  isMammal: boolean
                  logName(): void {
                      console.log(this.name);
                  }
              }
              /* SELECTION_END */
              "
            `)
        }, 30_000)
    })

    describe('Progress bars', () => {
        it('progress/report', async () => {
            const { result } = await client.request('testing/progress', {
                title: 'Susan',
            })
            expect(result).toStrictEqual('Hello Susan')
            let progressID: string | undefined
            for (const message of client.progressMessages) {
                if (
                    message.method === 'progress/start' &&
                    message.message.options.title === 'testing/progress'
                ) {
                    progressID = message.message.id
                    break
                }
            }
            assert(progressID !== undefined, JSON.stringify(client.progressMessages))
            const messages = client.progressMessages
                .filter(message => message.id === progressID)
                .map(({ method, message }) => [method, { ...message, id: 'THE_ID' }])
            expect(messages).toMatchInlineSnapshot(`
              [
                [
                  "progress/start",
                  {
                    "id": "THE_ID",
                    "options": {
                      "cancellable": true,
                      "location": "Notification",
                      "title": "testing/progress",
                    },
                  },
                ],
                [
                  "progress/report",
                  {
                    "id": "THE_ID",
                    "message": "message1",
                  },
                ],
                [
                  "progress/report",
                  {
                    "id": "THE_ID",
                    "increment": 50,
                  },
                ],
                [
                  "progress/report",
                  {
                    "id": "THE_ID",
                    "increment": 50,
                  },
                ],
                [
                  "progress/end",
                  {
                    "id": "THE_ID",
                  },
                ],
              ]
            `)
        })

        it('progress/cancel', async () => {
            const disposable = client.progressStartEvents.event(params => {
                if (params.options.title === 'testing/progressCancelation') {
                    client.notify('progress/cancel', { id: params.id })
                }
            })
            try {
                const { result } = await client.request('testing/progressCancelation', {
                    title: 'Leona',
                })
                expect(result).toStrictEqual("request with title 'Leona' cancelled")
            } finally {
                disposable.dispose()
            }
        })
    })

    describe('RateLimitedAgent', () => {
        const rateLimitedClient = new TestClient({
            name: 'rateLimitedClient',
            accessToken:
                process.env.SRC_ACCESS_TOKEN_WITH_RATE_LIMIT ??
                // See comment above `const client =` about how this value is derived.
                'REDACTED_8c77b24d9f3d0e679509263c553887f2887d67d33c4e3544039c1889484644f5',
        })
        // Initialize inside beforeAll so that subsequent tests are skipped if initialization fails.
        beforeAll(async () => {
            const serverInfo = await rateLimitedClient.initialize()

            expect(serverInfo.authStatus?.isLoggedIn).toBeTruthy()
            expect(serverInfo.authStatus?.username).toStrictEqual('david.veszelovszki')
        }, 10_000)

        it('chat/submitMessage (RateLimitError)', async () => {
            const lastMessage = await rateLimitedClient.sendSingleMessageToNewChat('sqrt(9)')
            // Intentionally not a snapshot assertion because we should never
            // automatically update 'RateLimitError' to become another value.
            expect(lastMessage?.error?.name).toStrictEqual('RateLimitError')
        }, 30_000)

        afterAll(async () => {
            await rateLimitedClient.shutdownAndExit()
            // Long timeout because to allow Polly.js to persist HTTP recordings
        }, 30_000)
    })

    describe('Enterprise', () => {
        const enterpriseClient = new TestClient({
            name: 'enterpriseClient',
            accessToken:
                process.env.SRC_ENTERPRISE_ACCESS_TOKEN ??
                // See comment above `const client =` about how this value is derived.
                'REDACTED_b20717265e7ab1d132874d8ff0be053ab9c1dacccec8dce0bbba76888b6a0a69',
            serverEndpoint: 'https://demo.sourcegraph.com',
            telemetryExporter: 'graphql',
            logEventMode: 'connected-instance-only',
        })
        // Initialize inside beforeAll so that subsequent tests are skipped if initialization fails.
        beforeAll(async () => {
            const serverInfo = await enterpriseClient.initialize()

            expect(serverInfo.authStatus?.isLoggedIn).toBeTruthy()
            expect(serverInfo.authStatus?.username).toStrictEqual('codytesting')
        }, 10_000)

        it('chat/submitMessage', async () => {
            const lastMessage = await enterpriseClient.sendSingleMessageToNewChat('Reply with "Yes"')
            expect(lastMessage?.text?.trim()).toStrictEqual('Yes')
        }, 20_000)

        checkDocumentCommand(
            enterpriseClient,
            'commands/document (enterprise client)',
            'example.test.ts',
            obtained =>
                expect(obtained).toMatchInlineSnapshot(`
                  "import { expect } from 'vitest'
                  import { it } from 'vitest'
                  import { describe } from 'vitest'

                  /**
                   * Test block that contains three tests:
                   * - Test that does something and expects true === true
                   * - Another test that does something else and expects true === true
                   * - Test that attempts to measure performance incorrectly
                  */
                  describe('test block', () => {
                      it('does 1', () => {
                          expect(true).toBe(true)
                      })

                      it('does 2', () => {
                          expect(true).toBe(true)
                      })

                      it('does something else', () => {
                          // This line will error due to incorrect usage of \`performance.now\`
                          const startTime = performance.now(/* CURSOR */)
                      })
                  })
                  "
                `)
        )

        // NOTE(olafurpg) disabled on Windows because the multi-repo keyword
        // query is not replaying on Windows due to some platform-dependency on
        // how the HTTP request is constructed. I manually tested multi-repo on
        // a Windows computer to confirm that it does work as expected.
        it.skipIf(isWindows())(
            'chat/submitMessage (addEnhancedContext: true, multi-repo test)',
            async () => {
                const id = await enterpriseClient.request('chat/new', null)
                const { repos } = await enterpriseClient.request('graphql/getRepoIds', {
                    names: ['github.com/sourcegraph/sourcegraph'],
                    first: 1,
                })
                await enterpriseClient.request('webview/receiveMessage', {
                    id,
                    message: {
                        command: 'context/choose-remote-search-repo',
                        explicitRepos: repos,
                    },
                })
                const { lastMessage, transcript } =
                    await enterpriseClient.sendSingleMessageToNewChatWithFullTranscript(
                        'What is Squirrel?',
                        {
                            id,
                            addEnhancedContext: true,
                        }
                    )

                expect(lastMessage?.text ?? '').includes('code intelligence')
                expect(lastMessage?.text ?? '').includes('tree-sitter')

                const contextUris: URI[] = []
                for (const message of transcript.messages) {
                    for (const file of message.contextFiles ?? []) {
                        if (file.type === 'file') {
                            file.uri = URI.from(file.uri)
                            contextUris.push(file.uri)
                        }
                    }
                }
                const paths = contextUris.map(uri => uri.path.split('/-/blob/').at(1) ?? '').sort()
                expect(paths).includes('cmd/symbols/squirrel/README.md')

                const { remoteRepos } = await enterpriseClient.request('chat/remoteRepos', { id })
                expect(remoteRepos).toStrictEqual(repos)
            },
            30_000
        )

        it('remoteRepo/list', async () => {
            // List a repo without a query
            let repos: Requests['remoteRepo/list'][1]
            do {
                repos = await enterpriseClient.request('remoteRepo/list', {
                    query: undefined,
                    first: 10,
                })
            } while (repos.state.state === 'fetching')
            expect(repos.repos).toHaveLength(10)

            // Make a paginated query.
            const secondLastRepo = repos.repos.at(-2)
            const moreRepos = await enterpriseClient.request('remoteRepo/list', {
                query: undefined,
                first: 2,
                afterId: secondLastRepo?.id,
            })
            expect(moreRepos.repos[0].id).toBe(repos.repos.at(-1)?.id)

            // Make a query.
            const filteredRepos = await enterpriseClient.request('remoteRepo/list', {
                query: 'sourceco',
                first: 1000,
            })
            expect(
                filteredRepos.repos.find(repo => repo.name === 'github.com/sourcegraph/cody')
            ).toBeDefined()
        })

        it('remoteRepo/has', async () => {
            // Query a repo that does exist.
            const codyRepoExists = await enterpriseClient.request('remoteRepo/has', {
                repoName: 'github.com/sourcegraph/cody',
            })
            expect(codyRepoExists.result).toBe(true)

            // Query a repo that does not exist.
            const codyForDos = await enterpriseClient.request('remoteRepo/has', {
                repoName: 'github.com/sourcegraph/cody-edlin',
            })
            expect(codyForDos.result).toBe(false)
        })

        afterAll(async () => {
            const { requests } = await enterpriseClient.request('testing/networkRequests', null)
            const nonServerInstanceRequests = requests
                .filter(({ url }) => !url.startsWith(enterpriseClient.serverEndpoint))
                .map(({ url }) => url)
            expect(JSON.stringify(nonServerInstanceRequests)).toStrictEqual('[]')
            await enterpriseClient.shutdownAndExit()
            // Long timeout because to allow Polly.js to persist HTTP recordings
        }, 30_000)
    })

    // Enterprise tests are run at demo instance, which is at a recent release version.
    // Use this section if you need to run against S2 which is released continuously.
    describe('Enterprise - close main branch', () => {
        const enterpriseClient = new TestClient({
            name: 'enterpriseMainBranchClient',
            accessToken:
                process.env.SRC_S2_ACCESS_TOKEN ??
                // See comment above `const client =` about how this value is derived.
                'REDACTED_ad28238383af71357085701263df7766e6f7f8ad1afc344d71aaf69a07143677',
            serverEndpoint: 'https://sourcegraph.sourcegraph.com',
            telemetryExporter: 'graphql',
            logEventMode: 'connected-instance-only',
        })

        // Initialize inside beforeAll so that subsequent tests are skipped if initialization fails.
        beforeAll(async () => {
            const serverInfo = await enterpriseClient.initialize()

            expect(serverInfo.authStatus?.isLoggedIn).toBeTruthy()
            expect(serverInfo.authStatus?.username).toStrictEqual('codytesting')
        }, 10_000)

        it('attribution/found', async () => {
            const id = await enterpriseClient.request('chat/new', null)
            const { repoNames, error } = await enterpriseClient.request('attribution/search', {
                id,
                snippet: 'sourcegraph.Location(new URL',
            })
            expect(repoNames).not.empty
            expect(error).null
        }, 20_000)

        it('attribution/not found', async () => {
            const id = await enterpriseClient.request('chat/new', null)
            const { repoNames, error } = await enterpriseClient.request('attribution/search', {
                id,
                snippet: 'sourcegraph.Location(new LRU',
            })
            expect(repoNames).empty
            expect(error).null
        }, 20_000)

        afterAll(async () => {
            await enterpriseClient.shutdownAndExit()
            // Long timeout because to allow Polly.js to persist HTTP recordings
        }, 30_000)
    })

    afterAll(async () => {
        await fspromises.rm(workspaceRootPath, {
            recursive: true,
            force: true,
        })
        await client.shutdownAndExit()
        // Long timeout because to allow Polly.js to persist HTTP recordings
    }, 30_000)
})

function trimEndOfLine(text: string | undefined): string {
    if (text === undefined) {
        return ''
    }
    return text
        .split('\n')
        .map(line => line.trimEnd())
        .join('\n')
}
