import {
    type AuthStatus,
    type AutocompleteContextSnippet,
    type AutocompleteTimeouts,
    type CodeCompletionsClient,
    type CodeCompletionsParams,
    type CompletionResponseGenerator,
    type Configuration,
    type ConfigurationWithAccessToken,
    PromptString,
    dotcomTokenToGatewayToken,
    ps,
    tokensToChars,
} from '@sourcegraph/cody-shared'
import type * as vscode from 'vscode'
import { type LanguageConfig, getLanguageConfig } from '../../tree-sitter/language'
import { getSuffixAfterFirstNewline } from '../text-processing'
import { forkSignal, generatorWithTimeout, zipGenerators } from '../utils'
import * as fimPromptUtils from './fim-prompt-utils'
import type { FIMModelSpecificPromptExtractor } from './fim-prompt-utils'

import { createFastPathClient } from '../fast-path-client'
import { TriggerKind } from '../get-inline-completions'
import {
    type FetchCompletionResult,
    fetchAndProcessDynamicMultilineCompletions,
} from './fetch-and-process-completions'
import {
    MAX_RESPONSE_TOKENS,
    getCompletionParams,
    getLineNumberDependentCompletionParams,
} from './get-completion-params'
import {
    type CompletionProviderTracer,
    Provider,
    type ProviderConfig,
    type ProviderOptions,
    standardContextSizeHints,
} from './provider'

export interface FireworksOptions {
    model: FireworksModel
    maxContextTokens?: number
    client: CodeCompletionsClient
    anonymousUserID?: string
    timeouts: AutocompleteTimeouts
    config: Pick<
        ConfigurationWithAccessToken,
        'accessToken' | 'autocompleteExperimentalFireworksOptions'
    >
    authStatus: Pick<
        AuthStatus,
        'userCanUpgrade' | 'isDotCom' | 'endpoint' | 'isFireworksTracingEnabled'
    >
}

const PROVIDER_IDENTIFIER = 'fireworks'

const EOT_STARCODER = '<|endoftext|>'
const EOT_LLAMA_CODE = ' <EOT>'
const EOT_DEEPSEEK_CODE = '<|eos_token|>'

// Fireworks hosted fine tuned model on py, tsx, jsx and starcoder-hybrid on other langs.
export const FIREWORKS_FIM_FINE_TUNED_MODEL_HYBRID_WITH_200MS_DELAY =
    'fim-fine-tuned-model-hybrid-200ms-delay'
export const FIREWORKS_FIM_FINE_TUNED_MODEL_HYBRID = 'fim-fine-tuned-model-hybrid'
export const FIREWORKS_FIM_LANG_SPECIFIC_MODEL_MIXTRAL = 'fim-lang-specific-model-mixtral'

export const FIREWORKS_DEEPSEEK_7B_LANG_STACK_FINETUNED =
    'fim-lang-specific-model-deepseek-stack-trained'
export const FIREWORKS_DEEPSEEK_7B_LANG_LOG_FINETUNED = 'fim-lang-specific-model-deepseek-logs-trained'

// Huggingface link (https://huggingface.co/deepseek-ai/deepseek-coder-1.3b-base)
export const DEEPSEEK_CODER_1P3_B = 'deepseek-coder-1p3b'
// Huggingface link (https://huggingface.co/deepseek-ai/deepseek-coder-6.7b-base)
export const DEEPSEEK_CODER_7B = 'deepseek-coder-7b'
// Huggingface link (https://huggingface.co/deepseek-ai/DeepSeek-Coder-V2-Lite-Base)
export const DEEPSEEK_CODER_V2_LITE_BASE = 'deepseek-coder-v2-lite-base'

