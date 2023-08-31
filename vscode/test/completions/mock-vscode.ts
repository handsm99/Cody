import mock from 'mock-require'

mock('vscode', {})

// We need to mock `vscode` first, so we use require here.
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const { vsCodeMocks } = require('../../src/testutils/mocks') as typeof import('../../src/testutils/mocks')

const vscodeMock = {
    ...vsCodeMocks,
    InlineCompletionTriggerKind: {
        Invoke: 0,
        Automatic: 1,
    },
    workspace: {
        asRelativePath(path: string) {
            return path
        },
        getConfiguration() {
            return {
                get(key: string) {
                    switch (key) {
                        case 'cody.debug.filter':
                            return '.*'
                        case 'cody.autocomplete.enabled':
                            return true
                        case 'cody.serverEndpoint':
                            return 'https://sourcegraph.com/'
                        // case 'cody.autocomplete.advanced.provider':
                        //     return 'unstable-fireworks'
                        // case 'cody.autocomplete.advanced.model':
                        //     return 'llama-code-13b'
                        default:
                            return undefined
                    }
                },
            }
        },
        onDidChangeTextDocument() {
            return null
        },
    },
    window: {
        ...vsCodeMocks.window,
        visibleTextEditors: [],
        tabGroups: { all: [] },
    },
} as const

// This will replace any require('vscode') with our mock
mock('vscode', vscodeMock)
