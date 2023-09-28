import { readFileSync } from 'fs'

export interface DatasetConfig {
    entryFile: string
    openFiles: string[]
    additionalFiles: string[]
    solutionFile: string
    testFile: string
    // TODO: Make testcommand an array of strings, so we can pass args
    testCommand: string
}

export function parseEvaluationConfig(path: string): DatasetConfig {
    try {
        const file = readFileSync(path, 'utf8')
        const config = JSON.parse(file) as DatasetConfig
        return config
    } catch (error) {
        console.error(`Error parsing dataset config file ${path}: ${error}`)
        throw error
    }
}
