import * as anthropic from '@anthropic-ai/sdk'

import { Message } from '@sourcegraph/cody-shared/src/sourcegraph-api'
import {
    CompletionParameters,
    CompletionResponse,
} from '@sourcegraph/cody-shared/src/sourcegraph-api/completions/types'

import { CodeCompletionsClient } from '../client'
import { canUsePartialCompletion } from '../streaming'
import {
    CLOSING_CODE_TAG,
    extractFromCodeBlock,
    fixBadCompletionStart,
    getHeadAndTail,
    MULTILINE_STOP_SEQUENCE,
    OPENING_CODE_TAG,
    PrefixComponents,
    trimLeadingWhitespaceUntilNewline,
} from '../text-processing'
import { Completion, ContextSnippet } from '../types'
import { forkSignal, messagesToText } from '../utils'

import { CompletionProviderTracer, Provider, ProviderConfig, ProviderOptions } from './provider'

const CHARS_PER_TOKEN = 4

function tokensToChars(tokens: number): number {
    return tokens * CHARS_PER_TOKEN
}

interface AnthropicOptions {
    contextWindowTokens: number
    client: Pick<CodeCompletionsClient, 'complete'>
}

export class AnthropicProvider extends Provider {
    private promptChars: number
    private responseTokens: number
    private client: Pick<CodeCompletionsClient, 'complete'>

    constructor(options: ProviderOptions, anthropicOptions: AnthropicOptions) {
        super(options)
        this.promptChars =
            tokensToChars(anthropicOptions.contextWindowTokens) -
            Math.floor(tokensToChars(anthropicOptions.contextWindowTokens) * options.responsePercentage)
        this.responseTokens = Math.floor(anthropicOptions.contextWindowTokens * options.responsePercentage)
        this.client = anthropicOptions.client
    }

    public emptyPromptLength(): number {
        const { messages } = this.createPromptPrefix()
        const promptNoSnippets = messagesToText(messages)
        return promptNoSnippets.length - 10 // extra 10 chars of buffer cuz who knows
    }

    private createPromptPrefix(): { messages: Message[]; prefix: PrefixComponents } {
        // TODO(beyang): escape 'Human:' and 'Assistant:'
        const prefixLines = this.options.docContext.prefix.split('\n')
        if (prefixLines.length === 0) {
            throw new Error('no prefix lines')
        }

        const { head, tail, overlap } = getHeadAndTail(this.options.docContext.prefix)
        const prefixMessages: Message[] = [
            {
                speaker: 'human',
                text: `You are a code completion AI that writes high-quality code like a senior engineer. You are looking at ${
                    this.options.fileName
                }. You write code in between tags like this: ${OPENING_CODE_TAG}${
                    this.options.languageId === 'python' || this.options.languageId === 'ruby'
                        ? '# Code goes here'
                        : '/* Code goes here */'
                }${CLOSING_CODE_TAG}.`,
            },
            {
                speaker: 'assistant',
                text: 'I am a code completion AI that writes high-quality code like a senior engineer.',
            },
            {
                speaker: 'human',
                text: `Complete this code: ${OPENING_CODE_TAG}${head.trimmed}${CLOSING_CODE_TAG}.`,
            },
            {
                speaker: 'assistant',
                text: `Here is the code: ${OPENING_CODE_TAG}${tail.trimmed}`,
            },
        ]
        return { messages: prefixMessages, prefix: { head, tail, overlap } }
    }

    // Creates the resulting prompt and adds as many snippets from the reference
    // list as possible.
    protected createPrompt(snippets: ContextSnippet[]): { messages: Message[]; prefix: PrefixComponents } {
        const { messages: prefixMessages, prefix } = this.createPromptPrefix()

        const referenceSnippetMessages: Message[] = []

        let remainingChars = this.promptChars - this.emptyPromptLength()

        for (const snippet of snippets) {
            const snippetMessages: Message[] = [
                {
                    speaker: 'human',
                    text: `Here is a reference snippet of code: ${OPENING_CODE_TAG}${snippet.content}${CLOSING_CODE_TAG}`,
                },
                {
                    speaker: 'assistant',
                    text: 'I have added the snippet to my knowledge base.',
                },
            ]
            const numSnippetChars = messagesToText(snippetMessages).length + 1
            if (numSnippetChars > remainingChars) {
                break
            }
            referenceSnippetMessages.push(...snippetMessages)
            remainingChars -= numSnippetChars
        }

        return { messages: [...referenceSnippetMessages, ...prefixMessages], prefix }
    }

