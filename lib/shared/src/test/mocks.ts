import { URI } from 'vscode-uri'

import { BotResponseMultiplexer } from '../chat/bot-response-multiplexer'
import { RecipeContext } from '../chat/recipes/recipe'
import { CodebaseContext } from '../codebase-context'
import {
    ActiveTextEditor,
    ActiveTextEditorDiagnostic,
    ActiveTextEditorSelection,
    ActiveTextEditorSelectionRange,
    ActiveTextEditorVisibleContent,
    Editor,
} from '../editor'
import { EmbeddingsSearch } from '../embeddings'
import { IntentClassificationOption, IntentDetector } from '../intent-detector'
import { ContextResult, KeywordContextFetcher } from '../local-context'
import { SourcegraphCompletionsClient } from '../sourcegraph-api/completions/client'
import { CompletionParameters, CompletionResponse } from '../sourcegraph-api/completions/types'
import { EmbeddingsSearchResults } from '../sourcegraph-api/graphql'

export class MockEmbeddingsClient implements EmbeddingsSearch {
    constructor(private mocks: Partial<EmbeddingsSearch> = {}) {}

    public search(
        query: string,
        codeResultsCount: number,
        textResultsCount: number
    ): Promise<EmbeddingsSearchResults | Error> {
        return (
            this.mocks.search?.(query, codeResultsCount, textResultsCount) ??
            Promise.resolve({ codeResults: [], textResults: [] })
        )
    }
}

export class MockCompletionsClient extends SourcegraphCompletionsClient {
    constructor(private mocks: Partial<Pick<SourcegraphCompletionsClient, 'complete' | 'stream'>>) {
        super({
            accessToken: null,
            customHeaders: {},
            debugEnable: false,
            serverEndpoint: 'https://example.com',
        })
    }

    public stream(): () => void {
        throw new Error('mock stream is not implemented')
    }

    public complete(
        params: CompletionParameters,
        onChunk?: (incompleteResponse: CompletionResponse) => void,
        abortSignal?: AbortSignal
    ): Promise<CompletionResponse> {
        if (!this.mocks.complete) {
            throw new Error('mock complete is not provided')
        }
        return this.mocks.complete(params, onChunk, abortSignal)
    }
}

export class MockIntentDetector implements IntentDetector {
    constructor(private mocks: Partial<IntentDetector> = {}) {}

    public isCodebaseContextRequired(input: string): Promise<boolean | Error> {
        return this.mocks.isCodebaseContextRequired?.(input) ?? Promise.resolve(false)
    }

    public isEditorContextRequired(input: string): boolean | Error {
        return this.mocks.isEditorContextRequired?.(input) ?? false
    }

    public classifyIntentFromOptions<Intent extends string>(
        input: string,
        options: IntentClassificationOption<Intent>[],
        fallback: Intent
    ): Promise<Intent> {
        return Promise.resolve(fallback)
    }
}

export class MockKeywordContextFetcher implements KeywordContextFetcher {
    constructor(private mocks: Partial<KeywordContextFetcher> = {}) {}

    public getContext(query: string, numResults: number): Promise<ContextResult[]> {
        return this.mocks.getContext?.(query, numResults) ?? Promise.resolve([])
    }

    public getSearchContext(query: string, numResults: number): Promise<ContextResult[]> {
        return this.mocks.getSearchContext?.(query, numResults) ?? Promise.resolve([])
    }
}

export class MockEditor implements Editor {
    constructor(private mocks: Partial<Editor> = {}) {}

    public fileName = ''

    public getWorkspaceRootPath(): string | null {
        return this.mocks.getWorkspaceRootPath?.() ?? null
    }

    public getWorkspaceRootUri(): URI | null {
        return this.mocks.getWorkspaceRootUri?.() ?? null
    }

    public getActiveTextEditorSelection(): ActiveTextEditorSelection | null {
        return this.mocks.getActiveTextEditorSelection?.() ?? null
    }

    public getActiveTextEditorSelectionOrEntireFile(): ActiveTextEditorSelection | null {
        return this.mocks.getActiveTextEditorSelection?.() ?? null
    }

    public getActiveTextEditorSelectionOrVisibleContent(): ActiveTextEditorSelection | null {
        return this.mocks.getActiveTextEditorSelection?.() ?? null
    }

    public getActiveTextEditorDiagnosticsForRange(
        range: ActiveTextEditorSelectionRange
    ): ActiveTextEditorDiagnostic[] | null {
        return this.mocks.getActiveTextEditorDiagnosticsForRange?.(range) ?? null
    }

    public getActiveTextEditor(): ActiveTextEditor | null {
        return this.mocks.getActiveTextEditor?.() ?? null
    }

    public getActiveInlineChatTextEditor(): ActiveTextEditor | null {
        return this.mocks.getActiveTextEditor?.() ?? null
    }

    public getActiveInlineChatSelection(): ActiveTextEditorSelection | null {
        return this.mocks.getActiveTextEditorSelection?.() ?? null
    }

    public getActiveTextEditorVisibleContent(): ActiveTextEditorVisibleContent | null {
        return this.mocks.getActiveTextEditorVisibleContent?.() ?? null
    }

    public replaceSelection(fileName: string, selectedText: string, replacement: string): Promise<void> {
        return this.mocks.replaceSelection?.(fileName, selectedText, replacement) ?? Promise.resolve()
    }

    public showQuickPick(labels: string[]): Promise<string | undefined> {
        return this.mocks.showQuickPick?.(labels) ?? Promise.resolve(undefined)
    }

    public showWarningMessage(message: string): Promise<void> {
        return this.mocks.showWarningMessage?.(message) ?? Promise.resolve()
    }

    public showInputBox(prompt?: string): Promise<string | undefined> {
        return this.mocks.showInputBox?.(prompt) ?? Promise.resolve(undefined)
    }

    public didReceiveFixupText(id: string, text: string, state: 'streaming' | 'complete'): Promise<void> {
        return this.mocks.didReceiveFixupText?.(id, text, state) ?? Promise.resolve(undefined)
    }
}

export const defaultEmbeddingsClient = new MockEmbeddingsClient()

export const defaultIntentDetector = new MockIntentDetector()

export const defaultKeywordContextFetcher = new MockKeywordContextFetcher()

export const defaultEditor = new MockEditor()

export function newRecipeContext(args?: Partial<RecipeContext>): RecipeContext {
    args = args || {}
    return {
        editor: args.editor || defaultEditor,
        intentDetector: args.intentDetector || defaultIntentDetector,
        codebaseContext:
            args.codebaseContext ||
            new CodebaseContext(
                { useContext: 'none', serverEndpoint: 'https://example.com', experimentalLocalSymbols: false },
                'dummy-codebase',
                defaultEmbeddingsClient,
                defaultKeywordContextFetcher,
                null,
                null
            ),
        responseMultiplexer: args.responseMultiplexer || new BotResponseMultiplexer(),
        firstInteraction: args.firstInteraction ?? false,
    }
}
