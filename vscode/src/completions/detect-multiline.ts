import { Position } from 'vscode'

import { getLanguageConfig } from '../tree-sitter/language'

import { DocumentDependentContext, LinesContext } from './get-current-doc-context'
import { completionPostProcessLogger } from './post-process-logger'
import {
    FUNCTION_KEYWORDS,
    FUNCTION_OR_METHOD_INVOCATION_REGEX,
    getLastLine,
    indentation,
    lines,
    OPENING_BRACKET_REGEX,
} from './text-processing'

interface DetectMultilineParams {
    docContext: LinesContext & DocumentDependentContext
    languageId: string
    dynamicMultlilineCompletions: boolean
    position: Position
}

interface DetectMultilineResult {
    multilineTrigger: string | null
    multilineTriggerPosition: Position | null
}

export function detectMultiline(params: DetectMultilineParams): DetectMultilineResult {
    const { docContext, languageId, dynamicMultlilineCompletions, position } = params
    const {
        prefix,
        prevNonEmptyLine,
        nextNonEmptyLine,
        currentLinePrefix,
        currentLineSuffix,
        completionPostProcessId,
    } = docContext

    const blockStart = getLanguageConfig(languageId)?.blockStart
    const isBlockStartActive = blockStart && prefix.trimEnd().endsWith(blockStart)

    const checkInvocation =
        currentLineSuffix.trim().length > 0 ? currentLinePrefix + currentLineSuffix : currentLinePrefix

    // Don't fire multiline completion for method or function invocations
    // see https://github.com/sourcegraph/cody/discussions/358#discussioncomment-6519606
    if (
        !dynamicMultlilineCompletions &&
        !currentLinePrefix.trim().match(FUNCTION_KEYWORDS) &&
        checkInvocation.match(FUNCTION_OR_METHOD_INVOCATION_REGEX)
    ) {
        return {
            multilineTrigger: null,
            multilineTriggerPosition: null,
        }
    }
    completionPostProcessLogger.info({ completionPostProcessId, stage: 'detectMultiline', text: currentLinePrefix })

    const openingBracketMatch = currentLinePrefix.match(OPENING_BRACKET_REGEX)
    if (
        openingBracketMatch &&
        // Only trigger multiline suggestions when the next non-empty line is indented less
        // than the block start line (the newly created block is empty).
        indentation(currentLinePrefix) >= indentation(nextNonEmptyLine)
    ) {
        return {
            multilineTrigger: openingBracketMatch[0],
            multilineTriggerPosition: getPrefixLastNonEmptyCharPosition(prefix, position),
        }
    }

    const nonEmptyLineEndsWithBlockStart =
        currentLinePrefix.length > 0 &&
        isBlockStartActive &&
        indentation(currentLinePrefix) >= indentation(nextNonEmptyLine)

    const isEmptyLineAfterBlockStart =
        currentLinePrefix.trim() === '' &&
        currentLineSuffix.trim() === '' &&
        // Only trigger multiline suggestions for the beginning of blocks
        isBlockStartActive &&
        // Only trigger multiline suggestions when the new current line is indented
        indentation(prevNonEmptyLine) < indentation(currentLinePrefix) &&
        // Only trigger multiline suggestions when the next non-empty line is indented less
        // than the block start line (the newly created block is empty).
        indentation(prevNonEmptyLine) >= indentation(nextNonEmptyLine)

    if ((dynamicMultlilineCompletions && nonEmptyLineEndsWithBlockStart) || isEmptyLineAfterBlockStart) {
        return {
            multilineTrigger: blockStart,
            multilineTriggerPosition: getPrefixLastNonEmptyCharPosition(prefix, position),
        }
    }

    return {
        multilineTrigger: null,
        multilineTriggerPosition: null,
    }
}

/**
 * Precalculate the multiline trigger position based on `prefix` and `cursorPosition` to be
 * able to change it during streaming to the end of the first line of the completion.
 */
function getPrefixLastNonEmptyCharPosition(prefix: string, cursorPosition: Position): Position {
    const trimmedPrefix = prefix.trimEnd()
    const diffLength = prefix.length - trimmedPrefix.length
    if (diffLength === 0) {
        return cursorPosition
    }

    const prefixDiff = prefix.slice(-diffLength)
    return cursorPosition.translate(-(lines(prefixDiff).length - 1), getLastLine(trimmedPrefix).length - 2)
}
