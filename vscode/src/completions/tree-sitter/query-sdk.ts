import { Position, TextDocument } from 'vscode'
import Parser, { Language, Point, Query, QueryCapture, SyntaxNode } from 'web-tree-sitter'

import { getParseLanguage, SupportedLanguage } from './grammars'
import { getCachedParseTreeForDocument } from './parse-tree-cache'
import { getParser } from './parser'
import { CompletionIntent, intentPriority, languages, QueryName } from './queries'

interface ParsedQuery {
    compiled: Query
    raw: string
}
type ResolvedQueries = {
    [name in QueryName]: ParsedQuery
}

const QUERIES_LOCAL_CACHE: Partial<Record<SupportedLanguage, ResolvedQueries & QueryWrappers>> = {}

/**
 * Reads all language queries from disk and parses them.
 * Saves queries the local cache for further use.
 */
export function initQueries(language: Language, languageId: SupportedLanguage, parser: Parser): void {
    const cachedQueries = QUERIES_LOCAL_CACHE[languageId]
    if (cachedQueries) {
        return
    }

    const languageQueries = languages[languageId]
    if (languageQueries === undefined) {
        return
    }

    const queryEntries = Object.entries(languageQueries).map(([name, raw]) => {
        return [
            name,
            {
                raw,
                compiled: language.query(raw),
            },
        ] as const
    })

    const queries = Object.fromEntries<ParsedQuery>(queryEntries) as ResolvedQueries

    QUERIES_LOCAL_CACHE[languageId] = {
        ...queries,
        ...getLanguageSpecificQueryWrappers(queries, parser),
    }
}

export interface DocumentQuerySDK {
    parser: Parser
    queries: ResolvedQueries & QueryWrappers
    language: SupportedLanguage
}

/**
 * Returns the query SDK only if the language has queries defined and
 * the relevant laguage parser is initialized.
 */
export function getDocumentQuerySDK(language: string): DocumentQuerySDK | null {
    const supportedLanguage = getParseLanguage(language)
    if (!supportedLanguage) {
        return null
    }

    const parser = getParser(supportedLanguage)
    const queries = QUERIES_LOCAL_CACHE[supportedLanguage]

    if (!parser || !queries) {
        return null
    }

    return {
        parser,
        queries,
        language: supportedLanguage,
    }
}

export interface QueryWrappers {
    /**
     * Returns the first block-like node (block_statement).
     * Handles special cases where we want to use the parent block instead
     * if it has a specific node type (if_statement).
     */
    getFirstMultilineBlockForTruncation: (
        node: SyntaxNode,
        start: Point,
        end?: Point
    ) => [] | readonly [{ readonly node: SyntaxNode; readonly name: 'trigger' }]
    getSinglelineTrigger: (
        node: SyntaxNode,
        start: Point,
        end?: Point
    ) => [] | readonly [{ readonly node: SyntaxNode; readonly name: 'trigger' }]
    getCompletionIntent: (
        node: SyntaxNode,
        start: Point,
        end?: Point
    ) => [] | readonly [{ readonly node: SyntaxNode; readonly name: CompletionIntent }]
}

/**
 * Query wrappers with custom post-processing logic.
 */
function getLanguageSpecificQueryWrappers(queries: ResolvedQueries, _parser: Parser): QueryWrappers {
    return {
        getFirstMultilineBlockForTruncation: (root, start, end) => {
            const captures = queries.blocks.compiled.captures(root, start, end)
            const { trigger } = getTriggerNodeWithBlockStaringAtPoint(captures, start)

            if (!trigger) {
                return []
            }

            // Check for special cases where we need match a parent node.
            const potentialParentNodes = captures.filter(capture => capture.name === 'parents')
            const potentialParent = potentialParentNodes.find(capture => trigger.parent?.id === capture.node.id)?.node

            return [{ node: potentialParent || trigger, name: 'trigger' }] as const
        },
        getSinglelineTrigger: (root, start, end) => {
            const captures = queries.singlelineTriggers.compiled.captures(root, start, end)
            const { trigger, block } = getTriggerNodeWithBlockStaringAtPoint(captures, start)

            if (!trigger || !block || !isBlockNodeEmpty(block)) {
                return []
            }

            return [{ node: trigger, name: 'trigger' }] as const
        },
        getCompletionIntent: (root, start, end) => {
            const captures = queries.intents.compiled.captures(root, start, end)

            const { intentCapture } = getIntentFromCaptures(captures, start)

            if (!intentCapture) {
                return []
            }

            return [{ node: intentCapture.node, name: intentCapture.name as CompletionIntent }] as const
        },
    }
}

