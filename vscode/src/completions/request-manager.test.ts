import { beforeEach, describe, expect, it, vi } from 'vitest'

import { vsCodeMocks } from '../testutils/mocks'

import { Provider } from './providers/provider'
import { RequestManager, RequestManagerResult } from './request-manager'
import { Completion } from './types'

vi.mock('vscode', () => vsCodeMocks)

const LOG_ID = 'some-log-id'

class MockProvider extends Provider {
    public didFinishNetworkRequest = false
    protected resolve: (completion: Completion[]) => void = () => {}

    public resolveRequest(completions: string[]): void {
        this.didFinishNetworkRequest = true
        this.resolve(
            completions.map(content => ({
                prefix: this.options.prefix,
                content,
            }))
        )
    }

    public generateCompletions(): Promise<Completion[]> {
        return new Promise(resolve => {
            this.resolve = resolve
        })
    }
}

function createProvider(prefix: string) {
    return new MockProvider({
        id: LOG_ID,
        prefix,
        suffix: '',
        fileName: '',
        languageId: 'typescript',
        multiline: false,
        responsePercentage: 0,
        prefixPercentage: 0,
        suffixPercentage: 0,
        n: 1,
    })
}

describe('RequestManager', () => {
    let createRequest: (prefix: string, provider: Provider) => Promise<RequestManagerResult>
    beforeEach(() => {
        const requestManager = new RequestManager()

        createRequest = (prefix: string, provider: Provider) =>
            requestManager.request({ prefix }, [provider], [], new AbortController().signal)
    })

    it('resolves a single request', async () => {
        const prefix = 'console.log('
        const provider = createProvider(prefix)

        setTimeout(() => provider.resolveRequest(["'hello')"]), 0)

        await expect(createRequest(prefix, provider)).resolves.toMatchInlineSnapshot(`
          {
            "cacheHit": false,
            "completions": [
              {
                "content": "'hello')",
                "prefix": "console.log(",
              },
            ],
          }
        `)
    })

    it('keeps requests running when a new request comes in', async () => {
        const prefix1 = 'console.'
        const provider1 = createProvider(prefix1)
        const promise1 = createRequest(prefix1, provider1)

        const prefix2 = 'console.log('
        const provider2 = createProvider(prefix2)
        const promise2 = createRequest(prefix2, provider2)

        expect(provider1.didFinishNetworkRequest).toBe(false)
        expect(provider2.didFinishNetworkRequest).toBe(false)

        provider2.resolveRequest(["'hello')"])

        expect((await promise2).completions[0].content).toBe("'hello')")

        expect(provider1.didFinishNetworkRequest).toBe(false)
        expect(provider2.didFinishNetworkRequest).toBe(true)

        provider1.resolveRequest(['log();'])

        expect((await promise1).completions[0].content).toBe('log();')
        expect(provider1.didFinishNetworkRequest).toBe(true)
    })
})
