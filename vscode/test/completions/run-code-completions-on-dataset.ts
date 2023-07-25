/* eslint-disable no-sync */
import './mock-vscode'

import fs from 'fs'
import path from 'path'

import * as vscode from 'vscode'
import { URI } from 'vscode-uri'

import { NoopEditor } from '@sourcegraph/cody-shared/src/editor'

import { CodyCompletionItemProvider } from '../../src/completions'
import { GetContextResult } from '../../src/completions/context'
import { History } from '../../src/completions/history'
import { createProviderConfig } from '../../src/completions/providers/anthropic'
import { getFullConfig } from '../../src/configuration'
import { configureExternalServices } from '../../src/external-services'
import { InMemorySecretStorage } from '../../src/services/SecretStorageProvider'

import { completionsDataset, CURSOR, Sample } from './completions-dataset'
import { ENVIRONMENT_CONFIG } from './environment-config'
import { findSubstringPosition } from './utils'
import { TextDocument } from './vscode-text-document'

async function initCompletionsProvider(context: GetContextResult): Promise<CodyCompletionItemProvider> {
    const secretStorage = new InMemorySecretStorage()
    await secretStorage.store('cody.access-token', ENVIRONMENT_CONFIG.SOURCEGRAPH_ACCESS_TOKEN)

    const initialConfig = await getFullConfig(secretStorage)
    console.error('Running `initCompletionsProvider` with config:', initialConfig)

    if (!initialConfig.autocomplete) {
        throw new Error('`cody.autocomplete` is not true!')
    }

    const { completionsClient, codebaseContext } = await configureExternalServices(
        initialConfig,
        'rg',
        new NoopEditor()
    )

    const history = new History()

    const providerConfig = createProviderConfig({
        completionsClient,
        contextWindowTokens: 2048,
    })
    const completionsProvider = new CodyCompletionItemProvider({
        providerConfig,
        statusBar: {
            startLoading: () => () => {},
            dispose: () => {},
        },
        history,
        codebaseContext,
        disableTimeouts: true,
        triggerMoreEagerly: false,
        cache: null,
        isEmbeddingsContextEnabled: true,
        contextFetcher: () => Promise.resolve(context),
    })

    return completionsProvider
}

/**
 * Converts the code sample to a format that can be used by the VSCode completions provider.
 */
function prepareTextDocument(
    code: string,
    fileName: string,
    languageId: string
): { textDocument: TextDocument; position: vscode.Position } {
    const position = findSubstringPosition(code, CURSOR)

    if (!position) {
        throw new Error(`No caret position found! add ${CURSOR} to the code.`)
    }

    // Remove CURSOR marks from the code before processing it further.
    const completionReadyCode = code.replaceAll(CURSOR, '')
    const textDocument = new TextDocument(URI.parse('file://' + fileName), languageId, completionReadyCode)

    return { textDocument, position }
}

interface CompletionResult {
    completions: string[]
    elapsed: number
    timestamp: string
    sample: Sample
}

const sampleIndex = process.env.SAMPLE_INDEX ? parseInt(process.env.SAMPLE_INDEX, 10) : null
const iterationsPerCodeSample = parseInt(process.env.ITER || '1', 10)

// TODO: use VSCode mocked APIs to provide context for the completions provider
// See vscode/src/completions/context.ts:10:23
async function generateCompletionsForDataset(codeSamples: Sample[]): Promise<void> {
    const timestamp = Date.now().toString()
    const results: CompletionResult[] = []
    for (const [index, sample] of codeSamples.entries()) {
        const { content, fileName, languageId } = sample
        if (sampleIndex !== null && sampleIndex !== index) {
            continue
        }

        const { textDocument, position } = prepareTextDocument(content, fileName, languageId)

        const codeSampleResults: CompletionResult[] = []
        for (let i = 0; i < iterationsPerCodeSample; i++) {
            const start = Date.now()

            const context = {
                context: sample.context,
                logSummary: {
                    duration: 0,
                },
            }

            const completionsProvider = await initCompletionsProvider(context)
            const completionItems = await completionsProvider.provideInlineCompletionItems(
                textDocument,
                position,
                {
                    triggerKind: 1,
                    selectedCompletionInfo: undefined,
                },
                undefined
            )

            const completions = ('items' in completionItems ? completionItems.items : completionItems).map(item =>
                typeof item.insertText === 'string' ? item.insertText : ''
            )
            console.error(`#${index}@i=${i}`, completions)
            codeSampleResults.push({
                completions,
                elapsed: Date.now() - start,
                timestamp,
                sample,
            })
        }
        results.push(...codeSampleResults)

        if (iterationsPerCodeSample > 1) {
            const meanElapsed =
                codeSampleResults.reduce((acc, result) => acc + result.elapsed, 0) / codeSampleResults.length
            console.error(`#${index} mean elapsed: ${Math.round(meanElapsed)}ms`)
        }
    }

    // TODO: prettify path management
    // Save results to a JSON file in the completions-review-tool/data folder to be used by the review tool:
    // pnpm --filter @sourcegraph/completions-review-tool run dev
    fs.mkdirSync(ENVIRONMENT_CONFIG.OUTPUT_PATH, { recursive: true })
    const filename = path.join(ENVIRONMENT_CONFIG.OUTPUT_PATH, `anthropic-${timestamp}.json`)
    fs.writeFileSync(filename, JSON.stringify(results, null, 2))
    console.log('\n✅ Completions saved to:', filename)
}

generateCompletionsForDataset(completionsDataset).catch(console.error)
