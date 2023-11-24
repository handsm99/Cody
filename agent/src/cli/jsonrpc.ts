import NodeHttpAdapter from '@pollyjs/adapter-node-http'
import { EXPIRY_STRATEGY, MODE, Polly } from '@pollyjs/core'
import FSPersister from '@pollyjs/persister-fs'
import * as commander from 'commander'
import { Command, Option } from 'commander'

// Register the node http adapter so its accessible by all future polly instances

import { Agent } from '../agent'

interface JsonrpcCommandOptions {
    expiresIn?: string | null | undefined
    recordingDirectory?: string
    recordingMode?: MODE
    recordIfMissing?: boolean
    expiryStrategy?: EXPIRY_STRATEGY
    recordingName?: string
}

function recordingModeOption(value: string): MODE {
    switch (value) {
        case 'record':
        case 'replay':
        case 'passthrough':
        case 'stopped':
            return value
        default:
            throw new commander.InvalidArgumentError(
                'Not a valid recording mode. Valid options are record, replay-or-record, replay, passthrough, or stopped.'
            )
    }
}

function expiryStrategyOption(value: string): EXPIRY_STRATEGY {
    switch (value) {
        case 'error':
        case 'warn':
        case 'record':
            return value
        default:
            throw new commander.InvalidArgumentError(
                'Not a valid expiry strategy. Valid options are error, warn, or record.'
            )
    }
}

/**
 * The default file system persister with the following customizations
 *
 * - Replaces Cody access tokens with the string "REDACTED" because we don't
 *   want to commit the access token into git.
 */
class CodyPersister extends FSPersister {
    constructor(polly: any) {
        super(polly)
    }
    static get id() {
        return 'cody-fs'
    }
    public onSaveRecording(recordingId: string, recording: any) {
        const entries: any[] = recording?.log?.entries ?? []
        for (const entry of entries) {
            const headers: { name: string; value: string }[] = entry?.request?.headers
            for (const header of headers) {
                if (header.name === 'authorization') {
                    header.value = 'token REDACTED'
                }
            }
        }
        return super.onSaveRecording(recordingId, recording)
    }
}

export const jsonrpcCommand = new Command('jsonrpc')
    .description(
        'Interact with the Agent using JSON-RPC via stdout/stdin. ' +
            'This is the subcommand that is used by Cody clients like the JetBrains and Neovim plugins.'
    )
    .addOption(
        new Option(
            '--recording-directory <path>',
            'Path to the directory where network traffic is recorded or replayed from. This option should only be used in testing environments.'
        ).env('CODY_RECORDING_DIRECTORY')
    )
    .addOption(
        new Option(
            '--recording-mode <mode>',
            'What kind of recording mode to use. Valid values are to the directory where network traffic is recorded or replayed from. This option should only be used in testing environments.'
        )
            .argParser(recordingModeOption)
            .env('CODY_RECORDING_MODE')
    )
    .addOption(
        new Option(
            '--recording-name <mode>',
            'The name of the recording to use. Every unique name results in a unique recording (HAR file). Use a unique name for every unique test in your test suite.'
        ).env('CODY_RECORDING_NAME')
    )
    .addOption(
        new Option(
            '--recording-expiry-strategy <strategy>',
            'What to do when encountering an expired recording). Use a unique name for every unique test in your test suite.'
        )
            .argParser(expiryStrategyOption)
            .env('CODY_RECORDING_EXPIRY_STRATEGY')
            .default('error')
    )
    .addOption(
        new Option('--recording-expires-in <duration>', 'When to expire the recordings')
            .env('CODY_RECORDING_EXPIRES_IN')
            .default('365d')
    )
    .addOption(
        new Option('--recording-strict-replay <true|false>', 'If false, fails the test instead of recording').env(
            'CODY_RECORD_IF_MISSING'
        )
    )
    .action((options: JsonrpcCommandOptions) => {
        let polly: Polly | undefined
        if (options.recordingDirectory) {
            if (options.recordingMode === undefined) {
                console.error('CODY_RECORDING_MODE is required when CODY_RECORDING_DIRECTORY is set.')
                process.exit(1)
            }
            Polly.register(NodeHttpAdapter)
            Polly.register(CodyPersister)
            console.error({ options })
            polly = new Polly(options.recordingName ?? 'CodyAgent', {
                flushRequestsOnStop: true,
                recordIfMissing: options.recordIfMissing ?? options.recordingMode === 'record',
                mode: options.recordingMode,
                adapters: ['node-http'],
                persister: 'cody-fs',
                recordFailedRequests: true,
                expiryStrategy: options.expiryStrategy,
                expiresIn: options.expiresIn,
                persisterOptions: {
                    keepUnusedRequests: true,
                    // For cleaner diffs https://netflix.github.io/pollyjs/#/configuration?id=disablesortingharentries
                    disableSortingHarEntries: true,
                    fs: {
                        recordingsDir: options.recordingDirectory,
                    },
                },
                matchRequestsBy: {
                    headers(headers) {
                        delete headers['authorization']
                        return headers
                    },
                },
            })
        } else if (options.recordingMode) {
            console.error('CODY_RECORDING_DIRECTORY is required when CODY_RECORDING_MODE is set.')
            process.exit(1)
        }

        process.stderr.write('Starting Cody Agent...\n')

        const agent = new Agent({ polly })

        console.log = console.error

        // Force the agent process to exit when stdin/stdout close as an attempt to
        // prevent zombie agent processes. We experienced this problem when we
        // forcefully exit the IntelliJ process during local `./gradlew :runIde`
        // workflows. We manually confirmed that this logic makes the agent exit even
        // when we forcefully quit IntelliJ
        // https://github.com/sourcegraph/cody/pull/1439#discussion_r1365610354
        process.stdout.on('close', () => process.exit(1))
        process.stdin.on('close', () => process.exit(1))

        process.stdin.pipe(agent.messageDecoder)
        agent.messageEncoder.pipe(process.stdout)
    })