// TODO: check if the block parent is empty in the consumer.
function getIntentFromCaptures(
    captures: QueryCapture[],
    cursor: Point
): { cursorCapture?: Parser.QueryCapture; intentCapture?: Parser.QueryCapture } {
    const emptyResult = {
        cursorCapture: undefined,
        intentCapture: undefined,
    }

    if (!captures.length) {
        return emptyResult
    }

    const [cursorCapture] = sortByIntentPriority(
        captures.filter(capture => {
            const { name, node } = capture

            const matchesCursorPosition =
                node.startPosition.column === cursor.column && node.startPosition.row === cursor.row

            return name.endsWith('.cursor') && matchesCursorPosition
        })
    )

    const cursorCaptureIndex = captures.findIndex(capture => capture.node === cursorCapture?.node)
    const intentCapture = captures[cursorCaptureIndex - 1]

    if (cursorCapture && intentCapture && intentCapture.name === withoutCursorSuffix(cursorCapture?.name)) {
        return { cursorCapture, intentCapture }
    }

    const atomicCapture = captures.findLast(capture => {
        // TODO: should we check against the cursor position?
        // const matchesCursorPosition =
        // node.startPosition.column === cursor.column && node.startPosition.row === cursor.row

        return capture.name.endsWith('!')
    })

    if (atomicCapture) {
        return {
            intentCapture: {
                ...atomicCapture,
                // Remove `!` from the end of the capture name.
                name: atomicCapture.name.slice(0, -1),
            },
        }
    }

    return emptyResult
}

function sortByIntentPriority(captures: QueryCapture[]): QueryCapture[] {
    return captures.sort((a, b) => {
        return (
            intentPriority.indexOf(withoutCursorSuffix(a.name) as CompletionIntent) -
            intentPriority.indexOf(withoutCursorSuffix(b.name) as CompletionIntent)
        )
    })
}

function withoutCursorSuffix(name?: string): string | undefined {
    return name?.split('.').slice(0, -1).join('.')
}

function getTriggerNodeWithBlockStaringAtPoint(
    captures: QueryCapture[],
    point: Point
): { trigger?: SyntaxNode; block?: SyntaxNode } {
    const emptyResult = {
        trigger: undefined,
        block: undefined,
    }

    if (!captures.length) {
        return emptyResult
    }

    const blockStart = getNodeIfMatchesPoint({
        captures,
        name: 'block_start',
        // Taking the last result to get the most nested node.
        // See https://github.com/tree-sitter/tree-sitter/discussions/2067
        index: -1,
        point,
    })

    const trigger = getCapturedNodeAt({
        captures,
        name: 'trigger',
        index: -1,
    })

    const block = blockStart?.parent

    if (!blockStart || !block || !trigger) {
        return emptyResult
    }

    // Verify that the block node ends at the same position as the trigger node.
    if (trigger.endIndex !== block?.endIndex) {
        return emptyResult
    }

    return { trigger, block }
}

interface GetNodeIfMatchesPointParams {
    captures: QueryCapture[]
    name: string
    index: number
    point: Point
}

function getNodeIfMatchesPoint(params: GetNodeIfMatchesPointParams): SyntaxNode | null {
    const { captures, name, index, point } = params

    const node = getCapturedNodeAt({ captures, name, index })

    if (node && node.startPosition.column === point.column && node.startPosition.row === point.row) {
        return node
    }

    return null
}

interface GetCapturedNodeAtParams {
    captures: QueryCapture[]
    name: string
    index: number
}

function getCapturedNodeAt(params: GetCapturedNodeAtParams): SyntaxNode | null {
    const { captures, name, index } = params

    return captures.filter(capture => capture.name === name).at(index)?.node || null
}

/**
 * Consider a block empty if it does not have any named children or is missing its closing tag.
 */
function isBlockNodeEmpty(node: SyntaxNode | null): boolean {
    // Consider a node empty if it does not have any named children.
    const isBlockEmpty = node?.children.filter(c => c.isNamed()).length === 0
    const isMissingBlockEnd = Boolean(node?.lastChild?.isMissing())

    return isBlockEmpty || isMissingBlockEnd
}

interface QueryPoints {
    startPoint: Point
    endPoint: Point
}

export function positionToQueryPoints(position: Pick<Position, 'line' | 'character'>): QueryPoints {
    const startPoint = {
        row: position.line,
        column: position.character,
    }

    const endPoint = {
        row: position.line,
        // Querying around one character after trigger position.
        column: position.character + 1,
    }

    return { startPoint, endPoint }
}

export function execQueryWrapper<T extends keyof QueryWrappers>(
    document: TextDocument,
    position: Pick<Position, 'line' | 'character'>,
    queryWrapper: T
): ReturnType<QueryWrappers[T]> | never[] {
    const parseTreeCache = getCachedParseTreeForDocument(document)
    const documentQuerySDK = getDocumentQuerySDK(document.languageId)

    const { startPoint, endPoint } = positionToQueryPoints(position)

    if (documentQuerySDK && parseTreeCache) {
        return documentQuerySDK.queries[queryWrapper](parseTreeCache.tree.rootNode, startPoint, endPoint) as ReturnType<
            QueryWrappers[T]
        >
    }

    return []
}

export { CompletionIntent }
