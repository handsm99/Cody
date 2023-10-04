import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getLatency, isLineComment, resetLatency } from './latency'

describe('getLatency', () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })
    afterEach(() => {
        vi.restoreAllMocks()
        resetLatency()
    })

    it('returns gradually increasing latency for anthropic provider when language is unsupported, up to max latency', () => {
        const provider = 'anthropic'
        const fileName = 'foo/bar/test'
        const languageId = undefined

        // start with default high latency for unsupported lang with default user latency added
        expect(getLatency(provider, fileName, languageId)).toBe(1000)
        // gradually increasing latency after 5 rejected suggestions
        expect(getLatency(provider, fileName, languageId)).toBe(1000)
        expect(getLatency(provider, fileName, languageId)).toBe(1000)
        expect(getLatency(provider, fileName, languageId)).toBe(1000)
        expect(getLatency(provider, fileName, languageId)).toBe(1000)
        // gradually increasing latency after 5 rejected suggestions
        expect(getLatency(provider, fileName, languageId)).toBe(1200)
        expect(getLatency(provider, fileName, languageId)).toBe(1400)
        // after the suggestion was accepted, user latency resets to 0, using baseline only
        resetLatency()
        expect(getLatency(provider, fileName, languageId)).toBe(1000)
        resetLatency()
        // next rejection doesn't change user latency until 5 rejected
        expect(getLatency(provider, fileName, languageId)).toBe(1000)
        expect(getLatency(provider, fileName, languageId)).toBe(1000)
        expect(getLatency(provider, fileName, languageId)).toBe(1000)
        expect(getLatency(provider, fileName, languageId)).toBe(1000)
        expect(getLatency(provider, fileName, languageId)).toBe(1000)
        expect(getLatency(provider, fileName, languageId)).toBe(1200)
    })

    it('returns gradually increasing latency up to max for CSS on anthropic provider when suggestions are rejected', () => {
        const provider = 'anthropic'
        const fileName = 'foo/bar/test.css'
        const languageId = 'css'

        // start with default high latency for low performance lang with default user latency added
        expect(getLatency(provider, fileName, languageId)).toBe(1000)
        expect(getLatency(provider, fileName, languageId)).toBe(1000)
        expect(getLatency(provider, fileName, languageId)).toBe(1000)
        expect(getLatency(provider, fileName, languageId)).toBe(1000)
        expect(getLatency(provider, fileName, languageId)).toBe(1000)
        // start at default, but gradually increasing latency after 5 rejected suggestions
        expect(getLatency(provider, fileName, languageId)).toBe(1200)
        expect(getLatency(provider, fileName, languageId)).toBe(1400)
        expect(getLatency(provider, fileName, languageId)).toBe(1600)
        expect(getLatency(provider, fileName, languageId)).toBe(1800)
        // max latency at 2000
        expect(getLatency(provider, fileName, languageId)).toBe(2000)
        expect(getLatency(provider, fileName, languageId)).toBe(2000)
        expect(getLatency(provider, fileName, languageId)).toBe(2000)
        // after the suggestion was accepted, user latency resets to 0, using baseline only
        resetLatency()
        expect(getLatency(provider, fileName, languageId)).toBe(1000)
        resetLatency()
        expect(getLatency(provider, fileName, languageId)).toBe(1000)
        expect(getLatency(provider, fileName, languageId)).toBe(1000)
        expect(getLatency(provider, fileName, languageId)).toBe(1000)
        expect(getLatency(provider, fileName, languageId)).toBe(1000)
        expect(getLatency(provider, fileName, languageId)).toBe(1000)
        // gradually increasing latency after 5 rejected suggestions
        expect(getLatency(provider, fileName, languageId)).toBe(1200)
        expect(getLatency(provider, fileName, languageId)).toBe(1400)
        // Latency will not reset before 5 minutes
        vi.advanceTimersByTime(3 * 60 * 1000)
        expect(getLatency(provider, fileName, languageId)).toBe(1600)
        expect(getLatency(provider, fileName, languageId)).toBe(1800)
        expect(getLatency(provider, fileName, languageId)).toBe(2000)
        expect(getLatency(provider, fileName, languageId)).toBe(2000)
        // Latency will be reset after 5 minutes
        vi.advanceTimersByTime(5 * 60 * 1000)
        expect(getLatency(provider, fileName, languageId)).toBe(1000)
        // reset latency on accepted suggestion
        resetLatency()
        expect(getLatency(provider, fileName, languageId)).toBe(1000)
    })

    it('returns increasing latency after rejecting suggestions on anthropic provider', () => {
        const provider = 'anthropic'
        const fileName = 'foo/bar/test.ts'
        const languageId = 'typescript'

        // start at default, but gradually increasing latency after 5 rejected suggestions
        expect(getLatency(provider, fileName, languageId)).toBe(0)
        expect(getLatency(provider, fileName, languageId)).toBe(0)
        expect(getLatency(provider, fileName, languageId)).toBe(0)
        expect(getLatency(provider, fileName, languageId)).toBe(0)
        expect(getLatency(provider, fileName, languageId)).toBe(0)
        // gradually increasing latency after 5 rejected suggestions
        expect(getLatency(provider, fileName, languageId)).toBe(200)
        expect(getLatency(provider, fileName, languageId)).toBe(400)
        expect(getLatency(provider, fileName, languageId)).toBe(600)
        // after the suggestion was accepted, user latency resets to 0, using baseline only
        resetLatency()
        expect(getLatency(provider, fileName, languageId)).toBe(0)
    })

    it('returns default latency for CSS after accepting suggestion and resets after 5 minutes', () => {
        const provider = 'non-anthropic'
        const fileName = 'foo/bar/test.css'
        const languageId = 'css'

        // start with default baseline latency with low performance and user latency added
        expect(getLatency(provider, fileName, languageId)).toBe(1000)
        // reset to starting point on every accepted suggestion
        resetLatency()
        expect(getLatency(provider, fileName, languageId)).toBe(1000)
        resetLatency()
        expect(getLatency(provider, fileName, languageId)).toBe(1000)
        expect(getLatency(provider, fileName, languageId)).toBe(1000)
        // Latency will not reset before 5 minutes
        vi.advanceTimersByTime(3 * 60 * 1000)
        expect(getLatency(provider, fileName, languageId)).toBe(1000)
        expect(getLatency(provider, fileName, languageId)).toBe(1000)
        expect(getLatency(provider, fileName, languageId)).toBe(1000)
        expect(getLatency(provider, fileName, languageId)).toBe(1200)
        // Latency will be reset after 5 minutes
        vi.advanceTimersByTime(5 * 60 * 1000)
        expect(getLatency(provider, fileName, languageId)).toBe(1000)
    })

    it('returns increasing latency up to max after multiple rejections for supported language on non-anthropic provider', () => {
        const provider = 'non-anthropic'
        const fileName = 'foo/bar/test.ts'
        const languageId = 'typescript'

        // start with default baseline latency with low performance and user latency added
        expect(getLatency(provider, fileName, languageId)).toBe(400)
        expect(getLatency(provider, fileName, languageId)).toBe(400)
        expect(getLatency(provider, fileName, languageId)).toBe(400)
        expect(getLatency(provider, fileName, languageId)).toBe(400)
        expect(getLatency(provider, fileName, languageId)).toBe(400)
        // latency should start increasing after 5 rejections, but max at 2000
        expect(getLatency(provider, fileName, languageId)).toBe(600)
        expect(getLatency(provider, fileName, languageId)).toBe(800)
        expect(getLatency(provider, fileName, languageId)).toBe(1000)
        expect(getLatency(provider, fileName, languageId)).toBe(1200)
        expect(getLatency(provider, fileName, languageId)).toBe(1400)
        // Latency will not reset before 5 minutes
        vi.advanceTimersByTime(3 * 60 * 1000)
        expect(getLatency(provider, fileName, languageId)).toBe(1600)
        expect(getLatency(provider, fileName, languageId)).toBe(1800)
        // max at 2000 after multiple rejections
        expect(getLatency(provider, fileName, languageId)).toBe(2000)
        expect(getLatency(provider, fileName, languageId)).toBe(2000)
        expect(getLatency(provider, fileName, languageId)).toBe(2000)
        // reset latency on accepted suggestion
        resetLatency()
        expect(getLatency(provider, fileName, languageId)).toBe(400)
    })

    it('returns increasing latency up to max after rejecting multiple suggestions, resets after file change and accept', () => {
        const provider = 'non-anthropic'
        const fileName = 'foo/bar/test.ts'
        const languageId = 'typescript'

        // start with default baseline latency with low performance and user latency added
        expect(getLatency(provider, fileName, languageId)).toBe(400)
        // latency should start increasing after 5 rejections, but max at 2000
        expect(getLatency(provider, fileName, languageId)).toBe(400)
        expect(getLatency(provider, fileName, languageId)).toBe(400)
        expect(getLatency(provider, fileName, languageId)).toBe(400)
        expect(getLatency(provider, fileName, languageId)).toBe(400)

        expect(getLatency(provider, fileName, languageId)).toBe(600)
        // line is a comment, so latency should be increased where:
        // base is 1000 due to line is a comment, and user latency is 400 as this is the 7th rejection
        expect(getLatency(provider, fileName, languageId, true)).toBe(1400)
        expect(getLatency(provider, fileName, languageId)).toBe(1000)
        expect(getLatency(provider, fileName, languageId)).toBe(1200)
        expect(getLatency(provider, fileName, languageId)).toBe(1400)
        expect(getLatency(provider, fileName, languageId)).toBe(1600)
        expect(getLatency(provider, fileName, languageId)).toBe(1800)
        // max at 2000 after multiple rejections
        expect(getLatency(provider, fileName, languageId)).toBe(2000)
        expect(getLatency(provider, fileName, languageId)).toBe(2000)
        expect(getLatency(provider, fileName, languageId)).toBe(2000)

        // reset latency on file change to default
        const newFileName = 'foo/test.ts'
        // latency should start increasing again after 5 rejections
        expect(getLatency(provider, newFileName, languageId)).toBe(400)
        expect(getLatency(provider, newFileName, languageId)).toBe(400)
        // line is a comment, so latency should be increased
        expect(getLatency(provider, newFileName, languageId, true)).toBe(1000)
        expect(getLatency(provider, newFileName, languageId)).toBe(400)
        expect(getLatency(provider, newFileName, languageId)).toBe(400)
        // Latency will not reset before 5 minutes
        vi.advanceTimersByTime(3 * 60 * 1000)
        expect(getLatency(provider, newFileName, languageId)).toBe(600)
        // reset latency on accepted suggestion
        resetLatency()
        expect(getLatency(provider, newFileName, languageId)).toBe(400)
    })
})

