import fetch from 'isomorphic-fetch'

import { logger } from '../../log'
import { getLanguageConfig } from '../language'
import { Completion, ContextSnippet } from '../types'
import { isAbortError } from '../utils'

import { Provider, ProviderConfig, ProviderOptions } from './provider'

interface UnstableFireworksOptions {
    serverEndpoint: string
    accessToken: null | string
    model: null | string
}

const PROVIDER_IDENTIFIER = 'fireworks'
const STOP_WORD = '<|endoftext|>'
const CONTEXT_WINDOW_CHARS = 5000 // ~ 2000 token limit

// Model identifiers can be found in https://docs.fireworks.ai/explore/ and in our internal
// conversations
const MODEL_MAP = {
    'starcoder-16b': 'accounts/fireworks/models/starcoder-16b-w8a16',
    'starcoder-7b': 'accounts/fireworks/models/starcoder-7b-w8a16',
    'starcoder-3b': 'accounts/fireworks/models/starcoder-3b-w8a16',
    'starcoder-1b': 'accounts/fireworks/models/starcoder-1b-w8a16',
    'llama-code-13b-instruct': 'accounts/fireworks/models/llama-v2-13b-code-instruct',
}

export class UnstableFireworksProvider extends Provider {
    private serverEndpoint: string
    private accessToken: null | string
    private model: keyof typeof MODEL_MAP

    constructor(options: ProviderOptions, { serverEndpoint, accessToken, model }: UnstableFireworksOptions) {
        super(options)
        this.serverEndpoint = serverEndpoint
        this.accessToken = accessToken
        if (model === null || model === '') {
            this.model = 'starcoder-7b'
        } else if (Object.prototype.hasOwnProperty.call(MODEL_MAP, model)) {
            this.model = model as keyof typeof MODEL_MAP
        } else {
            throw new Error(`Unknown model: \`${model}\``)
        }
    }

    private createPrompt(snippets: ContextSnippet[]): string {
        const maxPromptChars = CONTEXT_WINDOW_CHARS - CONTEXT_WINDOW_CHARS * this.options.responsePercentage
        const { prefix, suffix } = this.options.docContext

        const intro: string[] = []
        let prompt = ''

        const languageConfig = getLanguageConfig(this.options.languageId)
        if (languageConfig) {
            intro.push(`Path: ${this.options.fileName}`)
        }

        for (let snippetsToInclude = 0; snippetsToInclude < snippets.length + 1; snippetsToInclude++) {
            if (snippetsToInclude > 0) {
                const snippet = snippets[snippetsToInclude - 1]
                intro.push(`Here is a reference snippet of code from ${snippet.fileName}:\n\n${snippet.content}`)
            }

            const introString =
                intro
                    .join('\n\n')
                    .split('\n')
                    .map(line => (languageConfig ? languageConfig.commentStart + line : ''))
                    .join('\n') + '\n'

            const suffixAfterFirstNewline = suffix.slice(suffix.indexOf('\n'))

            const nextPrompt = this.createInfillingPrompt(introString, prefix, suffixAfterFirstNewline)

            if (nextPrompt.length >= maxPromptChars) {
                return prompt
            }

            prompt = nextPrompt
        }

        return prompt
    }

    public async generateCompletions(abortSignal: AbortSignal, snippets: ContextSnippet[]): Promise<Completion[]> {
        const prompt = this.createPrompt(snippets)

        const request = {
            prompt,
            // To speed up sample generation in single-line case, we request a lower token limit
            // since we can't terminate on the first `\n`.
            max_tokens: this.options.multiline ? 256 : 30,
            temperature: 0.4,
            top_p: 0.95,
            n: this.options.n,
            echo: false,
            model: MODEL_MAP[this.model],
        }

        const log = logger.startCompletion({
            request,
            provider: PROVIDER_IDENTIFIER,
            serverEndpoint: this.serverEndpoint,
        })

        const response = await fetch(this.serverEndpoint, {
            method: 'POST',
            body: JSON.stringify(request),
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.accessToken}`,
            },
            signal: abortSignal,
        })

        try {
            const data = (await response.json()) as
                | { choices: { text: string; finish_reason: string }[] }
                | { error: { message: string } }

            if ('error' in data) {
                throw new Error(data.error.message)
            }

            const completions = data.choices.map(c => ({
                content: postProcess(c.text, this.options.multiline),
                stopReason: c.finish_reason,
            }))
            log?.onComplete(completions.map(c => c.content))

            return completions.map(c => ({
                content: c.content,
                stopReason: c.stopReason,
            }))
        } catch (error: any) {
            if (!isAbortError(error)) {
                log?.onError(error)
            }

            throw error
        }
    }

    private createInfillingPrompt(intro: string, prefix: string, suffix: string): string {
        if (this.model.startsWith('starcoder')) {
            // c.f. https://starcoder.co/bigcode/starcoder#fill-in-the-middle
            return `<fim_prefix>${intro}${prefix}<fim_suffix>${suffix}<fim_middle>`
        }
        if (this.model.startsWith('llama-code')) {
            // @TODO(philipp-spiess): FIM prompt is not working yet, we're working with Fireworks to
            // get this sorted
            //
            // c.f. https://github.com/facebookresearch/codellama/blob/main/llama/generation.py#L402
            return `<PRE> ${intro}${prefix} <SUF>${suffix} <MID>`
        }

        console.error('Could not generate infilling prompt for', this.model)
        return `${intro}${prefix}`
    }
}

function postProcess(content: string, multiline: boolean): string {
    content = content.replace(STOP_WORD, '')

    // The model might return multiple lines for single line completions because
    // we are only able to specify a token limit.
    if (!multiline && content.includes('\n')) {
        content = content.slice(0, content.indexOf('\n'))
    }

    return content.trim()
}

export function createProviderConfig(unstableFireworksOptions: UnstableFireworksOptions): ProviderConfig {
    return {
        create(options: ProviderOptions) {
            return new UnstableFireworksProvider(options, unstableFireworksOptions)
        },
        maximumContextCharacters: CONTEXT_WINDOW_CHARS,
        enableExtendedMultilineTriggers: true,
        identifier: PROVIDER_IDENTIFIER,
        supportsInfilling: true,
    }
}