// Context window experiments with DeepSeek Model
export const DEEPSEEK_CODER_V2_LITE_BASE_WINDOW_4096 = 'deepseek-coder-v2-lite-base-context-4096'
export const DEEPSEEK_CODER_V2_LITE_BASE_WINDOW_8192 = 'deepseek-coder-v2-lite-base-context-8192'
export const DEEPSEEK_CODER_V2_LITE_BASE_WINDOW_16384 = 'deepseek-coder-v2-lite-base-context-16383'
export const DEEPSEEK_CODER_V2_LITE_BASE_WINDOW_32768 = 'deepseek-coder-v2-lite-base-context-32768'

// Huggingface link (https://huggingface.co/Qwen/CodeQwen1.5-7B)
export const CODE_QWEN_7B = 'code-qwen-7b'

// Model identifiers can be found in https://docs.fireworks.ai/explore/ and in our internal
// conversations
const MODEL_MAP = {
    // Virtual model strings. Cody Gateway will map to an actual model
    starcoder: 'fireworks/starcoder',
    'starcoder-16b': 'fireworks/starcoder-16b',
    'starcoder-7b': 'fireworks/starcoder-7b',
    'starcoder2-15b': 'fireworks/starcoder2-15b',
    'starcoder2-7b': 'fireworks/starcoder2-7b',

    // Fireworks model identifiers
    'llama-code-13b': 'fireworks/accounts/fireworks/models/llama-v2-13b-code',

    // Fine-tuned model hybrid identifier
    [FIREWORKS_FIM_FINE_TUNED_MODEL_HYBRID]:
        'fireworks/accounts/sourcegraph/models/finetuned-fim-lang-all-model-mixtral-8x7b',
    [FIREWORKS_FIM_FINE_TUNED_MODEL_HYBRID_WITH_200MS_DELAY]:
        'fireworks/accounts/sourcegraph/models/finetuned-fim-lang-all-model-mixtral-8x7b',
    [FIREWORKS_FIM_LANG_SPECIFIC_MODEL_MIXTRAL]: FIREWORKS_FIM_LANG_SPECIFIC_MODEL_MIXTRAL,
    [FIREWORKS_DEEPSEEK_7B_LANG_LOG_FINETUNED]: FIREWORKS_DEEPSEEK_7B_LANG_LOG_FINETUNED,
    [FIREWORKS_DEEPSEEK_7B_LANG_STACK_FINETUNED]: FIREWORKS_DEEPSEEK_7B_LANG_STACK_FINETUNED,
    [DEEPSEEK_CODER_1P3_B]: 'fireworks/accounts/sourcegraph/models/custom-deepseek-1p3b-base-hf-version',
    [DEEPSEEK_CODER_7B]: 'fireworks/accounts/sourcegraph/models/deepseek-coder-7b-base',
    [DEEPSEEK_CODER_V2_LITE_BASE]: 'accounts/sourcegraph/models/deepseek-coder-v2-lite-base',
    [CODE_QWEN_7B]: 'accounts/sourcegraph/models/code-qwen-1p5-7b',
    [DEEPSEEK_CODER_V2_LITE_BASE_WINDOW_4096]: 'accounts/sourcegraph/models/deepseek-coder-v2-lite-base',
    [DEEPSEEK_CODER_V2_LITE_BASE_WINDOW_8192]: 'accounts/sourcegraph/models/deepseek-coder-v2-lite-base',
    [DEEPSEEK_CODER_V2_LITE_BASE_WINDOW_16384]:
        'accounts/sourcegraph/models/deepseek-coder-v2-lite-base',
    [DEEPSEEK_CODER_V2_LITE_BASE_WINDOW_32768]:
        'accounts/sourcegraph/models/deepseek-coder-v2-lite-base',
}

type FireworksModel =
    | keyof typeof MODEL_MAP
    // `starcoder-hybrid` uses the 16b model for multiline requests and the 7b model for single line
    | 'starcoder-hybrid'
    // `starcoder2-hybrid` uses the 15b model for multiline requests and the 7b model for single line
    | 'starcoder2-hybrid'

