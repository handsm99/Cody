import { afterEach, describe, expect, it } from 'vitest'

import { initTreeSitterParser } from '../test-helpers'

import { SupportedLanguage } from './grammars'
import { resetParsersCache } from './parser'
import { getDocumentQuerySDK } from './queries'

describe('getDocumentQuerySDK', () => {
    afterEach(() => {
        resetParsersCache()
    })

    it.each([
        { languageId: SupportedLanguage.JavaScript },
        { languageId: SupportedLanguage.TypeScript },
        { languageId: SupportedLanguage.JSX },
        { languageId: SupportedLanguage.TSX },
    ])('returns valid SDK for $languageId', async ({ languageId }) => {
        const nonInitializedSDK = getDocumentQuerySDK(languageId)
        expect(nonInitializedSDK).toBeNull()

        const parser = await initTreeSitterParser(languageId)
        expect(parser).toBeTruthy()

        const sdk = getDocumentQuerySDK(languageId)
        expect(sdk?.queries.blocks).toBeTruthy()
    })

    it.each([
        { languageId: SupportedLanguage.CSharp },
        { languageId: SupportedLanguage.Cpp },
        { languageId: SupportedLanguage.Dart },
        { languageId: SupportedLanguage.Go },
        { languageId: SupportedLanguage.Php },
        { languageId: SupportedLanguage.Python },
    ])('returns null for $languageId because queries are not defined', async ({ languageId }) => {
        const nonInitializedSDK = getDocumentQuerySDK(languageId)
        expect(nonInitializedSDK).toBeNull()

        const parser = await initTreeSitterParser(languageId)
        expect(parser).toBeTruthy()

        const sdk = getDocumentQuerySDK(languageId)
        expect(sdk).toBeNull()
    })
})
