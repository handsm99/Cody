import { AbortError, TimeoutError } from '@sourcegraph/cody-shared/src/sourcegraph-api/errors'

type PromiseCreator<T> = () => Promise<T>
interface Queued<T> {
    creator: PromiseCreator<T>
    abortSignal?: AbortSignal
    resolve: (value: T) => void
    reject: (reason: Error) => void
}

export type Limiter = <T>(creator: PromiseCreator<T>, abortSignal?: AbortSignal) => Promise<T>

export function createLimiter(limit: number, timeout: number): Limiter {
    const queue: Queued<any>[] = []
    let inflightPromises = 0

    function processNext(): void {
        if (inflightPromises >= limit) {
            return
        }

        if (queue.length === 0) {
            return
        }

        const next = queue.shift()!
        inflightPromises += 1

        let didTimeout = false

        const timeoutId = setTimeout(() => {
            didTimeout = true
            next.reject(new TimeoutError())
            inflightPromises -= 1
            processNext()
        }, timeout)

        const runner = next.creator()
        runner
            .then(value => {
                if (didTimeout) {
                    return
                }
                next.resolve(value)
            })
            .catch(error => {
                if (didTimeout) {
                    return
                }
                next.reject(error)
            })
            .finally(() => {
                if (didTimeout) {
                    return
                }
                clearTimeout(timeoutId)
                inflightPromises -= 1
                processNext()
            })
    }

    return function enqueue<T>(creator: () => Promise<T>, abortSignal?: AbortSignal): Promise<T> {
        let queued: Queued<T>
        const promise = new Promise<T>((resolve, reject) => {
            queued = {
                creator,
                abortSignal,
                resolve,
                reject,
            }
        })
        queue.push(queued!)
        abortSignal?.addEventListener('abort', () => {
            // Only abort queued requests
            const index = queue.indexOf(queued!)
            if (index < 0) {
                return
            }

            queued.reject(new AbortError())
            queue.splice(index, 1)
        })

        processNext()

        return promise
    }
}
