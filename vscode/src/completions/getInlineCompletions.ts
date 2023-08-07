import * as vscode from 'vscode'
import { URI } from 'vscode-uri'

import { CodebaseContext } from '@sourcegraph/cody-shared/src/codebase-context'
import { isDefined } from '@sourcegraph/cody-shared/src/common'

import { debug } from '../log'

import { GetContextOptions, GetContextResult } from './context'
import { DocumentContext, getCurrentDocContext } from './document'
import { DocumentHistory } from './history'
import * as CompletionLogger from './logger'
import { detectMultiline } from './multiline'
import { processInlineCompletions } from './processInlineCompletions'
import { CompletionProviderTracer, Provider, ProviderConfig, ProviderOptions } from './providers/provider'
import { RequestManager, RequestParams } from './request-manager'
import { ProvideInlineCompletionsItemTraceData } from './tracer'
import { InlineCompletionItem } from './types'
import { isAbortError, SNIPPET_WINDOW_SIZE } from './utils'

export interface InlineCompletionsParams {
    // Context
    document: vscode.TextDocument
    position: vscode.Position
    context: vscode.InlineCompletionContext

    // Prompt parameters
    promptChars: number
    maxPrefixChars: number
    maxSuffixChars: number
    providerConfig: ProviderConfig
    responsePercentage: number
    prefixPercentage: number
    suffixPercentage: number
    isEmbeddingsContextEnabled: boolean

    // Platform
    toWorkspaceRelativePath: (uri: URI) => string

    // Injected
    contextFetcher?: (options: GetContextOptions) => Promise<GetContextResult>
    getCodebaseContext?: () => CodebaseContext
    documentHistory?: DocumentHistory

    // Shared
    requestManager: RequestManager

    // UI state
    lastCandidate?: LastInlineCompletionCandidate
    debounceInterval?: { singleLine: number; multiLine: number }
    setIsLoading?: (isLoading: boolean) => void

    // Execution
    abortSignal?: AbortSignal
    tracer?: (data: Partial<ProvideInlineCompletionsItemTraceData>) => void
}

/**
 * The last-suggested ghost text result, which can be reused if it is still valid.
 */
export interface LastInlineCompletionCandidate {
    /** The document URI for which this candidate was generated. */
    uri: URI

    /** The position at which this candidate was generated. */
    lastTriggerPosition: vscode.Position

    /** The prefix of the line (before the cursor position) where this candidate was generated. */
    lastTriggerLinePrefix: string

    /** The previously suggested result. */
    result: Pick<InlineCompletionsResult, 'logId' | 'items'>
}

/**
 * The result of a call to {@link getInlineCompletions}.
 */
export interface InlineCompletionsResult {
    /** The unique identifier for logging this result. */
    logId: string

    /** Where this result was generated from. */
    source: InlineCompletionsResultSource

    /** The completions. */
    items: InlineCompletionItem[]
}

/**
 * The source of the inline completions result.
 */
export enum InlineCompletionsResultSource {
    Network,
    Cache,
    CacheAfterRequestStart,

    /**
     * The user is typing as suggested by the currently visible ghost text. For example, if the
     * user's editor shows ghost text `abc` ahead of the cursor, and the user types `ab`, the
     * original completion should be reused because it is still relevant.
     *
     * The last suggestion is passed in {@link InlineCompletionsParams.lastCandidate}.
     */
    LastCandidate,
}

export async function getInlineCompletions(params: InlineCompletionsParams): Promise<InlineCompletionsResult | null> {
    try {
        const result = await doGetInlineCompletions(params)
        if (result) {
            debug('getInlineCompletions:result', InlineCompletionsResultSource[result.source])
        } else {
            debug('getInlineCompletions:noResult', '')
        }
        params.tracer?.({ result })
        return result
    } catch (unknownError: unknown) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const error = unknownError instanceof Error ? unknownError : new Error(unknownError as any)

        params.tracer?.({ error: error.toString() })

        if (isAbortError(error)) {
            debug('getInlineCompletions:error', error.message, { verbose: error })
            return null
        }

        throw error
    } finally {
        params.setIsLoading?.(false)
    }
}

