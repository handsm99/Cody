import { pluralize } from '../common'
import { isError } from '../utils'

export interface Attribution {
    limitHit: boolean
    repositories: RepositoryAttribution[]
    totalCount: number
}

export interface RepositoryAttribution {
    name: string
}

export interface Guardrails {
    searchAttribution(snippet: string): Promise<Attribution | Error>
}

// GuardrailsPost implements Guardrails interface by synchronizing on message
// passing between webview and extension process.
export class GuardrailsPost implements Guardrails {
    private currentRequests: Map<string, DeferredAttributionSearch> = new Map()
    private postSnippet: (txt: string) => void

    constructor(postSnippet: (txt: string) => void) {
        this.postSnippet = postSnippet
    }

    public searchAttribution(snippet: string): Promise<Attribution> {
        let request = this.currentRequests.get(snippet)
        if (request === undefined) {
            request = new DeferredAttributionSearch()
            this.currentRequests.set(snippet, request)
            this.postSnippet(snippet)
        }
        return request.promise
    }

    public notifyAttributionSuccess(snippet: string, result: Attribution): void {
        const request = this.currentRequests.get(snippet)
        if (request !== undefined) {
            request.resolve(result)
        }
        // TODO: What in case there the message is not for an ongoing request?
    }

    public notifyAttributionFailure(snippet: string, error: Error): void {
        const request = this.currentRequests.get(snippet)
        if (request !== undefined) {
            request.reject(error)
        }
    }
}

class DeferredAttributionSearch {
    public promise: Promise<Attribution>
    public resolve!: (result: Attribution) => void
    public reject!: (cause: any) => void

    constructor() {
        this.promise = new Promise<Attribution>((resolve, reject) => {
            this.resolve = resolve
            this.reject = reject
        })
    }
}

export function summariseAttribution(attribution: Attribution | Error): string {
    if (isError(attribution)) {
        return `guardrails attribution search failed: ${attribution.message}`
    }

    const repos = attribution.repositories
    const count = repos.length
    if (count === 0) {
        return 'no matching repositories found'
    }

    const summary = repos.slice(0, count < 5 ? count : 5).map(repo => repo.name)
    if (count > 5) {
        summary.push('...')
    }

    return `found ${count}${attribution.limitHit ? '+' : ''} matching ${pluralize(
        'repository',
        count,
        'repositories'
    )} ${summary.join(', ')}`
}
