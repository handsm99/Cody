import {
    AUTH_STATUS_FIXTURE_AUTHED,
    type AuthenticatedAuthStatus,
    type ChatClient,
    type ContextItem,
    ContextItemSource,
    DOTCOM_URL,
    featureFlagProvider,
    mockAuthStatus,
    modelsService,
    ps,
} from '@sourcegraph/cody-shared'
import { Observable } from 'observable-fns'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { URI } from 'vscode-uri'
import { ChatBuilder } from '../../chat/chat-view/ChatBuilder'
import type { ContextRetriever } from '../../chat/chat-view/ContextRetriever'
import * as initialContext from '../../chat/initialContext'
import { DeepCodyAgent } from './DeepCodyAgent'

describe('DeepCodyAgent', () => {
    const codyProAuthStatus: AuthenticatedAuthStatus = {
        ...AUTH_STATUS_FIXTURE_AUTHED,
        endpoint: DOTCOM_URL.toString(),
        authenticated: true,
        userCanUpgrade: false,
    }
    const enterpriseAuthStatus: AuthenticatedAuthStatus = {
        ...AUTH_STATUS_FIXTURE_AUTHED,
        endpoint: 'https://example.sourcegraph.com',
        authenticated: true,
        userCanUpgrade: false,
    }

    let mockChatBuilder: ChatBuilder
    let mockChatClient: ChatClient
    let mockContextRetriever: ContextRetriever
    let mockSpan: any
    let mockCurrentContext: ContextItem[]

    beforeEach(() => {
        mockAuthStatus(codyProAuthStatus)
        mockChatBuilder = {
            selectedModel: 'anthropic::2023-06-01::deep-cody',
            changes: {
                pipe: vi.fn(),
            },
            resolvedModelForChat: vi.fn().mockReturnValue('anthropic::2023-06-01::deep-cody'),
            addHumanMessage: vi.fn(),
            addBotMessage: vi.fn(),
            contextWindowForChat: vi.fn().mockReturnValue({ input: 10000, output: 1000 }),
            getDehydratedMessages: vi.fn().mockReturnValue([
                {
                    speaker: 'human',
                    text: ps`test message`,
                },
            ]),
        } as unknown as ChatBuilder

        mockChatClient = {
            chat: vi.fn(),
        } as unknown as ChatClient

        mockContextRetriever = {
            retrieveContext: vi.fn(),
        } as unknown as ContextRetriever

        mockSpan = {}

        mockCurrentContext = [
            {
                uri: URI.file('/path/to/file.ts'),
                type: 'file',
                isTooLarge: undefined,
                source: ContextItemSource.User,
                content: 'const example = "test";',
            },
        ]

        vi.spyOn(featureFlagProvider, 'evaluatedFeatureFlag').mockReturnValue(Observable.of(false))
        vi.spyOn(modelsService, 'isStreamDisabled').mockReturnValue(false)
        vi.spyOn(ChatBuilder, 'resolvedModelForChat').mockReturnValue(
            Observable.of('anthropic::2023-06-01::deep-cody')
        )
        vi.spyOn(ChatBuilder, 'contextWindowForChat').mockReturnValue(
            Observable.of({ input: 10000, output: 1000 })
        )
        // Ensure mockChatBuilder has a changes property
        mockChatBuilder.changes = Observable.of(mockChatBuilder)
        vi.spyOn(modelsService, 'observeContextWindowByID').mockReturnValue(
            Observable.of({ input: 10000, output: 1000 })
        )
    })

    it('initializes correctly for dotcom user', async () => {
        const agent = new DeepCodyAgent(
            mockChatBuilder,
            mockChatClient,
            mockContextRetriever,
            mockSpan,
            mockCurrentContext
        )

        expect(agent).toBeDefined()
    })

    it('retrieves additional context when enabled', async () => {
        const mockStreamResponse = [
            { type: 'change', text: '<CODYTOOLSEARCH><query>test query</query></CODYTOOLSEARCH>' },
            { type: 'complete' },
        ]

        mockChatClient.chat = vi.fn().mockReturnValue(mockStreamResponse)

        mockContextRetriever.retrieveContext = vi.fn().mockResolvedValue([
            {
                type: 'file',
                uri: URI.file('/path/to/repo/newfile.ts'),
                content: 'const newExample = "test result";',
            },
        ])

        vi.spyOn(initialContext, 'getCorpusContextItemsForEditorState').mockReturnValue(
            Observable.of([
                {
                    type: 'tree',
                    uri: URI.file('/path/to/repo/'),
                    name: 'Mock Repository',
                    isWorkspaceRoot: true,
                    content: null,
                    source: ContextItemSource.Initial,
                },
            ])
        )

        const agent = new DeepCodyAgent(
            mockChatBuilder,
            mockChatClient,
            mockContextRetriever,
            mockSpan,
            mockCurrentContext
        )

        const result = await agent.getContext({ aborted: false } as AbortSignal)

        expect(mockChatClient.chat).toHaveBeenCalled()
        expect(mockContextRetriever.retrieveContext).toHaveBeenCalled()
        expect(result).toHaveLength(1)
        expect(result[0].content).toBe('const newExample = "test result";')
    })

    it('does not retrieve additional context for enterprise user without feature flag', async () => {
        vi.spyOn(featureFlagProvider, 'evaluatedFeatureFlag').mockReturnValue(Observable.of(false))
        mockAuthStatus(enterpriseAuthStatus)
        expect(mockChatClient.chat).not.toHaveBeenCalled()
        expect(mockContextRetriever.retrieveContext).not.toHaveBeenCalled()
    })
})