async function doGetInlineCompletions({
    document,
    position,
    context,
    promptChars,
    maxPrefixChars,
    maxSuffixChars,
    providerConfig,
    responsePercentage,
    prefixPercentage,
    suffixPercentage,
    isEmbeddingsContextEnabled,
    toWorkspaceRelativePath,
    contextFetcher,
    getCodebaseContext,
    documentHistory,
    requestManager,
    lastCandidate,
    debounceInterval,
    setIsLoading,
    abortSignal,
    tracer,
}: InlineCompletionsParams): Promise<InlineCompletionsResult | null> {
    tracer?.({ params: { document, position, context } })

    const docContext = getCurrentDocContext(document, position, maxPrefixChars, maxSuffixChars)
    if (!docContext) {
        return null
    }

    // If we have a suffix in the same line as the cursor and the suffix contains any word
    // characters, do not attempt to make a completion. This means we only make completions if
    // we have a suffix in the same line for special characters like `)]}` etc.
    //
    // VS Code will attempt to merge the remainder of the current line by characters but for
    // words this will easily get very confusing.
    if (/\w/.test(docContext.currentLineSuffix)) {
        return null
    }

    // Check if the user is typing as suggested by the last candidate completion (that is shown as
    // ghost text in the editor), and reuse it if it is still valid.
    const resultToReuse = lastCandidate
        ? reuseResultFromLastCandidate({ document, position, lastCandidate, docContext })
        : null
    if (resultToReuse) {
        return resultToReuse
    }

    const multiline = detectMultiline(docContext, document.languageId, providerConfig.enableExtendedMultilineTriggers)

    // Only log a completion as started if it's either served from cache _or_ the debounce interval
    // has passed to ensure we don't log too many start events where we end up not doing any work at
    // all.
    CompletionLogger.clear()
    const logId = CompletionLogger.create({
        multiline,
        providerIdentifier: providerConfig.identifier,
        languageId: document.languageId,
    })

    // Debounce to avoid firing off too many network requests as the user is still typing.
    const interval = multiline ? debounceInterval?.multiLine : debounceInterval?.singleLine
    if (interval !== undefined && interval > 0) {
        await new Promise<void>(resolve => setTimeout(resolve, interval))
    }

    // We don't need to make a request at all if the signal is already aborted after the debounce.
    if (abortSignal?.aborted) {
        return null
    }

    setIsLoading?.(true)
    CompletionLogger.start(logId)

    // Fetch context
    const contextResult = await getCompletionContext({
        document,
        promptChars,
        isEmbeddingsContextEnabled,
        contextFetcher,
        getCodebaseContext,
        documentHistory,
        docContext,
    })
    if (abortSignal?.aborted) {
        return null
    }
    tracer?.({ context: contextResult })

    // Completion providers
    const completionProviders = getCompletionProviders({
        document,
        context,
        providerConfig,
        responsePercentage,
        prefixPercentage,
        suffixPercentage,
        multiline,
        docContext,
        toWorkspaceRelativePath,
    })
    tracer?.({ completers: completionProviders.map(({ options }) => options) })

    CompletionLogger.networkRequestStarted(logId, contextResult?.logSummary ?? null)

    const reqContext: RequestParams = {
        uri: document.uri.toString(),
        prefix: docContext.prefix,
        suffix: docContext.suffix,
        position: document.offsetAt(position),
        languageId: document.languageId,
        multiline,
    }

    // Get completions from providers
    const { completions, cacheHit } = await requestManager.request(
        reqContext,
        completionProviders,
        contextResult?.context ?? [],
        abortSignal,
        tracer ? createCompletionProviderTracer(tracer) : undefined
    )

    if (abortSignal?.aborted) {
        return null
    }

    // Shared post-processing logic
    const processedCompletions = processInlineCompletions(
        completions.map(item => ({ insertText: item.content })),
        {
            document,
            position,
            multiline,
            docContext,
        }
    )
    logCompletions(logId, processedCompletions, document, context)
    return {
        logId,
        items: processedCompletions,
        source:
            cacheHit === 'hit'
                ? InlineCompletionsResultSource.Cache
                : cacheHit === 'hit-after-request-started'
                ? InlineCompletionsResultSource.CacheAfterRequestStart
                : InlineCompletionsResultSource.Network,
    }
}

