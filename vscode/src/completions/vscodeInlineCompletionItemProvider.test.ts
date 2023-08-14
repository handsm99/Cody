import dedent from 'dedent'
import { describe, expect, test, vi } from 'vitest'
import type * as vscode from 'vscode'

import { vsCodeMocks } from '../testutils/mocks'

import { getInlineCompletions, InlineCompletionsResultSource } from './getInlineCompletions'
import * as CompletionLogger from './logger'
import { createProviderConfig } from './providers/anthropic'
import { documentAndPosition } from './testHelpers'
import { InlineCompletionItem } from './types'
import { InlineCompletionItemProvider } from './vscodeInlineCompletionItemProvider'

vi.mock('vscode', () => ({
    ...vsCodeMocks,
    workspace: {
        ...vsCodeMocks.workspace,
        asRelativePath(path: string) {
            return path
        },
        onDidChangeTextDocument() {
            return null
        },
    },
    window: {
        ...vsCodeMocks.window,
        visibleTextEditors: [],
        tabGroups: { all: [] },
    },
}))

const DUMMY_CONTEXT: vscode.InlineCompletionContext = {
    selectedCompletionInfo: undefined,
    triggerKind: vsCodeMocks.InlineCompletionTriggerKind.Automatic,
}

class MockableInlineCompletionItemProvider extends InlineCompletionItemProvider {
    constructor(
        mockGetInlineCompletions: typeof getInlineCompletions,
        superArgs?: Partial<ConstructorParameters<typeof InlineCompletionItemProvider>[0]>
    ) {
        super({
            completeSuggestWidgetSelection: false,
            // Most of these are just passed directly to `getInlineCompletions`, which we've mocked, so
            // we can just make them `null`.
            //
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
            getCodebaseContext: null as any,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
            history: null as any,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
            statusBar: null as any,
            providerConfig: createProviderConfig({
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
                completionsClient: null as any,
                contextWindowTokens: 2048,
            }),

            ...superArgs,
        })
        this.getInlineCompletions = mockGetInlineCompletions
    }

    public declare lastCandidate
}