function getMaxContextTokens(model: FireworksModel): number {
    switch (model) {
        case 'starcoder':
        case 'starcoder2-hybrid':
        case 'starcoder2-15b':
        case 'starcoder2-7b':
        case 'starcoder-hybrid':
        case 'starcoder-16b':
        case 'starcoder-7b': {
            // StarCoder supports up to 8k tokens, we limit it to ~2k for evaluation against
            // other providers.
            return 2048
        }
        case 'llama-code-13b':
            // Llama 2 on Fireworks supports up to 4k tokens. We're constraining it here to better
            // compare the results
            return 2048
        case FIREWORKS_FIM_FINE_TUNED_MODEL_HYBRID:
        case FIREWORKS_FIM_LANG_SPECIFIC_MODEL_MIXTRAL:
        case FIREWORKS_DEEPSEEK_7B_LANG_STACK_FINETUNED:
        case FIREWORKS_DEEPSEEK_7B_LANG_LOG_FINETUNED:
        case DEEPSEEK_CODER_1P3_B:
        case DEEPSEEK_CODER_7B:
        case DEEPSEEK_CODER_V2_LITE_BASE:
        case CODE_QWEN_7B: {
            return 2048
        }
        case DEEPSEEK_CODER_V2_LITE_BASE_WINDOW_4096:
            return 4096
        case DEEPSEEK_CODER_V2_LITE_BASE_WINDOW_8192:
            return 8192
        case DEEPSEEK_CODER_V2_LITE_BASE_WINDOW_16384:
            return 16384
        case DEEPSEEK_CODER_V2_LITE_BASE_WINDOW_32768:
            return 32768
        default:
            return 1200
    }
}

const lineNumberDependentCompletionParams = getLineNumberDependentCompletionParams({
    singlelineStopSequences: ['\n\n', '\n\r\n'],
    multilineStopSequences: ['\n\n', '\n\r\n'],
})

class FireworksProvider extends Provider {
    private model: FireworksModel
    private promptChars: number
    private client: CodeCompletionsClient
    private timeouts?: AutocompleteTimeouts
    private fastPathAccessToken?: string
    private authStatus: Pick<
        AuthStatus,
        'userCanUpgrade' | 'isDotCom' | 'endpoint' | 'isFireworksTracingEnabled'
    >
    private isLocalInstance: boolean
    private fireworksConfig?: Configuration['autocompleteExperimentalFireworksOptions']
    private promptExtractor: FIMModelSpecificPromptExtractor
    // Todo: This variable is used to introduce an additional delay to collect the data on impact of latency on user experience.
    // Todo: Delete this variable once the data is collected.
    private shouldAddArtificialDelayForExperiment = false
    private anonymousUserID: string | undefined

    constructor(
        options: ProviderOptions,
        {
            model,
            maxContextTokens,
            client,
            timeouts,
            config,
            authStatus,
            anonymousUserID,
        }: Required<Omit<FireworksOptions, 'anonymousUserID'>> & { anonymousUserID?: string }
    ) {
        super(options)
        this.timeouts = timeouts
        if (model === FIREWORKS_FIM_FINE_TUNED_MODEL_HYBRID_WITH_200MS_DELAY) {
            this.shouldAddArtificialDelayForExperiment = true
        }
        this.model = this.adjustModelIdentifier(model, options.document.languageId)
        this.promptExtractor = this.getFIMPromptExtractorForModel()
        this.promptChars = tokensToChars(maxContextTokens - MAX_RESPONSE_TOKENS)
        this.client = client
        this.authStatus = authStatus
        this.anonymousUserID = anonymousUserID
        this.isLocalInstance = Boolean(
            this.authStatus.endpoint?.includes('sourcegraph.test') ||
                this.authStatus.endpoint?.includes('localhost')
        )

        const isNode = typeof process !== 'undefined'
        this.fastPathAccessToken =
            config.accessToken &&
            // Require the upstream to be dotcom
            (this.authStatus.isDotCom || this.isLocalInstance) &&
            process.env.CODY_DISABLE_FASTPATH !== 'true' && // Used for testing
            // The fast path client only supports Node.js style response streams
            isNode
                ? dotcomTokenToGatewayToken(config.accessToken)
                : undefined

        if (
            process.env.NODE_ENV === 'development' &&
            config.autocompleteExperimentalFireworksOptions?.token
        ) {
            this.fastPathAccessToken = config.autocompleteExperimentalFireworksOptions?.token
            this.fireworksConfig = config.autocompleteExperimentalFireworksOptions
        }
    }