function isWhitespace(s: string): boolean {
    return /^\s*$/.test(s)
}

/**
 * See test cases for the expected behaviors.
 */
function reuseResultFromLastCandidate({
    document,
    position,
    lastCandidate: { lastTriggerPosition, lastTriggerLinePrefix, ...lastCandidate },
    docContext: { currentLinePrefix, currentLineSuffix },
}: Required<Pick<InlineCompletionsParams, 'document' | 'position' | 'lastCandidate'>> & {
    docContext: DocumentContext
}): InlineCompletionsResult | null {
    const isSameDocument = lastCandidate.uri.toString() === document.uri.toString()
    const isSameLine = lastTriggerPosition.line === position.line

    if (!isSameDocument || !isSameLine) {
        return null
    }

    // There are 2 reasons we can reuse a candidate: typing-as-suggested or change-of-indentation.

    const isIndentation = isWhitespace(currentLinePrefix) && currentLinePrefix.startsWith(lastTriggerLinePrefix)
    const isDeindentation = isWhitespace(lastTriggerLinePrefix) && lastTriggerLinePrefix.startsWith(currentLinePrefix)
    const isIndentationChange = currentLineSuffix === '' && (isIndentation || isDeindentation)

    const itemsToReuse = lastCandidate.result.items
        .map((item, index): { item: InlineCompletionItem; isLastVisibleResult: boolean } | undefined => {
            const isLastVisibleResult = index === 0

            // Allow reuse if the user is (possibly) typing forward as suggested by the last
            // candidate completion. We still need to filter the candidate items to see which ones
            // the user's typing actually follows.
            const originalCompletion = lastTriggerLinePrefix + item.insertText
            const isTypingAsSuggested =
                originalCompletion.startsWith(currentLinePrefix) && position.isAfterOrEqual(lastTriggerPosition)
            if (isTypingAsSuggested) {
                return { item: { insertText: originalCompletion.slice(currentLinePrefix.length) }, isLastVisibleResult }
            }

            // Allow reuse if only the indentation (leading whitespace) has changed.
            if (isIndentationChange) {
                return {
                    item: { insertText: lastTriggerLinePrefix.slice(currentLinePrefix.length) + item.insertText },
                    isLastVisibleResult,
                }
            }

            return undefined
        })
        .filter(isDefined)

    if (itemsToReuse.length > 0) {
        // itemsToReuse MUST contain the completion that was previously visible (the completion
        // appearing at the first index). If it does not, the visible item will change, causing
        // unwanted UI churn.
        const newLastVisibleIndex = itemsToReuse.findIndex(item => item.isLastVisibleResult)
        if (newLastVisibleIndex === -1) {
            return null
        }

        // If itemsToReuse contains the item but not on the first place for some reason, reorder to
        // make sure the visible item remains stable
        if (newLastVisibleIndex !== 0) {
            const lastVisibleItem = itemsToReuse[newLastVisibleIndex]
            itemsToReuse.splice(newLastVisibleIndex, 1)
            itemsToReuse.unshift(lastVisibleItem)
        }

        return {
            // Reuse the logId to so that typing text of a displayed completion will not log a new
            // completion on every keystroke.
            logId: lastCandidate.result.logId,

            source: InlineCompletionsResultSource.LastCandidate,
            items: itemsToReuse.map(({ item }) => item),
        }
    }
    return null
}

