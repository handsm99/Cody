import { describe, expect, it } from 'vitest'

import { PromptBuilder } from './index'
import type { MessageWithContext } from '../chat/chat-view/SimpleChatModel'

describe('PromptBuilder', () => {
    describe('tryAddMessages', () => {
        it('adds valid transcript in reverse order', () => {
            const builder = new PromptBuilder(1000)
            const transcript: MessageWithContext[] = [
                { message: { speaker: 'human', text: 'Hi assistant!' } },
                { message: { speaker: 'assistant', text: 'Hello there!' } },
                { message: { speaker: 'human', text: 'Hi again!' } },
                { message: { speaker: 'assistant', text: 'Hello there again!' } },
            ]
            builder.tryAddMessages(transcript.reverse())
            const messages = builder.build()
            expect(messages.length).toBe(4)
            expect(messages[0].speaker).toBe('human')
            expect(messages[0].speaker === messages[2].speaker).toBeTruthy()
            expect(messages[1].speaker).toBe('assistant')
            expect(messages[1].speaker === messages[3].speaker).toBeTruthy()
        })

        it('throws on consecutive speakers order', () => {
            const builder = new PromptBuilder(1000)
            const invalidTranscript: MessageWithContext[] = [
                { message: { speaker: 'human', text: 'Hi there!' } },
                { message: { speaker: 'human', text: 'How are you?' } },
            ]
            expect(() => {
                builder.tryAddMessages(invalidTranscript)
            }).toThrowError()
        })

        it('stops adding message-pairs when limit has been reached', () => {
            const builder = new PromptBuilder(30)
            const longTranscript: MessageWithContext[] = [
                { message: { speaker: 'human', text: 'Hi assistant!' } },
                { message: { speaker: 'assistant', text: 'Hello there!' } },
                { message: { speaker: 'human', text: 'Hi again!' } },
                {
                    message: {
                        speaker: 'assistant',
                        text: 'This is a very long message that should exceed the character limit',
                    },
                },
                // Only this message should be added
                { message: { speaker: 'human', text: 'This should be added.' } },
            ]
            const numberOfMessagesIgnored = builder.tryAddMessages(longTranscript.reverse())
            expect(numberOfMessagesIgnored).toBe(4)
            const messages = builder.build()
            expect(messages.length).toBe(1)
        })
    })
})
