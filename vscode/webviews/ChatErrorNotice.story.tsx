import { Meta, StoryObj } from '@storybook/react'
import { VSCodeButton } from '@vscode/webview-ui-toolkit/react'
import classNames from 'classnames'

import { RateLimitError } from '@sourcegraph/cody-shared/src/sourcegraph-api/errors'
import { ChatButtonProps } from '@sourcegraph/cody-ui/src/Chat'
import { ErrorItem } from '@sourcegraph/cody-ui/src/chat/ErrorItem'

import { VSCodeStoryDecorator } from './storybook/VSCodeStoryDecorator'

import transcriptItemStyles from '../../lib/ui/src/chat/TranscriptItem.module.css'
import chatStyles from './Chat.module.css'

const meta: Meta<typeof ErrorItem> = {
    title: 'cody/Chat Error Item',
    component: ErrorItem,
    decorators: [VSCodeStoryDecorator],
    parameters: {
        backgrounds: {
            default: 'vscode',
            values: [
                {
                    name: 'vscode',
                    value: 'var(--vscode-sideBar-background)',
                },
            ],
        },
    },
    render: args => (
        <div
            className={classNames(
                transcriptItemStyles.row,
                chatStyles.transcriptItem,
                transcriptItemStyles.assistantRow
            )}
            style={{ border: '1px solid var(--vscode-sideBarSectionHeader-border)' }}
        >
            <ErrorItem {...args} />
        </div>
    ),
}

export default meta

type Story = StoryObj<typeof ErrorItem>

const ChatButton: React.FunctionComponent<ChatButtonProps> = ({ label, action, onClick, appearance }) => (
    <VSCodeButton
        type="button"
        onClick={() => onClick(action)}
        className={chatStyles.chatButton}
        appearance={appearance}
    >
        {label}
    </VSCodeButton>
)

export const ChatRateLimitUpgrade: Story = {
    args: {
        error: new RateLimitError('chat messages', 'thing', true, 10, new Date()),
        postMessage: () => {},
        userInfo: {
            isDotComUser: true,
            isCodyProUser: false,
        },
        ChatButtonComponent: ChatButton,
    },
}
