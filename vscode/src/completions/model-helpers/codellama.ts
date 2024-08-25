import type * as vscode from 'vscode'

import { PromptString, ps } from '@sourcegraph/cody-shared'
import { DefaultModel, type FormatFireworksPromptParams, type GetOllamaPromptParams } from './default'

export class CodeLlama extends DefaultModel {
    getOllamaPrompt(promptContext: GetOllamaPromptParams): PromptString {
        const { context, currentFileNameComment, prefix, suffix, isInfill } = promptContext

        if (isInfill) {
            const infillPrefix = context.concat(currentFileNameComment, prefix)
            return ps`<PRE> ${infillPrefix} <SUF>${suffix} <MID>`
        }

        return context.concat(currentFileNameComment, prefix)
    }

    postProcess(content: string): string {
        return content.replace(' <EOT>', '')
    }

    getDefaultIntroSnippets(document: vscode.TextDocument): PromptString[] {
        return [ps`Path: ${PromptString.fromDisplayPath(document.uri)}`]
    }

    formatFireworksPrompt(params: FormatFireworksPromptParams): PromptString {
        const { intro, prefix, suffix } = params

        // c.f. https://github.com/facebookresearch/codellama/blob/main/llama/generation.py#L402
        return ps`<PRE> ${intro}${prefix} <SUF>${suffix} <MID>`
    }
}