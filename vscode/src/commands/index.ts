import { isMacOS } from '@sourcegraph/cody-shared'
import type { CodyCommandArgs } from './types'

const osIcon = isMacOS() ? '⌥' : 'Alt+'

export const CodyCommandMenuItems = [
    {
        key: 'ask',
        description: 'New Chat',
        prompt: 'Start a new chat',
        icon: 'comment',
        command: {
            command: 'cody.chat.panel.new',
            args: [{ source: 'sidebar' } satisfies Partial<CodyCommandArgs>],
        },
        keybinding: `${osIcon}L`,
        mode: 'ask',
        type: 'default',
    },
    {
        key: 'edit',
        description: 'Edit Code',
        prompt: 'Start a code edit',
        icon: 'wand',
        command: {
            command: 'cody.command.edit-code',
            args: [{ source: 'sidebar' } satisfies Partial<CodyCommandArgs>],
        },
        keybinding: `${osIcon}K`,
        mode: 'edit',
        type: 'default',
    },
    {
        key: 'doc',
        description: 'Document Code',
        icon: 'book',
        command: {
            command: 'cody.command.document-code',
            args: [{ source: 'sidebar' } satisfies Partial<CodyCommandArgs>],
        },
        keybinding: '',
        mode: 'edit',
        type: 'default',
    },
    {
        key: 'explain',
        description: 'Explain Code',
        icon: 'file-binary',
        command: {
            command: 'cody.command.explain-code',
            args: [{ source: 'sidebar' } satisfies Partial<CodyCommandArgs>],
        },
        keybinding: '',
        mode: 'ask',
        type: 'default',
    },
    {
        key: 'test',
        description: 'Generate Unit Tests',
        icon: 'package',
        command: {
            command: 'cody.command.unit-tests',
            args: [{ source: 'sidebar' } satisfies Partial<CodyCommandArgs>],
        },
        keybinding: '',
        mode: 'edit',
        type: 'default',
    },
    {
        key: 'smell',
        description: 'Find Code Smells',
        icon: 'checklist',
        command: {
            command: 'cody.command.smell-code',
            args: [{ source: 'sidebar' } satisfies Partial<CodyCommandArgs>],
        },
        keybinding: '',
        mode: 'ask',
        type: 'default',
    },
    {
        key: 'custom',
        description: 'Custom Commands',
        icon: 'tools',
        command: {
            command: 'cody.menu.custom-commands',
            args: [{ source: 'sidebar' } satisfies Partial<CodyCommandArgs>],
        },
        keybinding: `${osIcon}⇧C`,
        type: 'default',
    },
]
