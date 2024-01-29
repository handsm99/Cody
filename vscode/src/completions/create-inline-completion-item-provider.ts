import * as vscode from 'vscode'

import {
    FeatureFlag,
    featureFlagProvider,
    isDotCom,
    type CodeCompletionsClient,
    type Configuration,
} from '@sourcegraph/cody-shared'

import { logDebug } from '../log'
import type { AuthProvider } from '../services/AuthProvider'
import type { CodyStatusBar } from '../services/StatusBar'

import type { ContextStrategy } from './context/context-strategy'
import type { BfgRetriever } from './context/retrievers/bfg/bfg-retriever'
import { InlineCompletionItemProvider } from './inline-completion-item-provider'
import { createProviderConfig } from './providers/create-provider'
import { registerAutocompleteTraceView } from './tracer/traceView'

interface InlineCompletionItemProviderArgs {
    config: Configuration
    client: CodeCompletionsClient
    statusBar: CodyStatusBar
    authProvider: AuthProvider
    triggerNotice: ((notice: { key: string }) => void) | null
    createBfgRetriever?: () => BfgRetriever
}

/**
 * Inline completion item providers that always returns an empty reply.
 * Implemented as a class instead of anonymous function so that you can identify
 * it with `console.log()` debugging.
 */
class NoopCompletionItemProvider implements vscode.InlineCompletionItemProvider {
    public provideInlineCompletionItems(
        _document: vscode.TextDocument,
        _position: vscode.Position,
        _context: vscode.InlineCompletionContext,
        _token: vscode.CancellationToken
    ): vscode.ProviderResult<vscode.InlineCompletionItem[] | vscode.InlineCompletionList> {
        return { items: [] }
    }
}

export async function createInlineCompletionItemProvider({
    config,
    client,
    statusBar,
    authProvider,
    triggerNotice,
    createBfgRetriever,
}: InlineCompletionItemProviderArgs): Promise<vscode.Disposable> {
    if (!authProvider.getAuthStatus().isLoggedIn) {
        logDebug('CodyCompletionProvider:notSignedIn', 'You are not signed in.')

        if (config.isRunningInsideAgent) {
            // Register an empty completion provider when running inside the
            // agent to avoid timeouts because it awaits for an
            // `InlineCompletionItemProvider` to be registered.
            return vscode.languages.registerInlineCompletionItemProvider(
                '*',
                new NoopCompletionItemProvider()
            )
        }

        return {
            dispose: () => {},
        }
    }

    const disposables: vscode.Disposable[] = []

    const [
        providerConfig,
        bfgMixedContextFlag,
        newJaccardSimilarityContextFlag,
        dynamicMultilineCompletionsFlag,
        hotStreakFlag,
        fastPathFlag,
    ] = await Promise.all([
        createProviderConfig(config, client, authProvider.getAuthStatus().configOverwrites),
        featureFlagProvider.evaluateFeatureFlag(FeatureFlag.CodyAutocompleteContextBfgMixed),
        featureFlagProvider.evaluateFeatureFlag(FeatureFlag.CodyAutocompleteContextNewJaccardSimilarity),
        featureFlagProvider.evaluateFeatureFlag(FeatureFlag.CodyAutocompleteDynamicMultilineCompletions),
        featureFlagProvider.evaluateFeatureFlag(FeatureFlag.CodyAutocompleteHotStreak),
        featureFlagProvider.evaluateFeatureFlag(FeatureFlag.CodyAutocompleteFastPath),
    ])
    if (providerConfig) {
        const contextStrategy: ContextStrategy =
            config.autocompleteExperimentalGraphContext === 'bfg'
                ? 'bfg'
                : config.autocompleteExperimentalGraphContext === 'bfg-mixed'
                  ? 'bfg-mixed'
                  : config.autocompleteExperimentalGraphContext === 'local-mixed'
                      ? 'local-mixed'
                      : config.autocompleteExperimentalGraphContext === 'jaccard-similarity'
                          ? 'jaccard-similarity'
                          : config.autocompleteExperimentalGraphContext === 'new-jaccard-similarity'
                              ? 'new-jaccard-similarity'
                              : bfgMixedContextFlag
                                  ? 'bfg-mixed'
                                  : newJaccardSimilarityContextFlag
                                      ? 'new-jaccard-similarity'
                                      : 'jaccard-similarity'

        const dynamicMultilineCompletions =
            config.autocompleteExperimentalDynamicMultilineCompletions || dynamicMultilineCompletionsFlag
        const hotStreak = config.autocompleteExperimentalHotStreak || hotStreakFlag
        const fastPath = config.autocompleteExperimentalFastPath || fastPathFlag

        const authStatus = authProvider.getAuthStatus()
        const completionsProvider = new InlineCompletionItemProvider({
            authStatus: authProvider.getAuthStatus(),
            providerConfig,
            statusBar,
            completeSuggestWidgetSelection: config.autocompleteCompleteSuggestWidgetSelection,
            formatOnAccept: config.autocompleteFormatOnAccept,
            triggerNotice,
            isRunningInsideAgent: config.isRunningInsideAgent,
            contextStrategy,
            createBfgRetriever,
            dynamicMultilineCompletions,
            hotStreak,
            fastPath,
            isDotComUser: isDotCom(authStatus.endpoint || ''),
        })

        const documentFilters = await getInlineCompletionItemProviderFilters(
            config.autocompleteLanguages
        )

        disposables.push(
            vscode.commands.registerCommand('cody.autocomplete.manual-trigger', () =>
                completionsProvider.manuallyTriggerCompletion()
            ),
            vscode.languages.registerInlineCompletionItemProvider(
                [{ notebookType: '*' }, ...documentFilters],
                completionsProvider
            ),
            registerAutocompleteTraceView(completionsProvider),
            completionsProvider
        )
    } else if (config.isRunningInsideAgent) {
        throw new Error(
            `Can't register completion provider because \`providerConfig\` evaluated to \`null\`. To fix this problem, debug why createProviderConfig returned null instead of ProviderConfig. To further debug this problem, here is the configuration:\n${JSON.stringify(
                config,
                null,
                2
            )}`
        )
    }

    return {
        dispose: () => {
            for (const disposable of disposables) {
                disposable.dispose()
            }
        },
    }
}

// Languages which should be disabled, but they are not present in
// https://code.visualstudio.com/docs/languages/identifiers#_known-language-identifiers
// But they exist in the `vscode.languages.getLanguages()` return value.
//
// To avoid confusing users with unknown language IDs, we disable them here programmatically.
const DISABLED_LANGUAGES = new Set(['scminput'])

export async function getInlineCompletionItemProviderFilters(
    autocompleteLanguages: Record<string, boolean>
): Promise<vscode.DocumentFilter[]> {
    const { '*': isEnabledForAll, ...perLanguageConfig } = autocompleteLanguages
    const languageIds = await vscode.languages.getLanguages()

    return languageIds.flatMap(language => {
        const enabled =
            !DISABLED_LANGUAGES.has(language) && language in perLanguageConfig
                ? perLanguageConfig[language]
                : isEnabledForAll

        return enabled ? [{ language, scheme: 'file' }] : []
    })
}