    private getFIMPromptExtractorForModel(): FIMModelSpecificPromptExtractor {
        if (isStarCoderFamily(this.model)) {
            return new fimPromptUtils.StarcoderPromptExtractor()
        }
        if (isLlamaCode(this.model)) {
            return new fimPromptUtils.CodeLlamaPromptExtractor()
        }
        if (isFinetunedV1ModelFamily(this.model)) {
            return new fimPromptUtils.FinetunedModelV1PromptExtractor()
        }
        if (isCodeQwenFamily(this.model)) {
            return new fimPromptUtils.CodeQwenModelPromptExtractor()
        }
        if (isDeepSeekModelFamily(this.model)) {
            return new fimPromptUtils.DeepSeekPromptExtractor()
        }
        console.error(
            'Using default model prompt extractor, could not get prompt extractor for',
            this.model
        )
        return new fimPromptUtils.DefaultModelPromptExtractor()
    }

    private adjustModelIdentifier(model: FireworksModel, languageId: string): FireworksModel {
        switch (model) {
            case FIREWORKS_FIM_FINE_TUNED_MODEL_HYBRID:
            case FIREWORKS_FIM_FINE_TUNED_MODEL_HYBRID_WITH_200MS_DELAY: {
                if (['typescriptreact', 'javascriptreact', 'python'].includes(languageId)) {
                    return FIREWORKS_FIM_FINE_TUNED_MODEL_HYBRID
                }
                return 'starcoder-hybrid'
            }
            case FIREWORKS_FIM_LANG_SPECIFIC_MODEL_MIXTRAL: {
                if (
                    [
                        'typescriptreact',
                        'javascriptreact',
                        'typescript',
                        'javascript',
                        'python',
                    ].includes(languageId)
                ) {
                    return FIREWORKS_FIM_LANG_SPECIFIC_MODEL_MIXTRAL
                }
                return 'starcoder-hybrid'
            }
            default:
                return model
        }
    }

    private createPrompt(snippets: AutocompleteContextSnippet[]): PromptString {
        const { prefix, suffix } = PromptString.fromAutocompleteDocumentContext(
            this.options.docContext,
            this.options.document.uri
        )

        const intro: PromptString[] = []
        let prompt = ps``

        const languageConfig = getLanguageConfig(this.options.document.languageId)

        if (isLlamaCode(this.model)) {
            intro.push(ps`Path: ${PromptString.fromDisplayPath(this.options.document.uri)}`)
        }

        for (let snippetsToInclude = 0; snippetsToInclude < snippets.length + 1; snippetsToInclude++) {
            if (snippetsToInclude > 0) {
                const snippet = snippets[snippetsToInclude - 1]
                const contextPrompts = PromptString.fromAutocompleteContextSnippet(snippet)

                if (contextPrompts.symbol) {
                    intro.push(
                        ps`Additional documentation for \`${contextPrompts.symbol}\`:\n\n${contextPrompts.content}`
                    )
                } else {
                    intro.push(
                        this.promptExtractor.getContextPrompt({
                            filename: snippet.uri as vscode.Uri,
                            content: contextPrompts.content,
                        })
                    )
                }
            }

            const introString = this.getIntroString(intro, languageConfig)

            // We want to remove the same line suffix from a completion request since both StarCoder and Llama
            // code can't handle this correctly.
            const suffixAfterFirstNewline = getSuffixAfterFirstNewline(suffix)
            const nextPrompt = this.promptExtractor.getInfillingPrompt({
                repoName: this.options.gitContext
                    ? PromptString.fromAutocompleteGitContext(
                          this.options.gitContext,
                          this.options.document.uri
                      ).repoName
                    : undefined,
                filename: PromptString.fromDisplayPath(this.options.document.uri),
                intro: introString,
                prefix,
                suffix: suffixAfterFirstNewline,
            })

            if (nextPrompt.length >= this.promptChars) {
                return prompt
            }

            prompt = nextPrompt
        }

        return prompt
    }

