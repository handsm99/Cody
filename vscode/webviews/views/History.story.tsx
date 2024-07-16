import type { Meta, StoryObj } from '@storybook/react'
import { VSCodeStandaloneComponent } from '../storybook/VSCodeStoryDecorator'
import { HistoryView } from './History'

const meta: Meta<typeof HistoryView> = {
    title: 'cody/HistoryView',
    component: HistoryView,
    decorators: [VSCodeStandaloneComponent],
    render: args => (
        <div style={{ position: 'relative', padding: '1rem' }}>
            <HistoryView {...args} />
        </div>
    ),
}

export default meta

type Story = StoryObj<typeof HistoryView>

export const Empty: Story = {
    args: {
        userHistory: [],
    },
}

export const SingleDay: Story = {
    args: {
        userHistory: [
            {
                id: '1',
                interactions: [
                    {
                        humanMessage: { speaker: 'human', text: 'How do I use React hooks?' },
                        assistantMessage: { speaker: 'assistant', text: 'Hello' },
                    },
                ],
                lastInteractionTimestamp: new Date().toISOString(),
            },
        ],
    },
}

export const MultiDay: Story = {
    args: {
        userHistory: [
            {
                id: '1',
                interactions: [
                    {
                        humanMessage: { speaker: 'human', text: 'How do I use React hooks?' },
                        assistantMessage: { speaker: 'assistant', text: 'Hello' },
                    },
                ],
                lastInteractionTimestamp: new Date(Date.now() - 86400000).toISOString(), // Yesterday
            },
            {
                id: '2',
                interactions: [
                    {
                        humanMessage: { speaker: 'human', text: 'Explain TypeScript interfaces' },
                        assistantMessage: { speaker: 'assistant', text: 'Hello' },
                    },
                ],
                lastInteractionTimestamp: new Date().toISOString(),
            },
        ],
    },
}
