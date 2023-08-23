import { Message } from '../sourcegraph-api'

// tracked for telemetry purposes. Which context source provided this context
// file.
//
// For now we just track "embeddings" since that is the main driver for
// understanding if it is being useful.
export type ContextFileSource = 'embeddings'

export interface ContextFile {
    fileName: string
    repoName?: string
    revision?: string

    source?: ContextFileSource
}

export interface PreciseContext {
    symbol: {
        scipName: string
        scipDescriptorSuffix: string
        fuzzyName?: string
    }
    definitionSnippet: string
    repositoryName: string
    filepath: string
    canonicalLocationURL: string
}

export interface ContextMessage extends Message {
    file?: ContextFile
    preciseContext?: PreciseContext
}

export interface OldContextMessage extends Message {
    fileName?: string
}

export function getContextMessageWithResponse(
    text: string,
    file: ContextFile,
    response: string = 'Ok.'
): ContextMessage[] {
    return [
        { speaker: 'human', text, file },
        { speaker: 'assistant', text: response },
    ]
}
