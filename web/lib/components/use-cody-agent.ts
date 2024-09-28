import { DOTCOM_URL, hydrateAfterPostMessage, isErrorLike } from '@sourcegraph/cody-shared'
import type { ExtensionMessage } from 'cody-ai/src/chat/protocol'
import type { ClientRequests } from 'cody-ai/src/jsonrpc/agent-protocol'
import { type VSCodeWrapper, setVSCodeWrapper } from 'cody-ai/webviews/utils/VSCodeApi'
import {
    type DependencyList,
    type EffectCallback,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react'
import type { MessageConnection } from 'vscode-jsonrpc/browser'
import { URI } from 'vscode-uri'
import { createAgentClient } from '../agent/agent.client'
import type { InitialContext } from '../types'

/**
 * List of events that bypass active panel ID check in the listeners.
 *
 * Usually the CodyWebPanelProvider VSCode API wrapper listens only to messages from
 * the Extension host which matches the current active panel id. But this message id
 * check can be corrupted by race conditions in different events that the extension
 * host sends during chat-switching. Some events should always be handled by the client
 * regardless of which active panel they came from.
 */
const GLOBAL_MESSAGE_TYPES: Array<ExtensionMessage['type']> = ['rpc/response']

interface AgentClient {
    rpc: MessageConnection
    dispose(): void
}

interface UseCodyWebAgentInput {
    serverEndpoint?: string
    accessToken?: string
    createAgentWorker: () => Worker
    telemetryClientName?: string
    initialContext?: InitialContext
    customHeaders?: Record<string, string>
}

interface UseCodyWebAgentResult {
    client: AgentClient | Error | null
    vscodeAPI: VSCodeWrapper | null
    panelId: string | null
}

/**
 * Creates Cody Web Agent instance and automatically creates a new chat.
 * Uses cody web-worker agent under the hood with json rpc as a connection between
 * main and web-worker threads, see agent.client.ts for more details
 */
export function useCodyWebAgent(input: UseCodyWebAgentInput): UseCodyWebAgentResult {
    const { telemetryClientName, customHeaders, createAgentWorker } = input

    const [panelId, setPanelId] = useState<string | null>(null)
    const [client, setClient] = useState<AgentClient | Error | null>(null)

    useEffectOnce(() => {
        createAgentClient({
            serverEndpoint: input.serverEndpoint ?? DOTCOM_URL.toString(),
            accessToken: input.accessToken,
            customHeaders,
            telemetryClientName,
            createAgentWorker,
            workspaceRootUri: '',
        })
            .then(setClient)
            .catch(error => {
                console.error('Cody Web Agent creation failed', error)
                setClient(() => error as Error)
            })
    }, [createAgentWorker, customHeaders, telemetryClientName])

    // Special override for chat creating for Cody Web, otherwise the create new chat doesn't work
    const createNewChat = useCallback(async (agent: AgentClient | Error | null) => {
        if (!agent || isErrorLike(agent)) {
            return
        }

        const { panelId, chatId } = await agent.rpc.sendRequest<{
            panelId: string
            chatId: string
        }>('chat/sidebar/new', null)

        setPanelId(panelId)

        await agent.rpc.sendRequest('webview/receiveMessage', {
            id: panelId,
            message: { chatID: chatId, command: 'restoreHistory' },
        })
    }, [])

    const isInitRef = useRef(false)
    const vscodeAPI = useVSCodeAPI({ panelId, createNewChat, client })

    // Create new chat when Cody Web is opened for the first time.
    useEffect(() => {
        // Skip panel creation if it already happened before
        // React in dev mode run all effect twice so it's important here to
        // run it only one first time to avoid panel ID mismatch in cody agent
        if (isInitRef.current || !client || isErrorLike(client)) {
            return
        }

        void createNewChat(client)
        isInitRef.current = true
    }, [client, createNewChat])

    return { client, vscodeAPI, panelId }
}

interface useVSCodeAPIInput {
    client: AgentClient | Error | null
    panelId: string | null
    createNewChat: (client: AgentClient | Error | null) => Promise<void>
}

function useVSCodeAPI(input: useVSCodeAPIInput): VSCodeWrapper | null {
    const { client, panelId, createNewChat } = input

    const onMessageCallbacksRef = useRef<((message: ExtensionMessage) => void)[]>([])

    return useMemo<VSCodeWrapper | null>(() => {
        if (!client || panelId === null) {
            return null
        }
        if (!isErrorLike(client)) {
            client.rpc.onNotification(
                'webview/postMessage',
                ({ id, message }: { id: string; message: ExtensionMessage }) => {
                    if (panelId === id || GLOBAL_MESSAGE_TYPES.includes(message.type)) {
                        for (const callback of onMessageCallbacksRef.current) {
                            callback(hydrateAfterPostMessage(message, uri => URI.from(uri as any)))
                        }
                    }
                }
            )
        }

        const vscodeAPI: VSCodeWrapper = {
            postMessage: message => {
                if (!isErrorLike(client)) {
                    // Special override for Cody Web
                    if (message.command === 'command' && message.id === 'cody.chat.new') {
                        void createNewChat(client)
                        return
                    }
                    if (!panelId) {
                        throw new Error('No active webview panel ID yet')
                    }
                    void client.rpc.sendRequest('webview/receiveMessage', {
                        id: panelId,
                        message,
                    } satisfies ClientRequests['webview/receiveMessage'][0])
                }
            },
            onMessage: callback => {
                if (!isErrorLike(client)) {
                    onMessageCallbacksRef.current.push(callback)
                    return () => {
                        // Remove callback from onMessageCallbacks
                        const index = onMessageCallbacksRef.current.indexOf(callback)
                        if (index >= 0) {
                            onMessageCallbacksRef.current.splice(index, 1)
                        }
                    }
                }
                return () => {}
            },
            getState: () => {
                throw new Error('not implemented')
            },
            setState: () => {
                throw new Error('not implemented')
            },
        }

        // Runtime sync side effect, ensure that later any cody UI
        // components will have access to the mocked/synthetic VSCode API
        setVSCodeWrapper(vscodeAPI)
        return vscodeAPI
    }, [client, createNewChat, panelId])
}

function useEffectOnce(effect: EffectCallback, deps?: DependencyList) {
    const isInitRef = useRef(false)

    // biome-ignore lint/correctness/useExhaustiveDependencies: effect will never be changed without deps change
    useEffect(() => {
        if (isInitRef.current) {
            return
        }

        const result = effect()

        isInitRef.current = true
        return result
    }, deps)
}
