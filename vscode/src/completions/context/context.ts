import * as vscode from 'vscode'

import { CodebaseContext } from '@sourcegraph/cody-shared/src/codebase-context'

import { ContextSnippet } from '../types'

import { getContextFromEmbeddings } from './context-embeddings'
import { getContextFromGraph, GraphContextFetcher } from './context-graph'
import { getContextFromCurrentEditor } from './context-local'
import { DocumentHistory } from './history'

export interface GetContextOptions {
    document: vscode.TextDocument
    position: vscode.Position
    history: DocumentHistory
    prefix: string
    suffix: string
    contextRange: vscode.Range
    jaccardDistanceWindowSize: number
    maxChars: number
    getCodebaseContext: () => CodebaseContext
    isEmbeddingsContextEnabled?: boolean
    graphContextFetcher?: GraphContextFetcher
}

export type ContextSummary = Readonly<{
    embeddings?: number
    local?: number
    graph?: number
    duration: number
}>

export interface GetContextResult {
    context: ContextSnippet[]
    logSummary: ContextSummary
}

export async function getContext(options: GetContextOptions): Promise<GetContextResult> {
    const graphContext = await getContextFromGraph(options)
    // When we have graph matches, use it exclusively for the context
    // TODO(philipp-spiess): Do we want to mix this with local context?
    if (graphContext) {
        return graphContext
    }

    const { maxChars, isEmbeddingsContextEnabled } = options
    const start = performance.now()

    /**
     * The embeddings context is sync to retrieve to keep the completions latency minimal. If it's
     * not available in cache yet, we'll retrieve it in the background and cache it for future use.
     */
    const embeddingsMatches = isEmbeddingsContextEnabled ? getContextFromEmbeddings(options) : []
    const localMatches = await getContextFromCurrentEditor(options)

    /**
     * Iterate over matches and add them to the context.
     * Discard editor matches for files with embedding matches.
     */
    const usedFilenames = new Set<string>()
    const context: ContextSnippet[] = []
    let totalChars = 0
    function addMatch(match: ContextSnippet): boolean {
        // TODO(@philipp-spiess): We should de-dupe on the snippet range and not
        // the file name to allow for more than one snippet of the same file
        if (usedFilenames.has(match.fileName)) {
            return false
        }
        usedFilenames.add(match.fileName)

        if (totalChars + match.content.length > maxChars) {
            return false
        }
        context.push(match)
        totalChars += match.content.length
        return true
    }

    // TODO(@philipp-spiess): Rank embedding results against local context
    // snippets instead of always appending embedding results at the top.
    let includedEmbeddingsMatches = 0
    for (const match of embeddingsMatches) {
        if (addMatch(match)) {
            includedEmbeddingsMatches++
        }
    }
    let includedLocalMatches = 0
    for (const match of localMatches) {
        if (addMatch(match)) {
            includedLocalMatches++
        }
    }

    return {
        context,
        logSummary: {
            ...(includedEmbeddingsMatches ? { embeddings: includedEmbeddingsMatches } : {}),
            ...(includedLocalMatches ? { local: includedLocalMatches } : {}),
            duration: performance.now() - start,
        },
    }
}
