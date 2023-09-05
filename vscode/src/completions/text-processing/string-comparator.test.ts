import { describe, expect, it } from 'vitest'

import { isAlmostTheSameString, LevenshteinCompare } from './string-comparator'

describe('isAlmostTheSameString', () => {
    it.each([
        [true, '', ''],
        [true, 'return []', ' return []'],
        [true, 'const abortController = new AbortController()', 'const networkAbortController = new AbortController()'],
        [
            true,
            'const currentFilePath = path.normalize(document.fileName)',
            'const filePath = path.normalize(document.fileName)',
        ],
        [
            false,
            "console.log('Hello world', getSumAandB(a, b))",
            "console.error('Error log', getDBConnection(context))",
        ],
    ])('should return %b for strings %s and %s', (expected, stringA, stringB) => {
        expect(isAlmostTheSameString(stringA, stringB)).toBe(expected)
    })
})

describe('Levenshtein comparator', () => {
    it.each([
        ['', '', 0],
        ['a', '', 1],
        ['aa', '', 2],
        ['', 'b', 1],
        ['', 'bb', 2],
        ['Mark', 'Zack', 2],
        ['POLYNOMIAL', 'EXPONENTIAL', 6],
    ])('should return a correct number of edit for %s and %s strings (edits = %i)', (a, b, expected) => {
        const numbersOfEdit = LevenshteinCompare(a, b)

        expect(numbersOfEdit).toBe(expected)
    })
})
