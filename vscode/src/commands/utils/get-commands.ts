import * as uuid from 'uuid'

import type { CodyCommand } from '@sourcegraph/cody-shared'

import { defaultCommands } from '../default/.'
import type { CodyCommandArgs } from '../types'
import type { CodyCommandType } from '@sourcegraph/cody-shared/src/commands/types'
import { toSlashCommand } from './common'

export function getDefaultCommandsMap(editorCommands: CodyCommand[] = []): Map<string, CodyCommand> {
    const map = new Map<string, CodyCommand>()

    // Add editor specific commands
    for (const command of editorCommands) {
        if (command.slashCommand) {
            map.set(command.slashCommand, command)
        }
    }

    // Add default commands
    const fileContent = JSON.stringify(defaultCommands)
    const mapFromJson = buildCodyCommandMap('default', fileContent)

    // combine the two maps
    return new Map([...map, ...mapFromJson])
}

/**
 * Builds a map of CodyCommands with content from a JSON file.
 * @param type The type of commands being built.
 * @param fileContent The contents of the cody.json file.
 */
export function buildCodyCommandMap(
    type: CodyCommandType,
    fileContent: string
): Map<string, CodyCommand> {
    const map = new Map<string, CodyCommand>()
    const parsed = JSON.parse(fileContent) as Record<string, any>
    // Check if parsed has a "commands" key and use that as the root
    // If it doesn't, use the root as the root
    const commands = parsed.commands ?? parsed
    for (const key in commands) {
        const command = commands[key] as CodyCommand
        command.type = type
        command.slashCommand = toSlashCommand(key)
        // Set default mode to ask unless it's an edit command
        command.mode = command.mode ?? (command.prompt.startsWith('/edit ') ? 'edit' : 'ask')
        map.set(command.slashCommand, command as CodyCommand)
    }

    return map
}

/**
 * Creates a CodyCommandArgs object with default values.
 * Generates a random requestID if one is not provided.
 * Merges any provided args with the defaults.
 */
export function newCodyCommandArgs(args: Partial<CodyCommandArgs> = {}): CodyCommandArgs {
    return {
        requestID: args.requestID ?? uuid.v4(),
        ...args,
    }
}
