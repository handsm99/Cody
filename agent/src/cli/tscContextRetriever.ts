import fspromises from 'node:fs/promises'
import path from 'node:path'
import { Command } from 'commander'
import * as commander from 'commander'
import * as vscode from 'vscode'
import type { RpcMessageHandler } from '../../../vscode/src/jsonrpc/jsonrpc'
import { newAgentClient } from '../agent'
import { booleanOption, intOption } from './cody-bench/cli-parsers'

interface FileOption {
    filePath: string
    line: number
    column: number
}

interface WorkspaceOption {
    workspaceUri: string
    filesOptions: FileOption[]
}

interface TscContextRetrieverOptions {
    srcAccessToken: string
    srcEndpoint: string
    configPath: string
    maxPrefixLength: number
    maxSuffixLength: number
    saveDir: string
    skipPreComputedWorkspace: boolean
}

export const tscContextRetrieverCommand = () =>
    new Command('tsc-context-retriever')
        .addOption(
            new commander.Option(
                '--src-access-token <token>',
                'The Sourcegraph access token to use for authentication'
            ).env('SRC_ACCESS_TOKEN')
        )
        .addOption(
            new commander.Option(
                '--src-endpoint <url>',
                'The Sourcegraph URL endpoint to use for authentication'
            ).env('SRC_ENDPOINT')
        )
        .option('--config-path <path>', 'Path to a JSON with configuration to compute TSC context')
        .option('--max-prefix-length <number>', 'Maximum length of the prefix', intOption, 1_000)
        .option('--max-suffix-length <number>', 'Maximum length of the suffix', intOption, 1_000)
        .option('--save-dir <path>', 'Path to a directory to save the context outputs')
        .option(
            '--skip-pre-computed-workspace <bool>',
            'Skip extracting the context for a workspace if already exist',
            booleanOption,
            true
        )
        .action(async (option: TscContextRetrieverOptions) => {
            const configBuffer = await fspromises.readFile(option.configPath)
            const workspaceToRun = JSON.parse(configBuffer.toString()) as WorkspaceOption[]
            await Promise.all(
                workspaceToRun.map(workspaceOption =>
                    tscContextActionForWorkspace(option, workspaceOption)
                )
            )
            process.exit(0)
        })

async function tscContextActionForWorkspace(
    option: TscContextRetrieverOptions,
    workspaceOption: WorkspaceOption
) {
    const workspaceRootUri = vscode.Uri.from({ scheme: 'file', path: workspaceOption.workspaceUri })
    const { client } = await newAgentClient({
        name: 'tsc-context-retriver',
        version: '0.1.0',
        workspaceRootUri: workspaceRootUri.toString(),
        extensionConfiguration: {
            accessToken: option.srcAccessToken,
            serverEndpoint: option.srcEndpoint,
            customHeaders: {},
            customConfiguration: {
                'cody.experimental.telemetry.enabled': false,
                'cody.telemetry.level': 'off',
            },
        },
        inheritStderr: true,
    })
    await Promise.all(
        workspaceOption.filesOptions.map(fileOption =>
            getTscContextForFile(client, option, fileOption, workspaceOption.workspaceUri)
        )
    )
}

async function getTscContextForFile(
    client: RpcMessageHandler,
    option: TscContextRetrieverOptions,
    fileOption: FileOption,
    workspaceUri: string
) {
    const workspaceName = path.basename(workspaceUri)
    const fileName = path.basename(fileOption.filePath)
    const fileNameParts = fileName.split('.')
    const fileNameWithoutSuffix =
        fileNameParts.length > 1 ? fileNameParts.slice(0, -1).join('.') : fileName
    const contextSavePath = path.join(option.saveDir, workspaceName, `${fileNameWithoutSuffix}.json`)

    if (
        option.skipPreComputedWorkspace &&
        (await fspromises
            .access(contextSavePath)
            .then(() => true)
            .catch(() => false))
    ) {
        return
    }

    const content = await fspromises.readFile(fileOption.filePath, 'utf-8')
    client.notify('textDocument/didOpen', { uri: fileOption.filePath, content })
    const contextItems = await client.request('autocomplete/tscContextRetriever', {
        filePath: fileOption.filePath,
        position: {
            line: fileOption.line,
            character: fileOption.column,
        },
        options: {
            maxPrefixLength: option.maxPrefixLength,
            maxSuffixLength: option.maxSuffixLength,
            maxChars: 0,
            maxMsec: 1000,
        },
    })
    await fspromises.mkdir(path.dirname(contextSavePath), { recursive: true })
    await fspromises.writeFile(contextSavePath, JSON.stringify(contextItems, null, 2))
}
