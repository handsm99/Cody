import { describe, it } from 'vitest'

import { initTreeSitterSDK } from '../test-helpers'

import { SupportedLanguage } from '../grammars'
import { annotateAndMatchSnapshot } from './annotate-and-match-snapshot'

describe('getEnclosingFunction', () => {
    it('typescript', async () => {
        const { language, parser, queries } = await initTreeSitterSDK(SupportedLanguage.typescript)

        await annotateAndMatchSnapshot({
            parser,
            language,
            captures: queries.getEnclosingFunction,
            sourcesPath: 'test-data/enclosing-function.ts',
        })
    })

    it.skip('typescriptreact', async () => {
        const { language, parser, queries } = await initTreeSitterSDK(SupportedLanguage.typescriptreact)

        await annotateAndMatchSnapshot({
            parser,
            language,
            captures: queries.getEnclosingFunction,
            sourcesPath: 'test-data/enclosing-function.ts',
        })
    })

    it.skip('python', async () => {
        const { language, parser, queries } = await initTreeSitterSDK(SupportedLanguage.python)

        await annotateAndMatchSnapshot({
            parser,
            language,
            captures: queries.getEnclosingFunction,
            sourcesPath: 'test-data/enclosing-function.ts',
        })
    })

    it.skip('go', async () => {
        const { language, parser, queries } = await initTreeSitterSDK(SupportedLanguage.go)

        await annotateAndMatchSnapshot({
            parser,
            language,
            captures: queries.getEnclosingFunction,
            sourcesPath: 'test-data/enclosing-function.ts',
        })
    })
})
