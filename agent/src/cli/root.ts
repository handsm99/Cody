import { Command } from 'commander'

import { chatCommand } from './chat'
import { codyBenchCommand } from './cody-bench/cody-bench'
import { jsonrpcCommand } from './jsonrpc'
import { serverCommand } from './server'

export const rootCommand = new Command()
    .name('cody-agent')
    .version('0.1.0')
    .description(
        'Cody Agent supports running the Cody VS Code extension in headless mode and interact with it via JSON-RPC. ' +
            'The Agent is used by editor clients like JetBrains and Neovim.'
    )
    .addCommand(serverCommand)
    .addCommand(jsonrpcCommand)
    .addCommand(codyBenchCommand)
    .addCommand(chatCommand())
