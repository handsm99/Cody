import { Meta, StoryObj } from '@storybook/react'

import { ChatContextStatus } from '@sourcegraph/cody-shared'

import { ChatInputContextSimplified } from './ChatInputContextSimplified'
import { VSCodeStoryDecorator } from './storybook/VSCodeStoryDecorator'

import styles from './storybook/VSCodeStoryDecorator.module.css'

const meta: Meta<typeof ChatInputContextSimplified> = {
    title: 'cody/App-less Onboarding',
    component: ChatInputContextSimplified,
    decorators: [VSCodeStoryDecorator],
}

export default meta

const onboardingCallbacks = {
    openApp: () => alert('open app'),
    installApp: () => alert('install app'),
    reloadStatus: () => alert('reload'),
}

export const ChatInputContextAppNotInstalled: StoryObj<typeof ChatInputContextSimplified> = {
    render: () => {
        const contextStatus: ChatContextStatus = {
            connection: false,
            codebase: 'github.com/sourcegraph/example',
        }
        return (
            <div className={styles.testDarkSidebarBottom}>
                <ChatInputContextSimplified
                    isAppInstalled={false}
                    contextStatus={contextStatus}
                    onboardingPopupProps={onboardingCallbacks}
                />
            </div>
        )
    },
}

export const ChatInputContextAppInstalled: StoryObj<typeof ChatInputContextSimplified> = {
    render: () => {
        const contextStatus: ChatContextStatus = {
            codebase: 'github.com/sourcegraph/example',
            filePath: 'foo/bar.js',
        }
        return (
            <div className={styles.testDarkSidebarBottom}>
                <ChatInputContextSimplified
                    isAppInstalled={true}
                    contextStatus={contextStatus}
                    onboardingPopupProps={onboardingCallbacks}
                />
            </div>
        )
    },
}

export const ChatInputContextHasEmbeddings: StoryObj<typeof ChatInputContextSimplified> = {
    render: () => {
        const contextStatus: ChatContextStatus = {
            codebase: 'github.com/sourcegraph/example',
            filePath: 'foo/bar.js',
            mode: 'embeddings',
            connection: true,
        }
        return (
            <div className={styles.testDarkSidebarBottom}>
                <ChatInputContextSimplified
                    isAppInstalled={true}
                    contextStatus={contextStatus}
                    onboardingPopupProps={onboardingCallbacks}
                />
            </div>
        )
    },
}
