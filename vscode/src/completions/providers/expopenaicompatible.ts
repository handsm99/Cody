// TODO(slimsag): self-hosted-models: deprecate and remove this once customers are upgraded
// to non-experimental version

import type { CodeCompletionsParams } from '@sourcegraph/cody-shared'

import { forkSignal, generatorWithTimeout, zipGenerators } from '../utils'

import {
    type FetchCompletionResult,
    fetchAndProcessDynamicMultilineCompletions,
} from './shared/fetch-and-process-completions'
import {
    type CompletionProviderTracer,
    type GenerateCompletionsOptions,
    Provider,
    type ProviderFactoryParams,
} from './shared/provider'

// Model identifiers (we are the source/definition for these in case of the openaicompatible provider.)
const MODEL_MAP = {
    starchat: 'openaicompatible/starchat-16b-beta',
    'starchat-16b-beta': 'openaicompatible/starchat-16b-beta',

    starcoder: 'openaicompatible/starcoder',
    'starcoder-16b': 'openaicompatible/starcoder-16b',
    'starcoder-7b': 'openaicompatible/starcoder-7b',
    'llama-code-7b': 'openaicompatible/llama-code-7b',
    'llama-code-13b': 'openaicompatible/llama-code-13b',
    'llama-code-13b-instruct': 'openaicompatible/llama-code-13b-instruct',
    'mistral-7b-instruct-4k': 'openaicompatible/mistral-7b-instruct-4k',
} as const

type OpenAICompatibleModel =
    | keyof typeof MODEL_MAP
    // `starcoder-hybrid` uses the 16b model for multiline requests and the 7b model for single line
    | 'starcoder-hybrid'

function getMaxContextTokens(model: OpenAICompatibleModel): number {
    switch (model) {
        case 'starchat':
        case 'starchat-16b-beta':
        case 'starcoder':
        case 'starcoder-hybrid':
        case 'starcoder-16b':
        case 'starcoder-7b': {
            // StarCoder and StarChat support up to 8k tokens, we limit to ~6k so we do not hit token limits.
            return 8192 - 2048
        }
        case 'llama-code-7b':
        case 'llama-code-13b':
        case 'llama-code-13b-instruct':
            // Llama Code was trained on 16k context windows, we're constraining it here to better
            return 16384 - 2048
        case 'mistral-7b-instruct-4k':
            return 4096 - 2048
        default:
            return 1200
    }
}

class ExpOpenAICompatibleProvider extends Provider {
    public getRequestParams(options: GenerateCompletionsOptions): CodeCompletionsParams {
        const { multiline, docContext, document, snippets } = options

        const messages = this.modelHelper.getMessages({
            snippets,
            docContext,
            document,
            promptChars: this.promptChars,
            // StarChat: only use infill if the suffix is not empty
            isInfill: docContext.suffix.trim().length > 0,
        })

        const model =
            this.legacyModel === 'starcoder-hybrid'
                ? MODEL_MAP[multiline ? 'starcoder-16b' : 'starcoder-7b']
                : this.legacyModel.startsWith('starchat')
                  ? undefined // starchat is not a supported backend model yet, use the default server-chosen model.
                  : MODEL_MAP[this.legacyModel as keyof typeof MODEL_MAP]

        return {
            ...this.defaultRequestParams,
            messages,
            model,
        }
    }

    public async generateCompletions(
        generateOptions: GenerateCompletionsOptions,
        abortSignal: AbortSignal,
        tracer?: CompletionProviderTracer
    ): Promise<AsyncGenerator<FetchCompletionResult[]>> {
        const { numberOfCompletionsToGenerate, docContext } = generateOptions

        const requestParams = this.getRequestParams(generateOptions)
        tracer?.params(requestParams)

        const completionsGenerators = Array.from({ length: numberOfCompletionsToGenerate }).map(
            async () => {
                const abortController = forkSignal(abortSignal)

                const completionResponseGenerator = generatorWithTimeout(
                    await this.client.complete(requestParams, abortController),
                    requestParams.timeoutMs,
                    abortController
                )

                return fetchAndProcessDynamicMultilineCompletions({
                    completionResponseGenerator,
                    abortController,
                    generateOptions,
                    providerSpecificPostProcess: content =>
                        this.modelHelper.postProcess(content, docContext),
                })
            }
        )

        /**
         * This implementation waits for all generators to yield values
         * before passing them to the consumer (request-manager). While this may appear
         * as a performance bottleneck, it's necessary for the current design.
         *
         * The consumer operates on promises, allowing only a single resolve call
         * from `requestManager.request`. Therefore, we must wait for the initial
         * batch of completions before returning them collectively, ensuring all
         * are included as suggested completions.
         *
         * To circumvent this performance issue, a method for adding completions to
         * the existing suggestion list is needed. Presently, this feature is not
         * available, and the switch to async generators maintains the same behavior
         * as with promises.
         */
        return zipGenerators(await Promise.all(completionsGenerators))
    }
}

function getClientModel(model?: string): OpenAICompatibleModel {
    if (model === undefined || model === '') {
        return 'starcoder-hybrid' as OpenAICompatibleModel
    }

    if (model === 'starcoder-hybrid' || Object.prototype.hasOwnProperty.call(MODEL_MAP, model)) {
        return model as OpenAICompatibleModel
    }

    throw new Error(`Unknown model: \`${model}\``)
}

export function createProvider({ legacyModel, source }: ProviderFactoryParams): Provider {
    const clientModel = getClientModel(legacyModel)

    return new ExpOpenAICompatibleProvider({
        id: 'experimental-openaicompatible',
        legacyModel: clientModel,
        maxContextTokens: getMaxContextTokens(clientModel),
        source,
    })
}