    public async generateCompletions(
        abortSignal: AbortSignal,
        snippets: ContextSnippet[],
        tracer?: CompletionProviderTracer
    ): Promise<Completion[]> {
        // Create prompt
        const { messages: prompt } = this.createPrompt(snippets)
        if (prompt.length > this.promptChars) {
            throw new Error(`prompt length (${prompt.length}) exceeded maximum character length (${this.promptChars})`)
        }

        const args: CompletionParameters = this.options.multiline
            ? {
                  temperature: 0.5,
                  messages: prompt,
                  maxTokensToSample: this.responseTokens,
                  stopSequences: [anthropic.HUMAN_PROMPT, CLOSING_CODE_TAG],
              }
            : {
                  temperature: 0.5,
                  messages: prompt,
                  maxTokensToSample: Math.min(50, this.responseTokens),
                  stopSequences: [anthropic.HUMAN_PROMPT, CLOSING_CODE_TAG, MULTILINE_STOP_SEQUENCE],
              }
        tracer?.params(args)

        // Issue request
        const responses = await this.batchAndProcessCompletions(this.client, args, this.options.n, abortSignal)

        const ret = responses.map(resp => [
            {
                prefix: this.options.docContext.prefix,
                content: resp.completion,
                stopReason: resp.stopReason,
            },
        ])

        const completions = ret.flat()
        tracer?.result({ rawResponses: responses, completions })

        return completions
    }

    private async batchAndProcessCompletions(
        client: Pick<CodeCompletionsClient, 'complete'>,
        params: CompletionParameters,
        n: number,
        abortSignal: AbortSignal
    ): Promise<CompletionResponse[]> {
        const responses: Promise<CompletionResponse>[] = []
        for (let i = 0; i < n; i++) {
            responses.push(this.fetchAndProcessCompletions(client, params, abortSignal))
        }
        return Promise.all(responses)
    }

    private async fetchAndProcessCompletions(
        client: Pick<CodeCompletionsClient, 'complete'>,
        params: CompletionParameters,
        abortSignal: AbortSignal
    ): Promise<CompletionResponse> {
        // The Async executor is required to return the completion early if a partial result from SSE can be used.
        // eslint-disable-next-line @typescript-eslint/no-misused-promises, no-async-promise-executor
        return new Promise(async (resolve, reject) => {
            try {
                const abortController = forkSignal(abortSignal)

                const result = await client.complete(
                    params,
                    (incompleteResponse: CompletionResponse) => {
                        const processedCompletion = this.postProcess(incompleteResponse.completion)
                        if (
                            canUsePartialCompletion(processedCompletion, {
                                document: { languageId: this.options.languageId },
                                multiline: this.options.multiline,
                                docContext: this.options.docContext,
                            })
                        ) {
                            resolve({ ...incompleteResponse, completion: processedCompletion })
                            abortController.abort()
                        }
                    },
                    abortController.signal
                )

                resolve({ ...result, completion: this.postProcess(result.completion) })
            } catch (error) {
                reject(error)
            }
        })
    }

    private postProcess(rawResponse: string): string {
        let completion = extractFromCodeBlock(rawResponse)

        const trimmedPrefixContainNewline = this.options.docContext.prefix
            .slice(this.options.docContext.prefix.trimEnd().length)
            .includes('\n')
        if (trimmedPrefixContainNewline) {
            // The prefix already contains a `\n` that Claude was not aware of, so we remove any
            // leading `\n` followed by whitespace that Claude might add.
            completion = completion.replace(/^\s*\n\s*/, '')
        } else {
            completion = trimLeadingWhitespaceUntilNewline(completion)
        }

        // Remove bad symbols from the start of the completion string.
        completion = fixBadCompletionStart(completion)

        return completion
    }
}

export function createProviderConfig(anthropicOptions: AnthropicOptions): ProviderConfig {
    return {
        create(options: ProviderOptions) {
            return new AnthropicProvider(options, anthropicOptions)
        },
        maximumContextCharacters: tokensToChars(anthropicOptions.contextWindowTokens),
        enableExtendedMultilineTriggers: true,
        identifier: 'anthropic',
        model: 'claude-instant-1',
    }
}
