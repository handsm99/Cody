export interface Repository {
    id: string
    name: string
}

export type InitialContext = {
    repositories: Repository[]
    fileURL?: string
    fileRange?: { startLine: number; endLine: number }
}
