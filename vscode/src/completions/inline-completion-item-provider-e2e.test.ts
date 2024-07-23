import {
    type AuthStatus,
    type GraphQLAPIClientConfig,
    contextFiltersProvider,
    graphqlClient,
    telemetryRecorder,
} from '@sourcegraph/cody-shared'
import { type MockInstance, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as vscode from 'vscode'
import { localStorage } from '../services/LocalStorageProvider'
import { DEFAULT_VSCODE_SETTINGS, vsCodeMocks } from '../testutils/mocks'
import * as CompletionProvider from './get-completion-provider'
import { getCurrentDocContext } from './get-current-doc-context'
import { TriggerKind } from './get-inline-completions'
import { initCompletionProviderConfig } from './get-inline-completions-tests/helpers'
import { InlineCompletionItemProvider } from './inline-completion-item-provider'
import * as CompletionLogger from './logger'
import { createProviderConfig } from './providers/anthropic'
import type { FetchCompletionResult } from './providers/fetch-and-process-completions'
import { Provider } from './providers/provider'
import type { RequestParams } from './request-manager'
import { documentAndPosition } from './test-helpers'
import type { InlineCompletionItemWithAnalytics } from './text-processing/process-inline-completions'
import { sleep } from './utils'

vi.mock('vscode', () => ({
    ...vsCodeMocks,
    workspace: {
        ...vsCodeMocks.workspace,
        onDidChangeTextDocument() {
            return null
        },
    },
}))

const DUMMY_CONTEXT: vscode.InlineCompletionContext = {
    selectedCompletionInfo: undefined,
    triggerKind: vsCodeMocks.InlineCompletionTriggerKind.Automatic,
}

const DUMMY_AUTH_STATUS: AuthStatus = {
    endpoint: 'https://fastsourcegraph.com',
    isDotCom: true,
    isLoggedIn: true,
    isFireworksTracingEnabled: false,
    showInvalidAccessTokenError: false,
    authenticated: true,
    hasVerifiedEmail: true,
    requiresVerifiedEmail: true,
    siteHasCodyEnabled: true,
    siteVersion: '1234',
    primaryEmail: 'heisenberg@exmaple.com',
    username: 'uwu',
    displayName: 'w.w.',
    avatarURL: '',
    userCanUpgrade: false,
    codyApiVersion: 0,
}

graphqlClient.setConfig({} as unknown as GraphQLAPIClientConfig)

const getAnalyticEventCalls = (mockInstance: MockInstance) => {
    return mockInstance.mock.calls.map(args => args.slice(0, 2))
}

class MockRequestProvider extends Provider {
    public didFinishNetworkRequest = false
    public didAbort = false
    protected next: () => void = () => {}
    protected responseQueue: FetchCompletionResult[][] = []

    public yield(completions: string[] | InlineCompletionItemWithAnalytics[], keepAlive = false) {
        const result = completions.map(content =>
            typeof content === 'string'
                ? {
                      completion: { insertText: content, stopReason: 'test' },
                      docContext: this.options.docContext,
                  }
                : {
                      completion: content,
                      docContext: this.options.docContext,
                  }
        )

        this.responseQueue.push(result)
        this.didFinishNetworkRequest = !keepAlive
        this.next()
    }

    public async *generateCompletions(
        abortSignal: AbortSignal
    ): AsyncGenerator<FetchCompletionResult[]> {
        abortSignal.addEventListener('abort', () => {
            this.didAbort = true
        })

        while (!(this.didFinishNetworkRequest && this.responseQueue.length === 0)) {
            while (this.responseQueue.length > 0) {
                yield this.responseQueue.shift()!
            }

            // Wait for the next yield
            this.responseQueue = []
            if (!this.didFinishNetworkRequest) {
                await new Promise<void>(resolve => {
                    this.next = resolve
                })
            }
        }
    }
}

function getInlineCompletionProvider(
    args: Partial<ConstructorParameters<typeof InlineCompletionItemProvider>[0]> = {}
): InlineCompletionItemProvider {
    return new InlineCompletionItemProvider({
        completeSuggestWidgetSelection: true,
        statusBar: { addError: () => {}, hasError: () => {}, startLoading: () => {} } as any,
        providerConfig: createProviderConfig({ client: null as any }),
        authStatus: DUMMY_AUTH_STATUS,
        firstCompletionTimeout:
            args?.firstCompletionTimeout ?? DEFAULT_VSCODE_SETTINGS.autocompleteFirstCompletionTimeout,
        ...args,
    })
}

function createNetworkProvider(params: RequestParams): MockRequestProvider {
    return new MockRequestProvider({
        id: 'mock-provider',
        docContext: params.docContext,
        document: params.document,
        position: params.position,
        multiline: false,
        n: 1,
        firstCompletionTimeout: 1500,
        triggerKind: TriggerKind.Automatic,
        completionLogId: 'mock-log-id' as CompletionLogger.CompletionLogID,
    })
}

function createCompletion(textWithCursor: string, provider: InlineCompletionItemProvider) {
    const { document, position } = documentAndPosition(textWithCursor)
    const docContext = getCurrentDocContext({
        document,
        position,
        maxPrefixLength: 1000,
        maxSuffixLength: 1000,
        context: undefined,
    })

    const mockRequestProvider = createNetworkProvider({
        document,
        position,
        docContext,
    } as RequestParams)

    return {
        mockRequestProvider,
        resolve: async (
            completion: string,
            { delay = 0, duration = 0 }: { delay: number; duration: number }
        ) => {
            await sleep(delay)
            const promise = provider.provideInlineCompletionItems(document, position, DUMMY_CONTEXT)
            await sleep(duration)
            mockRequestProvider.yield([completion])
            return promise
        },
    }
}

describe('InlineCompletionItemProvider E2E', () => {
    describe('smart throttle in-flight requests', () => {
        let getCompletionProviderSpy: MockInstance

        beforeAll(async () => {
            await initCompletionProviderConfig({ autocompleteExperimentalSmartThrottle: true })
            localStorage.setStorage({
                get: () => null,
                update: () => {},
            } as any as vscode.Memento)
        })

        beforeEach(() => {
            vi.spyOn(contextFiltersProvider, 'isUriIgnored').mockResolvedValue(false)
            getCompletionProviderSpy = vi.spyOn(CompletionProvider, 'getCompletionProvider')
        })

        /**
         * Scenario:
         * R1--------
         *          ^Suggested
         *             R2-------- (different prefix)
         *                       ^Suggested
         */
        it('handles subsequent requests, that are not parallel', async () => {
            const logSpy: MockInstance = vi.spyOn(telemetryRecorder, 'recordEvent')
            const provider = getInlineCompletionProvider()

            const { mockRequestProvider: provider1, resolve: resolve1 } = createCompletion(
                'console.█',
                provider
            )
            const { mockRequestProvider: provider2, resolve: resolve2 } = createCompletion(
                'console.log(█',
                provider
            )

            getCompletionProviderSpy.mockReturnValueOnce(provider1).mockReturnValueOnce(provider2)

            // Let the first completion resolve first
            const result1 = await resolve1("error('hello')", { duration: 0 })

            // Now let the second completion resolve
            const result2 = await resolve2("'hello')", { duration: 0 })

            // Result 1 is used
            expect(result1).toBeDefined()
            // Result 2 is used
            expect(result2).toBeDefined()

            CompletionLogger.logSuggestionEvents(true)

            expect(getAnalyticEventCalls(logSpy)).toMatchInlineSnapshot(`
              [
                [
                  "cody.completion",
                  "suggested",
                ],
                [
                  "cody.completion",
                  "suggested",
                ],
              ]
            `)
        })

        /**
         * Scenario:
         * R1----------
         *     ^Stale (not suggested)
         *     R2------
         *            ^Synthesised from R1 result
         *            ^Suggested
         */
        it('handles two parallel requests, by marking the old one as stale and only suggesting the final one', async () => {
            vi.useFakeTimers()
            const logSpy: MockInstance = vi.spyOn(telemetryRecorder, 'recordEvent')
            const provider = getInlineCompletionProvider()

            const { mockRequestProvider: provider1, resolve: resolve1 } = createCompletion(
                'console.█',
                provider
            )
            const { mockRequestProvider: provider2, resolve: resolve2 } = createCompletion(
                'console.log(█',
                provider
            )

            getCompletionProviderSpy.mockReturnValueOnce(provider1).mockReturnValueOnce(provider2)

            const [result1, result2] = await Promise.all([
                resolve1("log('hello')", { duration: 100 }),
                resolve2("'hello')", { duration: 150 }),
                vi.advanceTimersByTimeAsync(150), // Enough for both to be shown
            ])

            // Result 1 is marked as stale
            expect(result1).toBeNull()
            // Result 2 is used
            expect(result2).toBeDefined()

            // Enough for completion events to be logged
            vi.advanceTimersByTime(1000)
            CompletionLogger.logSuggestionEvents(true)

            expect(getAnalyticEventCalls(logSpy)).toMatchInlineSnapshot(`
              [
                [
                  "cody.completion",
                  "synthesizedFromParallelRequest",
                ],
                [
                  "cody.completion",
                  "suggested",
                ],
              ]
            `)
        })

        /**
         * Scenario:
         * R1-----------------
         *            ^Stale (not suggested)
         *            R2------
         *                   ^Synthesised from R1 result
         *                   ^Marked for suggestion (with matching logId)
         *                   ^Suggested
         *               R3---
         *                   ^Synthesised from R1 result
         *                   ^Marked for suggestion (with matching logId). Will not be sugested as R2 will be suggested first.
         */
        it('handles multiple parallel requests, by marking the old one as stale and only suggesting one of the remaining ones', async () => {
            vi.useFakeTimers()
            const logSpy: MockInstance = vi.spyOn(telemetryRecorder, 'recordEvent')
            const provider = getInlineCompletionProvider()

            const { mockRequestProvider: provider1, resolve: resolve1 } = createCompletion(
                'console.█',
                provider
            )
            const { mockRequestProvider: provider2, resolve: resolve2 } = createCompletion(
                'console.log(█',
                provider
            )
            const { mockRequestProvider: provider3, resolve: resolve3 } = createCompletion(
                "console.log('h█",
                provider
            )

            getCompletionProviderSpy
                .mockReturnValueOnce(provider1)
                .mockReturnValueOnce(provider2)
                .mockReturnValueOnce(provider3)

            const [result1, result2, result3] = await Promise.all([
                // The first completion will be triggered immediately, but takes a while to resolve
                resolve1("log('hello')", {
                    delay: 0,
                    duration: 800, // Ensure that this request is still in-flight when the next one starts
                }),
                // The second completion will be triggered before the first completion resolves, but also takes a while to resolve
                resolve2("'hello')", {
                    delay: 300, // Ensure that this request is made in-flight, as it bypasses the smart-throttle timeout
                    duration: 800,
                }),
                // The third completion will be triggered before both the first and second completions resolve.
                // It should be the only one that is suggested.
                resolve3("ello')", {
                    delay: 400, // Ensure that this request is made in-flight, as it bypasses the smart-throttle timeout
                    duration: 800,
                }),
                vi.advanceTimersByTimeAsync(2000), // Enough for all to be shown
            ])

            // Result 1 is marked as stale
            expect(result1).toBeNull()
            // Result 2 is used
            expect(result2).toBeDefined()
            // Result 3 is used
            expect(result3).toBeDefined()

            // Enough for completion events to be logged
            vi.advanceTimersByTime(1000)
            CompletionLogger.logSuggestionEvents(true)

            expect(getAnalyticEventCalls(logSpy)).toMatchInlineSnapshot(`
              [
                [
                  "cody.completion",
                  "synthesizedFromParallelRequest",
                ],
                [
                  "cody.completion",
                  "synthesizedFromParallelRequest",
                ],
                [
                  "cody.completion",
                  "suggested",
                ],
              ]
            `)
        })
    })
})
