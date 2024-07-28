import type { Meta, StoryObj } from '@storybook/react'
import { Chat } from './Chat'
import { FIXTURE_TRANSCRIPT, FIXTURE_USER_ACCOUNT_INFO } from './chat/fixtures'
import { VSCodeWebview } from './storybook/VSCodeStoryDecorator'

const meta: Meta<typeof Chat> = {
    title: 'cody/Chat',
    component: Chat,

    argTypes: {
        transcript: {
            name: 'Transcript fixture',
            options: Object.keys(FIXTURE_TRANSCRIPT),
            mapping: FIXTURE_TRANSCRIPT,
            control: { type: 'select' },
        },
    },
    args: {
        chatID: 'test',
        transcript: FIXTURE_TRANSCRIPT.simple2,
        messageInProgress: null,
        chatEnabled: true,
        userInfo: FIXTURE_USER_ACCOUNT_INFO,
        vscodeAPI: {
            postMessage: () => {},
            onMessage: () => () => {},
        },
        isTranscriptError: false,
    } satisfies React.ComponentProps<typeof Chat>,

    decorators: [VSCodeWebview],
}

export default meta

export const Default: StoryObj<typeof meta> = {}

export const Disabled: StoryObj<typeof meta> = { args: { chatEnabled: false } }