    private getIntroString(intro: PromptString[], languageConfig: LanguageConfig | null): PromptString {
        if (
            isFinetunedV1ModelFamily(this.model) ||
            isDeepSeekModelFamily(this.model) ||
            isCodeQwenFamily(this.model)
        ) {
            // These model families take code from the context files without comments.
            return ps`${PromptString.join(intro, ps`\n\n`)}\n`
        }
        return ps`${PromptString.join(
            PromptString.join(intro, ps`\n\n`)
                .split('\n')
                .map(line => ps`${languageConfig ? languageConfig.commentStart : ps`// `}${line}`),
            ps`\n`
        )}\n`
    }

    public generateCompletions(
        abortSignal: AbortSignal,
        snippets: AutocompleteContextSnippet[],
        tracer?: CompletionProviderTracer
    ): AsyncGenerator<FetchCompletionResult[]> {
        const partialRequestParams = getCompletionParams({
            providerOptions: this.options,
            timeouts: this.timeouts,
            lineNumberDependentCompletionParams,
        })

        const { multiline } = this.options
        const useMultilineModel = multiline || this.options.triggerKind !== TriggerKind.Automatic

        const model: string =
            this.model === 'starcoder2-hybrid'
                ? MODEL_MAP[useMultilineModel ? 'starcoder2-15b' : 'starcoder2-7b']
                : this.model === 'starcoder-hybrid'
                  ? MODEL_MAP[useMultilineModel ? 'starcoder-16b' : 'starcoder-7b']
                  : MODEL_MAP[this.model]
        const requestParams = {
            ...partialRequestParams,
            messages: [{ speaker: 'human', text: this.createPrompt(snippets) }],
            temperature: 0.2,
            topK: 0,
            model,
        } satisfies CodeCompletionsParams

        if (
            requestParams.model.includes('starcoder2') ||
            isFinetunedV1ModelFamily(requestParams.model) ||
            isCodeQwenFamily(requestParams.model)
        ) {
            requestParams.stopSequences = [
                ...(requestParams.stopSequences || []),
                '<fim_prefix>',
                '<fim_suffix>',
                '<fim_middle>',
                '<|endoftext|>',
                '<file_sep>',
            ]
        }
        if (isDeepSeekModelFamily(requestParams.model)) {
            requestParams.stopSequences = [
                ...(requestParams.stopSequences || []),
                '<｜fim▁begin｜>',
                '<｜fim▁hole｜>',
                '<｜fim▁end｜>',
                '<|eos_token|>',
            ]
        }
        // Add a condition for adding extra stop tokens here

        tracer?.params(requestParams)

        const completionsGenerators = Array.from({ length: this.options.n }).map(() => {
            const abortController = forkSignal(abortSignal)

            const completionResponseGenerator = generatorWithTimeout(
                this.createClient(requestParams, abortController),
                requestParams.timeoutMs,
                abortController
            )

            return fetchAndProcessDynamicMultilineCompletions({
                completionResponseGenerator,
                abortController,
                providerSpecificPostProcess: this.postProcess,
                providerOptions: this.options,
            })
        })

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
        return zipGenerators(completionsGenerators)
    }

