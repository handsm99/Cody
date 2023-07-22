import fetch from 'isomorphic-fetch'

import { Completion } from '..'
import { logger } from '../../log'
import { isAbortError } from '../utils'

import { Provider, ProviderConfig, ProviderOptions } from './provider'

interface UnstableHuggingFaceOptions {
    serverEndpoint: string
    accessToken: null | string
}

const PROVIDER_IDENTIFIER = 'huggingface'
const STOP_WORD = '<|endoftext|>'

export class UnstableHuggingFaceProvider extends Provider {
    private serverEndpoint: string
    private accessToken: null | string

    constructor(options: ProviderOptions, unstableHuggingFaceOptions: UnstableHuggingFaceOptions) {
        super(options)
        this.serverEndpoint = unstableHuggingFaceOptions.serverEndpoint
        this.accessToken = unstableHuggingFaceOptions.accessToken
    }

    public async generateCompletions(abortSignal: AbortSignal): Promise<Completion[]> {
        // TODO: Add context and language
        // Prompt format is taken form https://huggingface.co/bigcode/starcoder#fill-in-the-middle
        const prompt = `<fim_prefix>${this.options.prefix}<fim_suffix>${this.options.suffix}<fim_middle>`

        const request = {
            inputs: prompt,
            parameters: {
                num_return_sequences: 1,
                // To speed up sample generation in single-line case, we request a lower token limit
                // since we can't terminate on the first `\n`.
                max_new_tokens: this.options.multiline ? 64 : 256,
            },
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
            const data = (await response.json()) as { generated_text: string }[] | { error: string }

            if ('error' in data) {
                throw new Error(data.error)
            }

            const completions: string[] = data.map(c => postProcess(c.generated_text, this.options.multiline))
            log?.onComplete(completions)

            return completions.map(content => ({
                prefix: this.options.prefix,
                content,
            }))
        } catch (error: any) {
            if (!isAbortError(error)) {
                log?.onError(error)
            }

            throw error
        }
    }
}

function postProcess(content: string, multiline: boolean): string {
    content = content.replace(STOP_WORD, '')

    // The model might return multiple lines for single line completions because
    // we are only able to specify a token limit.
    if (multiline && content.includes('\n')) {
        content = content.slice(0, content.indexOf('\n'))
    }

    return content.trim()
}

export function createProviderConfig(unstableHuggingFaceOptions: UnstableHuggingFaceOptions): ProviderConfig {
    const contextWindowChars = 8_000 // ~ 2k token limit
    return {
        create(options: ProviderOptions) {
            return new UnstableHuggingFaceProvider(options, unstableHuggingFaceOptions)
        },
        maximumContextCharacters: contextWindowChars,
        enableExtendedMultilineTriggers: true,
        identifier: PROVIDER_IDENTIFIER,
    }
}
