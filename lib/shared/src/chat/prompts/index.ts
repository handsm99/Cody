import { Preamble } from '../preamble'

import * as defaultPrompts from './default-prompts.json'

export function getDefaultCommandsMap(): Map<string, CodyPrompt> {
    const map = new Map<string, CodyPrompt>()
    const prompts = defaultPrompts.commands as Record<string, unknown>
    for (const key in prompts) {
        if (Object.prototype.hasOwnProperty.call(prompts, key)) {
            const prompt = prompts[key] as CodyPrompt
            prompt.name = key
            prompt.type = 'default'
            if (prompt.slashCommand) {
                const slashCommand = '/' + prompt.slashCommand
                prompt.slashCommand = slashCommand
            }
            map.set(key, prompt)
        }
    }
    return map
}

export interface MyPrompts {
    // A set of reusable commands where instructions (prompts) and context can be configured.
    commands: Map<string, CodyPrompt>
    // backward compatibility
    recipes?: Map<string, CodyPrompt>
    // Premade is a set of prompts that are added to the start of every new conversation
    // --this is where we define the "identity" and "rules" for Cody
    premade?: Preamble
    // A conversation starter --this is added to the start of every human input sent to Cody.
    starter: string
}

// JSON format of MyPrompts
export interface MyPromptsJSON {
    commands: { [id: string]: CodyPrompt }
    recipes?: { [id: string]: CodyPrompt }
    premade?: CodyPremade
    starter?: string
}

export interface CodyPremade {
    actions: string
    rules: string
    answer: string
}

export interface CodyPrompt {
    name?: string
    prompt: string
    context?: CodyPromptContext
    type?: CodyPromptType
    slashCommand?: string
}

// Type of context available for prompt building
export interface CodyPromptContext {
    codebase: boolean
    openTabs?: boolean
    currentDir?: boolean
    currentFile?: boolean
    selection?: boolean
    command?: string
    output?: string
    filePath?: string
    directoryPath?: string
    none?: boolean
}

export type CodyPromptType = 'workspace' | 'user' | 'default' | 'recently used'

export const ConfigFileName = {
    vscode: '.vscode/cody.json',
}

// Default to not include codebase context
export const defaultCodyPromptContext: CodyPromptContext = {
    codebase: false,
}
