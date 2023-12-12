import * as vscode from 'vscode'

import { tokensToChars } from '@sourcegraph/cody-shared/src/prompt/constants'

import { CodeCompletionsClient, CodeCompletionsParams } from '../client'
import { DocumentContext } from '../get-current-doc-context'
import {
    CLOSING_CODE_TAG,
    extractFromCodeBlock,
    fixBadCompletionStart,
    getHeadAndTail,
    MULTILINE_STOP_SEQUENCE,
    OPENING_CODE_TAG,
    trimLeadingWhitespaceUntilNewline,
} from '../text-processing'
import { InlineCompletionItemWithAnalytics } from '../text-processing/process-inline-completions'
import { ContextSnippet } from '../types'

import { fetchAndProcessCompletions, fetchAndProcessDynamicMultilineCompletions } from './fetch-and-process-completions'
import {
    CompletionProviderTracer,
    Provider,
    ProviderConfig,
    ProviderOptions,
    standardContextSizeHints,
} from './provider'

const MAX_RESPONSE_TOKENS = 256

const MULTI_LINE_STOP_SEQUENCES = [CLOSING_CODE_TAG]
const SINGLE_LINE_STOP_SEQUENCES = [CLOSING_CODE_TAG, MULTILINE_STOP_SEQUENCE]

const SINGLE_LINE_COMPLETION_ARGS: Pick<CodeCompletionsParams, 'maxTokensToSample' | 'stopSequences' | 'timeoutMs'> = {
    maxTokensToSample: 50,
    stopSequences: SINGLE_LINE_STOP_SEQUENCES,
    timeoutMs: 5_000,
}
const MULTI_LINE_COMPLETION_ARGS: Pick<CodeCompletionsParams, 'maxTokensToSample' | 'stopSequences' | 'timeoutMs'> = {
    maxTokensToSample: MAX_RESPONSE_TOKENS,
    stopSequences: MULTI_LINE_STOP_SEQUENCES,
    timeoutMs: 15_000,
}

interface UnstableOpenAIOptions {
    maxContextTokens?: number
    client: Pick<CodeCompletionsClient, 'complete'>
}

const PROVIDER_IDENTIFIER = 'unstable-openai'

export class UnstableOpenAIProvider extends Provider {
    private client: Pick<CodeCompletionsClient, 'complete'>
    private promptChars: number
    private instructions = `You are a code completion AI designed to take the surrounding code and shared context into account in order to predict and suggest high-quality code to complete the code enclosed in ${OPENING_CODE_TAG} tags.  You only respond with code that works and fits seamlessly with surrounding code. Do not include anything else beyond the code.`

    constructor(options: ProviderOptions, { maxContextTokens, client }: Required<UnstableOpenAIOptions>) {
        super(options)
        this.promptChars = tokensToChars(maxContextTokens - MAX_RESPONSE_TOKENS)
        this.client = client
    }

    public emptyPromptLength(): number {
        const promptNoSnippets = [this.instructions, this.createPromptPrefix()].join('\n\n')
        return promptNoSnippets.length - 10 // extra 10 chars of buffer cuz who knows
    }

    private createPromptPrefix(): string {
        const prefixLines = this.options.docContext.prefix.split('\n')
        if (prefixLines.length === 0) {
            throw new Error('no prefix lines')
        }

        const { head, tail } = getHeadAndTail(this.options.docContext.prefix)

        // Infill block represents the code we want the model to complete
        const infillBlock = tail.trimmed.endsWith('{\n') ? tail.trimmed.trimEnd() : tail.trimmed
        // code before the cursor, without the code extracted for the infillBlock
        const infillPrefix = head.raw
        // code after the cursor
        const infillSuffix = this.options.docContext.suffix
        const relativeFilePath = vscode.workspace.asRelativePath(this.options.document.fileName)

        return `Below is the code from file path ${relativeFilePath}. Review the code outside the XML tags to detect the functionality, formats, style, patterns, and logics in use. Then, use what you detect and reuse methods/libraries to complete and enclose completed code only inside XML tags precisely without duplicating existing implementations. Here is the code:\n\`\`\`\n${infillPrefix}${OPENING_CODE_TAG}${CLOSING_CODE_TAG}${infillSuffix}\n\`\`\`

${OPENING_CODE_TAG}${infillBlock}`
    }

