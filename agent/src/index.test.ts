import assert from 'node:assert'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
    DOTCOM_URL,
    ModelUsage,
    ModelsService,
    getDotComDefaultModels,
    isWindows,
} from '@sourcegraph/cody-shared'

import { ResponseError } from 'vscode-jsonrpc'
import { URI } from 'vscode-uri'
import { CodyJsonRpcErrorCode } from '../../vscode/src/jsonrpc/CodyJsonRpcErrorCode'
import { TESTING_CREDENTIALS } from '../../vscode/src/testutils/testing-credentials'
import { TestClient, asTranscriptMessage } from './TestClient'
import { TestWorkspace } from './TestWorkspace'
import { decodeURIs } from './decodeURIs'
import { explainPollyError } from './explainPollyError'
import type { Requests } from './protocol-alias'
import { trimEndOfLine } from './trimEndOfLine'

const workspace = new TestWorkspace(path.join(__dirname, '__tests__', 'example-ts'))

const mayRecord =
    process.env.CODY_RECORDING_MODE === 'record' || process.env.CODY_RECORD_IF_MISSING === 'true'

describe('Agent', () => {
    const client = TestClient.create({
        workspaceRootUri: workspace.rootUri,
        name: 'defaultClient',
        credentials: TESTING_CREDENTIALS.dotcom,
    })

    // Initialize inside beforeAll so that subsequent tests are skipped if initialization fails.
    beforeAll(async () => {
        ModelsService.setModels(getDotComDefaultModels())
        await workspace.beforeAll()

        // Init a repo in the workspace to make the parent-dirs repo-name resolver work for Cody Context Filters tests.
        spawnSync('git', ['init'], { cwd: workspace.rootPath, stdio: 'inherit' })
        spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:sourcegraph/cody.git'], {
            cwd: workspace.rootPath,
            stdio: 'inherit',
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
            serverEndpoint: client.info.extensionConfiguration?.serverEndpoint ?? DOTCOM_URL.toString(),
            customHeaders: {},
        })
        expect(valid?.isLoggedIn).toBeTruthy()

        // Confirm .cody/ignore is active at start up
        const ignore = await client.request('ignore/test', {
            uri: URI.file(ignoredUri.fsPath).toString(),
        })
        // TODO(dpc): Integrate file-based .cody/ignore with ignore/test
        expect(ignore.policy).toBe('use')
    }, 20_000)

    beforeEach(async () => {
        await client.request('testing/reset', null)
    })

    const sumUri = workspace.file('src', 'sum.ts')
    const animalUri = workspace.file('src', 'animal.ts')
    const squirrelUri = workspace.file('src', 'squirrel.ts')
    const multipleSelectionsUri = workspace.file('src', 'multiple-selections.ts')

    // Context files ends with 'Ignored.ts' will be excluded by .cody/ignore
    const ignoredUri = workspace.file('src', 'isIgnored.ts')

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
            serverEndpoint: client.info.extensionConfiguration?.serverEndpoint ?? DOTCOM_URL.toString(),
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
            "currentPeriodEndAt": "2024-06-14T22:11:32Z",
            "currentPeriodStartAt": "2024-05-14T22:11:32Z",
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
                "model": "anthropic/claude-3-sonnet-20240229",
                "speaker": "assistant",
                "text": "Hello! My name is Cody, an AI coding assistant from Sourcegraph. It's nice to meet you. How can I assist you with coding or software development today?",
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
              "Certainly! Here's a simple hello world function in Java:

              \`\`\`java
              public class HelloWorld {
                  public static void main(String[] args) {
                      System.out.println("Hello, World!");
                  }
              }
              \`\`\`

              This is the most basic Java program that prints the famous "Hello, World!" message to the console.

              Explanation:

              1. \`public class HelloWorld {\`: This line declares a new public class named \`HelloWorld\`.
              2. \`public static void main(String[] args) {\`: This is the main method, which is the entry point of the program. The \`public\` keyword means that this method can be accessed from outside the class. The \`static\` keyword means that this method belongs to the class itself and not to any instance of the class. The \`void\` keyword indicates that this method doesn't return any value. The \`main\` method is a special method that the Java Virtual Machine (JVM) looks for and runs when the program starts.
              3. \`System.out.println("Hello, World!");\`: This line prints the string \`"Hello, World!"\` to the console using the \`println\` method of the \`System.out\` object, which represents the standard output stream.
              4. \`}\`: This closing curly brace marks the end of the \`main\` method.
              5. \`}\`: This closing curly brace marks the end of the \`HelloWorld\` class.

              To run this program, you need to save it in a file with the name \`HelloWorld.java\` and compile it using a Java compiler. Then, you can execute the compiled bytecode file using the Java Virtual Machine (JVM)."
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
                        text: 'My name is Lars Monsen.',
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
                `"I'm afraid I don't have a specific model name or number. As an AI system created by Anthropic, I don't have full transparency into the details of the model architecture or training process that was used to develop me. I know I'm a large language model trained on a lot of data, but the specifics of the model itself aren't something I'm explicitly aware of. Is there another way I can try to help or clarify things? I'd be happy to explain more about my capabilities if that would be useful."`,
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
        "model": "anthropic/claude-2.0",
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

        it.skip('chat/submitMessage (addEnhancedContext: true)', async () => {
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
              export class Dog implements Animal {
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

        it.skip('chat/submitMessage (addEnhancedContext: true, squirrel test)', async () => {
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

        describe('chat/editMessage', () => {
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

    // TODO(dpc): Integrate file-based .cody/ignore with ignore/test
    describe.skip('Cody Ignore', () => {
        beforeAll(async () => {
            // Make sure Cody ignore config exists and works
            const codyIgnoreConfig = workspace.file('.cody', 'ignore')
            await client.openFile(codyIgnoreConfig)
            const codyIgnoreConfigFile = client.workspace.getDocument(codyIgnoreConfig)
            expect(codyIgnoreConfigFile?.content).toBeDefined()

            const result = await client.request('ignore/test', {
                uri: ignoredUri.toString(),
            })
            expect(result.policy).toBe('ignore')
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
            const contextFilesUrls = contextFiles.map(f => f.uri).filter(uri => uri)
            const result = await Promise.all(
                contextFilesUrls.map(uri => client.request('ignore/test', { uri: uri.toString() }))
            )
            for (const r of result) {
                expect(r.policy).toBe('use')
            }
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
            const result = await Promise.all(
                contextUrls.map(uri =>
                    client.request('ignore/test', {
                        uri,
                    })
                )
            )
            expect(result.every(entry => entry.policy === 'use')).toBe(true)
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
            const alsoIgnored = workspace.file('src', 'is_ignored.ts')
            const result = await client.request('ignore/test', {
                uri: URI.file(alsoIgnored.fsPath).toString(),
            })
            expect(result.policy).toBe('ignore')
        })

        afterAll(async () => {
            // Makes sure cody ignore is still active after tests
            // as it should stay active for each workspace session.
            const result = await client.request('ignore/test', {
                uri: ignoredUri.toString(),
            })
            expect(result.policy).toBe('ignore')

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
                { addEnhancedContext: false }
            )
            expect(reply?.text?.trim()).includes('anotherFunction')
            expect(reply?.text?.trim()).not.includes('inner')
            await client.changeFile(multipleSelectionsUri)
            const reply2 = await client.sendSingleMessageToNewChat(
                'What is the name of the function that I have selected? Only answer with the name of the function, nothing else',
                { addEnhancedContext: false }
            )
            expect(reply2?.text?.trim()).includes('inner')
            expect(reply2?.text?.trim()).not.includes('anotherFunction')
        }, 20_000)
    })

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
              "The code \`@src/animal.ts:1-6\` defines an interface called \`Animal\` in TypeScript. An interface is a structural contract that defines the shape of an object. It specifies the properties and methods that an object must have to conform to that interface.

              The \`Animal\` interface has three members:

              1. \`name: string\`: This is a property that represents the name of the animal. It specifies that any object conforming to the \`Animal\` interface must have a \`name\` property, and its value must be a string.

              2. \`makeAnimalSound(): string\`: This is a method that represents the sound made by the animal. It specifies that any object conforming to the \`Animal\` interface must have a \`makeAnimalSound\` method, which doesn't take any input but returns a string representing the sound the animal makes.

              3. \`isMammal: boolean\`: This is a property that indicates whether the animal is a mammal or not. It specifies that any object conforming to the \`Animal\` interface must have an \`isMammal\` property, and its value must be a boolean (either \`true\` or \`false\`).

              The purpose of this code is to define a contract or a blueprint for objects representing animals. It doesn't take any input or produce any output directly. Instead, it serves as a guide for creating objects that represent animals and ensures that those objects have the necessary properties and methods defined in the \`Animal\` interface.

              To achieve its purpose, the code uses the \`interface\` keyword in TypeScript to define the structure of the \`Animal\` interface. It lists the required properties (\`name\` and \`isMammal\`) and methods (\`makeAnimalSound\`) that an object must have to conform to this interface.

              The logic and algorithm behind this code are straightforward. It simply declares the structure of the \`Animal\` interface, but it doesn't include any implementation details or functionality. The implementation of the actual animal objects and their behavior would be defined elsewhere in the codebase, using classes or object literals that conform to the \`Animal\` interface.

              This code doesn't involve any complex logic flows or data transformations. It's a declarative definition of the structure of an object representing an animal, which can be used throughout the codebase to ensure consistency and type safety when working with animal-related objects."
            `,
                explainPollyError
            )
        }, 30_000)

        // This test seems extra sensitive on Node v16 for some reason.
        it.skipIf(isWindows())(
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
                  "Based on the provided codebase context, the test framework being used is Vitest, which is a Vite-native test runner.

                  To generate a suite of unit tests for the \`Animal\` interface, I would import the following libraries:

                  \`\`\`typescript
                  import { describe, expect, it } from 'vitest'
                  \`\`\`

                  Here's a summary of the test coverage and limitations:

                  - The tests will cover the properties and methods defined in the \`Animal\` interface.
                  - Since \`Animal\` is an interface, the tests will need to be written against a concrete implementation of the interface.
                  - The tests will not cover any additional functionality or edge cases not defined in the interface.

                  Here's the full completed code for the new unit tests, including all necessary imports:

                  \`\`\`typescript
                  import { describe, expect, it } from 'vitest'
                  import { Animal } from './animal'

                  // Assume a concrete implementation of the Animal interface
                  class Dog implements Animal {
                    name: string
                    isMammal: boolean

                    constructor(name: string) {
                      this.name = name
                      this.isMammal = true
                    }

                    makeAnimalSound(): string {
                      return 'Woof!'
                    }
                  }

                  describe('Animal', () => {
                    let animal: Animal

                    beforeEach(() => {
                      animal = new Dog('Buddy')
                    })

                    it('should have a name property', () => {
                      expect(animal).toHaveProperty('name')
                    })

                    it('should have a makeAnimalSound method', () => {
                      expect(animal).toHaveProperty('makeAnimalSound')
                      expect(typeof animal.makeAnimalSound).toBe('function')
                    })

                    it('should have an isMammal property', () => {
                      expect(animal).toHaveProperty('isMammal')
                    })

                    it('should make the correct animal sound', () => {
                      expect(animal.makeAnimalSound()).toBe('Woof!')
                    })
                  })
                  \`\`\`

                  This suite of tests covers the properties and methods defined in the \`Animal\` interface. It assumes a concrete implementation of the interface (in this case, a \`Dog\` class) to test against. The tests cover the existence of the required properties and methods, as well as the expected behavior of the \`makeAnimalSound\` method."
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
              "Based on the provided code snippet, which defines an interface \`Animal\` with properties \`name\` and \`isMammal\`, and a method \`makeAnimalSound()\`, here are a few potential areas for improvement:

              1. **Consider using more descriptive naming for the method \`makeAnimalSound()\`**: The method name could be more explicit about its purpose. For example, \`produceSound()\` or \`emitSound()\` might better convey the intended behavior.

              2. **Add method return type annotation for \`makeAnimalSound()\`**: While TypeScript can infer the return type of the method from the implementation, explicitly annotating the return type in the interface definition can improve code readability and maintainability.

              3. **Consider adding a description or documentation for the interface and its members**: Adding comments or docstrings to describe the purpose and expected behavior of the interface and its properties/methods can greatly improve code understanding and maintainability, especially for larger codebases or when working in a team.

              4. **Consider adding type constraints or validation for the \`name\` property**: Depending on the requirements of your application, you might want to add constraints or validation rules for the \`name\` property. For example, you could specify a minimum or maximum length, disallow certain characters, or enforce a specific formatting pattern.

              5. **Consider separating concerns by creating separate interfaces for different animal types**: If you have different types of animals with specific behaviors or properties, you could create separate interfaces for each animal type, and then have a base \`Animal\` interface that other interfaces extend or implement. This can improve code organization, reusability, and maintainability.

              Overall, while the provided code snippet follows a sound design principle of using an interface to define the structure of an \`Animal\` object, there are some opportunities to enhance code readability, maintainability, and potentially add more specific constraints or validations based on your application's requirements."
            `,
                explainPollyError
            )
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
        const rateLimitedClient = TestClient.create({
            workspaceRootUri: workspace.rootUri,
            name: 'rateLimitedClient',
            credentials: TESTING_CREDENTIALS.dotcomProUserRateLimited,
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

        // Skipped because Polly is failing to record the HTTP rate-limit error
        // response.  Keeping the code around in case we need to debug these  in
        // the future. Use the following command to run this test:
        // - First, mark this test as `it.only`
        // - Next, run `CODY_RECORDING_MODE=passthrough pnpm test agent/src/index.test.ts`
        it.skip('autocomplete/trigger (RateLimitError)', async () => {
            let code = 0
            try {
                await rateLimitedClient.openFile(sumUri)
                const result = await rateLimitedClient.autocompleteText()
                console.log({ result })
            } catch (error) {
                if (error instanceof ResponseError) {
                    code = error.code
                }
            }
            expect(code).toEqual(CodyJsonRpcErrorCode.RateLimitError)
        }, 30_000)

        afterAll(async () => {
            await rateLimitedClient.shutdownAndExit()
            // Long timeout because to allow Polly.js to persist HTTP recordings
        }, 30_000)
    })

    describe('Enterprise', () => {
        const demoEnterpriseClient = TestClient.create({
            workspaceRootUri: workspace.rootUri,
            name: 'enterpriseClient',
            credentials: TESTING_CREDENTIALS.enterprise,
            logEventMode: 'connected-instance-only',
        })
        // Initialize inside beforeAll so that subsequent tests are skipped if initialization fails.
        beforeAll(async () => {
            const serverInfo = await demoEnterpriseClient.initialize()

            expect(serverInfo.authStatus?.isLoggedIn).toBeTruthy()
            expect(serverInfo.authStatus?.username).toStrictEqual('codytesting')
        }, 10_000)

        it('chat/submitMessage', async () => {
            const lastMessage = await demoEnterpriseClient.sendSingleMessageToNewChat('Reply with "Yes"')
            expect(lastMessage?.text?.trim()).toStrictEqual('Yes')
        }, 20_000)

        it('commands/document (enterprise client)', async () => {
            const uri = workspace.file('src', 'example.test.ts')
            const obtained = await demoEnterpriseClient.documentCode(uri)
            expect(obtained).toMatchInlineSnapshot(
                `
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
                      // Record the start time using the Performance API's \`now\` method.
                      // This captures a high resolution monotonic timestamp in milliseconds.
                      const startTime = performance.now(/* CURSOR */)
                  })
              })
              "
            `
            )
        })

        it('remoteRepo/list', async () => {
            // List a repo without a query
            let repos: Requests['remoteRepo/list'][1]
            do {
                repos = await demoEnterpriseClient.request('remoteRepo/list', {
                    query: undefined,
                    first: 10,
                })
            } while (repos.state.state === 'fetching')
            expect(repos.repos).toHaveLength(10)

            // Make a paginated query.
            const secondLastRepo = repos.repos.at(-2)
            const moreRepos = await demoEnterpriseClient.request('remoteRepo/list', {
                query: undefined,
                first: 2,
                afterId: secondLastRepo?.id,
            })
            expect(moreRepos.repos[0].id).toBe(repos.repos.at(-1)?.id)

            // Make a query.
            const filteredRepos = await demoEnterpriseClient.request('remoteRepo/list', {
                query: 'sourceco',
                first: 1000,
            })
            expect(
                filteredRepos.repos.find(repo => repo.name === 'github.com/sourcegraph/cody')
            ).toBeDefined()
        })

        it('remoteRepo/has', async () => {
            // Query a repo that does exist.
            const codyRepoExists = await demoEnterpriseClient.request('remoteRepo/has', {
                repoName: 'github.com/sourcegraph/cody',
            })
            expect(codyRepoExists.result).toBe(true)

            // Query a repo that does not exist.
            const codyForDos = await demoEnterpriseClient.request('remoteRepo/has', {
                repoName: 'github.com/sourcegraph/cody-edlin',
            })
            expect(codyForDos.result).toBe(false)
        })

        afterAll(async () => {
            const { requests } = await demoEnterpriseClient.request('testing/networkRequests', null)
            const nonServerInstanceRequests = requests
                .filter(({ url }) => !url.startsWith(demoEnterpriseClient.serverEndpoint))
                .map(({ url }) => url)
            expect(JSON.stringify(nonServerInstanceRequests)).toStrictEqual('[]')
            await demoEnterpriseClient.shutdownAndExit()
            // Long timeout because to allow Polly.js to persist HTTP recordings
        }, 30_000)
    })

    // Enterprise tests are run at demo instance, which is at a recent release version.
    // Use this section if you need to run against S2 which is released continuously.
    describe('Enterprise - close main branch', () => {
        const s2EnterpriseClient = TestClient.create({
            workspaceRootUri: workspace.rootUri,
            name: 'enterpriseMainBranchClient',
            credentials: TESTING_CREDENTIALS.s2,
            logEventMode: 'connected-instance-only',
        })

        // Initialize inside beforeAll so that subsequent tests are skipped if initialization fails.
        beforeAll(async () => {
            const serverInfo = await s2EnterpriseClient.initialize({
                autocompleteAdvancedProvider: 'fireworks',
            })

            expect(serverInfo.authStatus?.isLoggedIn).toBeTruthy()
            expect(serverInfo.authStatus?.username).toStrictEqual('codytesting')
        }, 10_000)

        // Disabled because `attribution/search` GraphQL does not work on S2
        // See https://sourcegraph.slack.com/archives/C05JDP433DL/p1714017586160079
        it.skip('attribution/found', async () => {
            const id = await s2EnterpriseClient.request('chat/new', null)
            const { repoNames, error } = await s2EnterpriseClient.request('attribution/search', {
                id,
                snippet: 'sourcegraph.Location(new URL',
            })
            expect(repoNames).not.empty
            expect(error).null
        }, 20_000)

        it('attribution/not found', async () => {
            const id = await s2EnterpriseClient.request('chat/new', null)
            const { repoNames, error } = await s2EnterpriseClient.request('attribution/search', {
                id,
                snippet: 'sourcegraph.Location(new LRU',
            })
            expect(repoNames).empty
            expect(error).null
        }, 20_000)

        // Use S2 instance for Cody Context Filters enterprise tests
        describe('Cody Context Filters for enterprise', () => {
            it('testing/ignore/overridePolicy', async () => {
                const onChangeCallback = vi.fn()

                // `sumUri` is located inside of the github.com/sourcegraph/cody repo.
                const ignoreTest = () =>
                    s2EnterpriseClient.request('ignore/test', { uri: sumUri.toString() })
                s2EnterpriseClient.registerNotification('ignore/didChange', onChangeCallback)

                expect(await ignoreTest()).toStrictEqual({ policy: 'use' })

                await s2EnterpriseClient.request('testing/ignore/overridePolicy', {
                    include: [{ repoNamePattern: '' }],
                    exclude: [{ repoNamePattern: '.*sourcegraph/cody.*' }],
                })

                expect(onChangeCallback).toBeCalledTimes(1)
                expect(await ignoreTest()).toStrictEqual({ policy: 'ignore' })

                await s2EnterpriseClient.request('testing/ignore/overridePolicy', {
                    include: [{ repoNamePattern: '' }],
                    exclude: [{ repoNamePattern: '.*sourcegraph/sourcegraph.*' }],
                })

                expect(onChangeCallback).toBeCalledTimes(2)
                expect(await ignoreTest()).toStrictEqual({ policy: 'use' })

                await s2EnterpriseClient.request('testing/ignore/overridePolicy', {
                    include: [{ repoNamePattern: '' }],
                    exclude: [{ repoNamePattern: '.*sourcegraph/sourcegraph.*' }],
                })

                // onChangeCallback is not called again because filters are the same
                expect(onChangeCallback).toBeCalledTimes(2)
            })

            // The site config `cody.contextFilters` value on sourcegraph.sourcegraph.com instance
            // should include `sourcegraph/cody` repo for this test to pass.
            it('autocomplete/execute (with Cody Ignore filters)', async () => {
                // Documents to be used as context sources.
                await s2EnterpriseClient.openFile(animalUri)
                await s2EnterpriseClient.openFile(squirrelUri)

                // Document to generate a completion from.
                await s2EnterpriseClient.openFile(sumUri)

                const { items, completionEvent } = await s2EnterpriseClient.request(
                    'autocomplete/execute',
                    {
                        uri: sumUri.toString(),
                        position: { line: 1, character: 3 },
                        triggerKind: 'Invoke',
                    }
                )

                expect(items.length).toBeGreaterThan(0)
                expect(items.map(item => item.insertText)).toMatchInlineSnapshot(
                    `
              [
                "   return a + b",
              ]
            `
                )

                // Two documents will be checked against context filters set in site-config on S2.
                expect(
                    completionEvent?.params.contextSummary?.retrieverStats['jaccard-similarity']
                        .suggestedItems
                ).toEqual(2)

                s2EnterpriseClient.notify('autocomplete/completionAccepted', {
                    completionID: items[0].id,
                })
            }, 10_000)
        })

        afterAll(async () => {
            await s2EnterpriseClient.shutdownAndExit()
            // Long timeout because to allow Polly.js to persist HTTP recordings
        }, 30_000)
    })

    afterAll(async () => {
        await workspace.afterAll()
        await client.shutdownAndExit()
        // Long timeout because to allow Polly.js to persist HTTP recordings
    }, 30_000)
})