describe('isLineComment', () => {
    it('returns true for `//` comments', () => {
        expect(isLineComment('// comment', 'typescript')).toBe(true)
    })

    it('returns true for `/* */` comments', () => {
        expect(isLineComment('/* comment */', 'javascript')).toBe(true)
    })

    it('returns true for `*` comments', () => {
        expect(isLineComment('/* comment */', 'typescriptreact')).toBe(true)
    })

    it('returns true for Python docstrings', () => {
        expect(isLineComment('"""docstring"""', 'python')).toBe(true)
    })

    it('returns true for Ruby comments starting with #', () => {
        expect(isLineComment('# comment', 'ruby')).toBe(true)
    })

    it('returns false for non-comment lines', () => {
        expect(isLineComment('const foo = "bar"', 'typescript')).toBe(false)
    })

    it('returns false for empty lines', () => {
        expect(isLineComment('', 'typescript')).toBe(false)
    })

    it('returns false for whitespace only lines', () => {
        expect(isLineComment('   ', 'typescript')).toBe(false)
    })

    it('returns true for C++ style `//` comments', () => {
        expect(isLineComment('// C++ comment', 'cpp')).toBe(true)
    })

    it('returns true for Python multiline docstrings', () => {
        expect(isLineComment('"""Python\nmultiline\ndocstring"""', 'python')).toBe(true)
    })

    it('returns true for Ruby multiline comments', () => {
        expect(isLineComment('=begin\nRuby multiline\ncomment\n=end', 'ruby')).toBe(true)
    })

    // Java
    it('returns true for Java `//` comments', () => {
        expect(isLineComment('// Java comment', 'java')).toBe(true)
    })

    it('returns true for Java `/* */` comments', () => {
        expect(isLineComment('/* Java comment */', 'java')).toBe(true)
    })

    // C#
    it('returns true for C# `//` comments', () => {
        expect(isLineComment('// C# comment', 'csharp')).toBe(true)
    })

    it('returns true for C# `/* */` comments', () => {
        expect(isLineComment('/* C# comment */', 'csharp')).toBe(true)
    })

    // PHP
    it('returns true for PHP `//` comments', () => {
        expect(isLineComment('// PHP comment', 'php')).toBe(true)
    })

    it('returns true for PHP `/* */` comments', () => {
        expect(isLineComment('/* PHP comment */', 'php')).toBe(true)
    })

    // HTML
    it('returns true for HTML <!-- --> comments', () => {
        expect(isLineComment('<!-- HTML comment -->', 'html')).toBe(true)
    })

    it('returns true for HTML <!DOCTYPE> comments', () => {
        expect(isLineComment('<!DOCTYPE html>', 'html')).toBe(true)
    })

    it('returns true for conditional HTML comments', () => {
        expect(isLineComment('<!--[if IE 9]>IE9-specific content<![endif]-->', 'html')).toBe(true)
    })

    // Go
    it('returns true for Go // single line comments', () => {
        expect(isLineComment('// Go single line comment', 'go')).toBe(true)
    })

    it('returns true for Go /* */ block comments', () => {
        expect(isLineComment('/* Go block comment */', 'go')).toBe(true)
    })

    it('returns true for Go multiline /* */ comments', () => {
        expect(isLineComment('/* Go\nmultiline\nblock comment */', 'go')).toBe(true)
    })
})
