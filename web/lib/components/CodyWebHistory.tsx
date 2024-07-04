import { type FC, type ReactElement, useEffect, useState } from 'react'

import { isErrorLike } from '@sourcegraph/cody-shared'
import type { ChatExportResult } from 'cody-ai/src/jsonrpc/agent-protocol'

import { useWebAgentClient } from './CodyWebChatProvider'

export type { ChatExportResult }

interface ChildInput {
    chats: ChatExportResult[]
    loading: boolean
    error: Error | null
    selectChat: (chat: ChatExportResult) => unknown
    createNewChat: (force?: boolean) => void
    deleteChat: (chat: ChatExportResult) => void
    isSelectedChat: (chat: ChatExportResult) => boolean
}

interface CodyWebHistoryProps {
    children: (input: ChildInput) => ReactElement
}

export const CodyWebHistory: FC<CodyWebHistoryProps> = props => {
    const { children } = props

    const { client, vscodeAPI, activeChatID, createChat, selectChat } = useWebAgentClient()

    const [chats, setChats] = useState<ChatExportResult[]>([])

    useEffect(() => {
        if (!client || isErrorLike(client)) {
            return
        }

        // Populate local chat state as we render chat history component for the
        // first time. It's possible that we missed chatHistory messages while
        // this component hadn't been rendered.
        client.rpc.sendRequest<ChatExportResult[]>('chat/export', { fullHistory: true }).then(setChats)
    }, [client])

    // Subscribe on any chat history updates from the agent server
    // to track the most recent list of chats
    useEffect(() => {
        vscodeAPI.onMessage(message => {
            switch (message.type) {
                case 'history': {
                    if (!message.localHistory) {
                        return
                    }

                    const receivedChats: ChatExportResult[] = []

                    for (const [chatID, transcript] of Object.entries(message.localHistory.chat)) {
                        receivedChats.push({ chatID, transcript })
                    }

                    setChats(receivedChats)
                    return
                }
            }
        })
    }, [vscodeAPI])

    const deleteChat = async (chat: ChatExportResult): Promise<void> => {
        if (!client || isErrorLike(client)) {
            return
        }

        const nextChatIndexToSelect = Math.max(
            chats.findIndex(currentChat => currentChat.chatID === chat.chatID) - 1,
            0
        )

        // Delete chat from the agent's store
        const newChatsList = await client.rpc.sendRequest<ChatExportResult[]>('chat/delete', {
            chatId: chat.chatID,
        })

        // this means that we deleted not selected chat, so we can skip checks
        // about zero chat list case and selected chat was deleted case
        if (chat.chatID !== activeChatID) {
            return
        }

        // We've deleted the only chat, so we have to create a new empty chat
        if (newChatsList.length === 0) {
            await createNewChat(true)
            return
        }

        await selectChat(newChatsList[nextChatIndexToSelect] ?? newChatsList[0])
    }

    const createNewChat = async (force?: boolean): Promise<void> => {
        if (!client || isErrorLike(client)) {
            return
        }

        const currentChat = chats.find(chat => chat.chatID === activeChatID)
        const emptyChat = chats.find(chat => chat.transcript.interactions.length === 0)

        // Don't create another empty chat if we already have one selected
        if (!force && currentChat && currentChat.transcript.interactions.length === 0) {
            return
        }

        if (!force && emptyChat) {
            await selectChat(emptyChat)
            return
        }

        await createChat()
        vscodeAPI.postMessage({ command: 'initialized' })
    }

    return children({
        chats,
        loading: client === null,
        error: isErrorLike(client) ? client : null,
        selectChat,
        createNewChat,
        deleteChat,
        isSelectedChat: chat => chat.chatID === activeChatID,
    })
}

export function getChatTitle(chat: ChatExportResult): string {
    if (chat.transcript.chatTitle) {
        return chat.transcript.chatTitle
    }

    if (chat.transcript.interactions.length > 0) {
        const firstQuestion = chat.transcript.interactions.find(
            interaction => interaction.humanMessage.text
        )

        return firstQuestion?.humanMessage.text ?? ''
    }

    return chat.transcript.id
}
