import { describe, it } from 'vitest'

import { initTreeSitterParser } from '../../test-helpers'
import { SupportedLanguage } from '../grammars'
import { getDocumentQuerySDK } from '../query-sdk'

import { annotateAndMatchSnapshot } from './annotate-and-match-snapshot'

describe('getFirstMultilineBlockForTruncation', () => {
    it('typescript', async () => {
        await initTreeSitterParser(SupportedLanguage.TypeScript)
        const { language, parser, queries } = getDocumentQuerySDK(SupportedLanguage.TypeScript)!

        await annotateAndMatchSnapshot({
            parser,
            language,
            captures: queries.getFirstMultilineBlockForTruncation,
            sourcesPath: 'test-data/blocks.ts',
        })
    })

    it('go', async () => {
        await initTreeSitterParser(SupportedLanguage.Go)
        const { language, parser, queries } = getDocumentQuerySDK(SupportedLanguage.Go)!

        await annotateAndMatchSnapshot({
            parser,
            language,
            captures: queries.getFirstMultilineBlockForTruncation,
            sourcesPath: 'test-data/blocks.go',
        })
    })

    it('python', async () => {
        await initTreeSitterParser(SupportedLanguage.Python)
        const { language, parser, queries } = getDocumentQuerySDK(SupportedLanguage.Python)!

        await annotateAndMatchSnapshot({
            parser,
            language,
            captures: queries.getFirstMultilineBlockForTruncation,
            sourcesPath: 'test-data/blocks.py',
        })
    })
})
