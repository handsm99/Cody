import {
    type ContextItem,
    type Message,
    ProgrammingLanguage,
    languageFromFilename,
    populateCodeContextTemplate,
    populateContextTemplateFromText,
    populateCurrentSelectedCodeContextTemplate,
    populateMarkdownContextTemplate,
} from '@sourcegraph/cody-shared'
import { URI } from 'vscode-uri'

export function contextItemId(contextItem: ContextItem): string {
    return contextItem.range
        ? `${contextItem.uri.toString()}#${contextItem.range.start.line}:${contextItem.range.end.line}`
        : contextItem.uri.toString()
}

export function renderContextItem(contextItem: ContextItem): Message[] {
    // Do not create context item for empty file
    if (!contextItem.content?.trim()?.length) {
        return []
    }
    let messageText: string
    const uri = contextItem.source === 'unified' ? URI.parse(contextItem.title || '') : contextItem.uri
    if (contextItem.source === 'selection') {
        messageText = populateCurrentSelectedCodeContextTemplate(contextItem.content, uri)
    } else if (contextItem.source === 'editor') {
        // This template text works best with prompts in our commands
        // Using populateCodeContextTemplate here will cause confusion to Cody
        const templateText = 'Codebase context from file path {fileName}: '
        messageText = populateContextTemplateFromText(templateText, contextItem.content, uri)
    } else if (contextItem.source === 'terminal') {
        messageText = contextItem.content
    } else if (languageFromFilename(uri) === ProgrammingLanguage.Markdown) {
        messageText = populateMarkdownContextTemplate(contextItem.content, uri, contextItem.repoName)
    } else {
        messageText = populateCodeContextTemplate(contextItem.content, uri, contextItem.repoName)
    }
    return [
        { speaker: 'human', text: messageText },
        { speaker: 'assistant', text: 'Ok.' },
    ]
}