interface GetCompletionProvidersParams
    extends Pick<
        InlineCompletionsParams,
        | 'document'
        | 'context'
        | 'providerConfig'
        | 'responsePercentage'
        | 'prefixPercentage'
        | 'suffixPercentage'
        | 'toWorkspaceRelativePath'
    > {
    multiline: boolean
    docContext: DocumentContext
}

function getCompletionProviders({
    document,
    context,
    providerConfig,
    responsePercentage,
    prefixPercentage,
    suffixPercentage,
    multiline,
    docContext: { prefix, suffix },
    toWorkspaceRelativePath,
}: GetCompletionProvidersParams): Provider[] {
    const sharedProviderOptions: Omit<ProviderOptions, 'id' | 'n' | 'multiline'> = {
        prefix,
        suffix,
        fileName: toWorkspaceRelativePath(document.uri),
        languageId: document.languageId,
        responsePercentage,
        prefixPercentage,
        suffixPercentage,
    }
    if (multiline) {
        return [
            providerConfig.create({
                id: 'multiline',
                ...sharedProviderOptions,
                n: 3, // 3 vs. 1 does not meaningfully affect perf
                multiline: true,
            }),
        ]
    }
    return [
        providerConfig.create({
            id: 'single-line-suffix',
            ...sharedProviderOptions,
            // Show more if manually triggered (but only showing 1 is faster, so we use it
            // in the automatic trigger case).
            n: context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic ? 1 : 3,
            multiline: false,
        }),
    ]
}

interface GetCompletionContextParams
    extends Pick<
        InlineCompletionsParams,
        | 'document'
        | 'promptChars'
        | 'isEmbeddingsContextEnabled'
        | 'contextFetcher'
        | 'getCodebaseContext'
        | 'documentHistory'
    > {
    docContext: DocumentContext
}

async function getCompletionContext({
    document,
    promptChars,
    isEmbeddingsContextEnabled,
    contextFetcher,
    getCodebaseContext,
    documentHistory,
    docContext: { prefix, suffix },
}: GetCompletionContextParams): Promise<GetContextResult | null> {
    if (!contextFetcher) {
        return null
    }
    if (!getCodebaseContext) {
        throw new Error('getCodebaseContext is required if contextFetcher is provided')
    }
    if (!documentHistory) {
        throw new Error('documentHistory is required if contextFetcher is provided')
    }

    return contextFetcher({
        document,
        prefix,
        suffix,
        history: documentHistory,
        jaccardDistanceWindowSize: SNIPPET_WINDOW_SIZE,
        maxChars: promptChars,
        getCodebaseContext,
        isEmbeddingsContextEnabled,
    })
}

function createCompletionProviderTracer(
    tracer: InlineCompletionsParams['tracer']
): CompletionProviderTracer | undefined {
    return (
        tracer && {
            params: data => tracer({ completionProviderCallParams: data }),
            result: data => tracer({ completionProviderCallResult: data }),
        }
    )
}

function logCompletions(
    logId: string,
    completions: InlineCompletionItem[],
    document: vscode.TextDocument,
    context: vscode.InlineCompletionContext
): void {
    if (completions.length > 0) {
        // When the VS Code completion popup is open and we suggest a completion that does not match
        // the currently selected completion, VS Code won't display it. For now we make sure to not
        // log these completions as displayed.
        //
        // TODO: Take this into account when creating the completion prefix.
        let isCompletionVisible = true
        if (context.selectedCompletionInfo) {
            const currentText = document.getText(context.selectedCompletionInfo.range)
            const selectedText = context.selectedCompletionInfo.text
            if (!(currentText + completions[0].insertText).startsWith(selectedText)) {
                isCompletionVisible = false
            }
        }

        if (isCompletionVisible) {
            CompletionLogger.suggest(logId, isCompletionVisible)
        }
    } else {
        CompletionLogger.noResponse(logId)
    }
}