describe('InlineCompletionItemProvider', () => {
    test('returns results that span the whole line', async () => {
        const { document, position } = documentAndPosition('const foo = █', 'typescript')
        const fn = vi.fn(getInlineCompletions).mockResolvedValue({
            logId: '1',
            items: [{ insertText: 'test', range: new vsCodeMocks.Range(position, position) }],
            source: InlineCompletionsResultSource.Network,
        })
        const provider = new MockableInlineCompletionItemProvider(fn)
        const result = await provider.provideInlineCompletionItems(document, position, DUMMY_CONTEXT)
        expect(result).not.toBeNull()
        expect(result!.items).toMatchInlineSnapshot(`
          [
            InlineCompletionItem {
              "insertText": "const foo = test",
              "range": Range {
                "end": Position {
                  "character": 12,
                  "line": 0,
                },
                "start": Position {
                  "character": 0,
                  "line": 0,
                },
              },
            },
          ]
        `)
    })

    test('saves lastInlineCompletionResult', async () => {
        const { document, position } = documentAndPosition(
            dedent`
                const foo = █
                console.log(1)
                console.log(2)
            `,
            'typescript'
        )

        const item: InlineCompletionItem = { insertText: 'test', range: new vsCodeMocks.Range(position, position) }
        const fn = vi.fn(getInlineCompletions).mockResolvedValue({
            logId: '1',
            items: [item],
            source: InlineCompletionsResultSource.Network,
        })
        const provider = new MockableInlineCompletionItemProvider(fn)

        // Initially it is undefined.
        expect(provider.lastCandidate).toBeUndefined()

        // No lastInlineCompletionResult is provided on the 1st call.
        await provider.provideInlineCompletionItems(document, position, DUMMY_CONTEXT)
        expect(fn.mock.calls.map(call => call[0].lastCandidate)).toEqual([undefined])
        fn.mockReset()

        // But it is returned and saved.
        expect(provider.lastCandidate).toMatchInlineSnapshot(`
          {
            "lastTriggerCurrentLinePrefix": "const foo = ",
            "lastTriggerNextNonEmptyLine": "console.log(1)",
            "lastTriggerPosition": Position {
              "character": 12,
              "line": 0,
            },
            "result": {
              "items": [
                {
                  "insertText": "test",
                  "range": Range {
                    "end": Position {
                      "character": 12,
                      "line": 0,
                    },
                    "start": Position {
                      "character": 12,
                      "line": 0,
                    },
                  },
                },
              ],
              "logId": "1",
            },
            "uri": {
              "$mid": 1,
              "path": "/test.ts",
              "scheme": "file",
            },
          }
        `)

        // On the 2nd call, lastInlineCompletionResult is provided.
        await provider.provideInlineCompletionItems(document, position, DUMMY_CONTEXT)
        expect(fn.mock.calls.map(call => call[0].lastCandidate?.result.items)).toEqual([[item]])
    })

    describe('logger', () => {
        test('logs a completion as shown', async () => {
            const spy = vi.spyOn(CompletionLogger, 'suggested')

            const { document, position } = documentAndPosition('const foo = █', 'typescript')
            const fn = vi.fn(getInlineCompletions).mockResolvedValue({
                logId: '1',
                items: [{ insertText: 'bar', range: new vsCodeMocks.Range(position, position) }],
                source: InlineCompletionsResultSource.Network,
            })

            const provider = new MockableInlineCompletionItemProvider(fn)
            await provider.provideInlineCompletionItems(document, position, DUMMY_CONTEXT)

            expect(spy).toHaveBeenCalled()
        })

        test('does not log a completion when the abort handler was triggered after a network fetch', async () => {
            const spy = vi.spyOn(CompletionLogger, 'suggested')

            let onCancel = () => {}
            const token: vscode.CancellationToken = {
                isCancellationRequested: false,
                onCancellationRequested(fn: any): vscode.Disposable {
                    onCancel = fn
                    return { dispose: () => {} }
                },
            }
            function cancel() {
                token.isCancellationRequested = true
                onCancel()
            }

            const { document, position } = documentAndPosition('const foo = █', 'typescript')
            const fn = vi.fn(getInlineCompletions).mockImplementation(() => {
                cancel()
                return Promise.resolve({
                    logId: '1',
                    items: [{ insertText: 'bar', range: new vsCodeMocks.Range(position, position) }],
                    source: InlineCompletionsResultSource.Network,
                })
            })

            const provider = new MockableInlineCompletionItemProvider(fn)
            await provider.provideInlineCompletionItems(document, position, DUMMY_CONTEXT, token)

            expect(spy).not.toHaveBeenCalled()
        })

        test('does not log a completion if it does not overlap the completion popup', async () => {
            const spy = vi.spyOn(CompletionLogger, 'suggested')

            const { document, position } = documentAndPosition('console.█', 'typescript')
            const fn = vi.fn(getInlineCompletions).mockResolvedValue({
                logId: '1',
                items: [{ insertText: 'log()', range: new vsCodeMocks.Range(position, position) }],
                source: InlineCompletionsResultSource.Network,
            })

            const provider = new MockableInlineCompletionItemProvider(fn)
            await provider.provideInlineCompletionItems(document, position, {
                triggerKind: vsCodeMocks.InlineCompletionTriggerKind.Automatic,
                selectedCompletionInfo: { text: 'dir', range: new vsCodeMocks.Range(0, 6, 0, 8) },
            })

            expect(spy).not.toHaveBeenCalled()
        })

        test('log a completion if the suffix is inside the completion', async () => {
            const spy = vi.spyOn(CompletionLogger, 'suggested')

            const { document, position } = documentAndPosition('const a = [1, █];', 'typescript')
            const fn = vi.fn(getInlineCompletions).mockResolvedValue({
                logId: '1',
                items: [{ insertText: '2] ;', range: new vsCodeMocks.Range(position, position) }],
                source: InlineCompletionsResultSource.Network,
            })

            const provider = new MockableInlineCompletionItemProvider(fn)
            await provider.provideInlineCompletionItems(document, position, DUMMY_CONTEXT)

            expect(spy).toHaveBeenCalled()
        })

        test('does not log a completion if the suffix does not match', async () => {
            const spy = vi.spyOn(CompletionLogger, 'suggested')

            const { document, position } = documentAndPosition('const a = [1, █)(123);', 'typescript')
            const fn = vi.fn(getInlineCompletions).mockResolvedValue({
                logId: '1',
                items: [{ insertText: '2];', range: new vsCodeMocks.Range(position, position) }],
                source: InlineCompletionsResultSource.Network,
            })

            const provider = new MockableInlineCompletionItemProvider(fn)
            await provider.provideInlineCompletionItems(document, position, DUMMY_CONTEXT)

            expect(spy).not.toHaveBeenCalled()
        })
    })
})