    // Creates the resulting prompt and adds as many snippets from the reference
    // list as possible.
    protected createPrompt(snippets: ContextSnippet[]): string {
        const prefix = this.createPromptPrefix()

        const referenceSnippetMessages: string[] = []

        let remainingChars = this.promptChars - this.emptyPromptLength()

        for (const snippet of snippets) {
            const snippetMessages: string[] = [
                'symbol' in snippet && snippet.symbol !== ''
                    ? `Additional documentation for \`${snippet.symbol}\`: ${OPENING_CODE_TAG}${snippet.content}${CLOSING_CODE_TAG}`
                    : `Codebase context from file path '${snippet.fileName}': ${OPENING_CODE_TAG}${snippet.content}${CLOSING_CODE_TAG}`,
            ]
            const numSnippetChars = snippetMessages.join('\n\n').length + 1
            if (numSnippetChars > remainingChars) {
                break
            }
            referenceSnippetMessages.push(...snippetMessages)
            remainingChars -= numSnippetChars
        }

        const messages = [this.instructions, ...referenceSnippetMessages, prefix]
        return messages.join('\n\n')
    }

    public async generateCompletions(
        abortSignal: AbortSignal,
        snippets: ContextSnippet[],
        onCompletionReady: (completions: InlineCompletionItemWithAnalytics[]) => void,
        onHotStreakCompletionReady: (
            docContext: DocumentContext,
            completions: InlineCompletionItemWithAnalytics
        ) => void,
        tracer?: CompletionProviderTracer
    ): Promise<void> {
        const prompt = this.createPrompt(snippets)
        const { multiline, n, dynamicMultilineCompletions, hotStreak } = this.options

        const useExtendedGeneration = multiline || dynamicMultilineCompletions || hotStreak

        const requestParams: CodeCompletionsParams = {
            ...(useExtendedGeneration ? MULTI_LINE_COMPLETION_ARGS : SINGLE_LINE_COMPLETION_ARGS),
            messages: [{ speaker: 'human', text: prompt }],
            temperature: 1,
            topP: 0.5,
        }

        const fetchAndProcessCompletionsImpl = dynamicMultilineCompletions
            ? fetchAndProcessDynamicMultilineCompletions
            : fetchAndProcessCompletions

        tracer?.params(requestParams)

        const completions: InlineCompletionItemWithAnalytics[] = []
        const onCompletionReadyImpl = (completion: InlineCompletionItemWithAnalytics): void => {
            completions.push(completion)
            if (completions.length === n) {
                tracer?.result({ completions })
                onCompletionReady(completions)
            }
        }

        await Promise.all(
            Array.from({ length: n }).map(() => {
                return fetchAndProcessCompletionsImpl({
                    client: this.client,
                    requestParams,
                    abortSignal,
                    providerSpecificPostProcess: this.postProcess,
                    providerOptions: this.options,
                    onCompletionReady: onCompletionReadyImpl,
                    onHotStreakCompletionReady,
                })
            })
        )
    }

    private postProcess = (rawResponse: string): string => {
        let completion = extractFromCodeBlock(rawResponse)

        const trimmedPrefixContainNewline = this.options.docContext.prefix
            .slice(this.options.docContext.prefix.trimEnd().length)
            .includes('\n')
        if (trimmedPrefixContainNewline) {
            // The prefix already contains a `\n` that LLM was not aware of, so we remove any
            // leading `\n` followed by whitespace that might be add.
            completion = completion.replace(/^\s*\n\s*/, '')
        } else {
            completion = trimLeadingWhitespaceUntilNewline(completion)
        }

        // Remove bad symbols from the start of the completion string.
        completion = fixBadCompletionStart(completion)

        return completion
    }
}

export function createProviderConfig({
    model,
    maxContextTokens = 2048,
    ...otherOptions
}: UnstableOpenAIOptions & { model?: string }): ProviderConfig {
    return {
        create(options: ProviderOptions) {
            return new UnstableOpenAIProvider(options, { maxContextTokens, ...otherOptions })
        },
        contextSizeHints: standardContextSizeHints(maxContextTokens),
        identifier: PROVIDER_IDENTIFIER,
        model: model ?? 'gpt-35-turbo',
    }
}