    private postProcess = (content: string): string => {
        if (
            isStarCoderFamily(this.model) ||
            isCodeQwenFamily(this.model) ||
            isFinetunedV1ModelFamily(this.model)
        ) {
            return content.replace(EOT_STARCODER, '')
        }
        if (isLlamaCode(this.model)) {
            return content.replace(EOT_LLAMA_CODE, '')
        }
        if (isDeepSeekModelFamily(this.model)) {
            return content.replace(EOT_DEEPSEEK_CODE, '')
        }
        return content
    }

    private getCustomHeaders = (): Record<string, string> => {
        // Enabled Fireworks tracing for Sourcegraph teammates.
        // https://readme.fireworks.ai/docs/enabling-tracing
        return this.authStatus.isFireworksTracingEnabled ? { 'X-Fireworks-Genie': 'true' } : {}
    }

    private createClient(
        requestParams: CodeCompletionsParams,
        abortController: AbortController
    ): CompletionResponseGenerator {
        if (this.fastPathAccessToken) {
            return createFastPathClient(requestParams, abortController, {
                isLocalInstance: this.isLocalInstance,
                fireworksConfig: this.fireworksConfig,
                logger: this.client.logger,
                shouldAddArtificialDelayForExperiment: this.shouldAddArtificialDelayForExperiment,
                providerOptions: this.options,
                fastPathAccessToken: this.fastPathAccessToken,
                customHeaders: this.getCustomHeaders(),
                authStatus: this.authStatus,
                anonymousUserID: this.anonymousUserID,
            })
        }

        return this.client.complete(requestParams, abortController, {
            customHeaders: this.getCustomHeaders(),
        })
    }
}

export function createProviderConfig({
    model,
    timeouts,
    ...otherOptions
}: Omit<FireworksOptions, 'model' | 'maxContextTokens'> & {
    model: string | null
}): ProviderConfig {
    const clientModel =
        model === null || model === ''
            ? otherOptions.authStatus.isDotCom
                ? DEEPSEEK_CODER_V2_LITE_BASE
                : 'starcoder-hybrid'
            : ['starcoder-hybrid', 'starcoder2-hybrid'].includes(model)
              ? (model as FireworksModel)
              : Object.prototype.hasOwnProperty.call(MODEL_MAP, model)
                ? (model as keyof typeof MODEL_MAP)
                : null

    if (clientModel === null) {
        throw new Error(`Unknown model: \`${model}\``)
    }

    const maxContextTokens = getMaxContextTokens(clientModel)

    return {
        create(options: ProviderOptions) {
            return new FireworksProvider(
                {
                    ...options,
                    id: PROVIDER_IDENTIFIER,
                },
                {
                    model: clientModel,
                    maxContextTokens,
                    timeouts,
                    ...otherOptions,
                }
            )
        },
        contextSizeHints: standardContextSizeHints(maxContextTokens),
        identifier: PROVIDER_IDENTIFIER,
        model: clientModel,
    }
}

function isStarCoderFamily(model: string): boolean {
    return model.startsWith('starcoder')
}

function isLlamaCode(model: string): boolean {
    return model.startsWith('llama-code')
}

function isFinetunedV1ModelFamily(model: string): boolean {
    return [
        FIREWORKS_FIM_FINE_TUNED_MODEL_HYBRID,
        FIREWORKS_FIM_LANG_SPECIFIC_MODEL_MIXTRAL,
        FIREWORKS_FIM_FINE_TUNED_MODEL_HYBRID_WITH_200MS_DELAY,
    ].includes(model)
}

function isDeepSeekModelFamily(model: string): boolean {
    return [
        DEEPSEEK_CODER_1P3_B,
        DEEPSEEK_CODER_7B,
        DEEPSEEK_CODER_V2_LITE_BASE,
        FIREWORKS_DEEPSEEK_7B_LANG_STACK_FINETUNED,
        FIREWORKS_DEEPSEEK_7B_LANG_LOG_FINETUNED,
    ].includes(model)
}

function isCodeQwenFamily(model: string): boolean {
    return [CODE_QWEN_7B].includes(model)
}
