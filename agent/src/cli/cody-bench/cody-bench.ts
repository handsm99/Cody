import * as fspromises from 'node:fs/promises'
import * as path from 'node:path'

import * as commander from 'commander'
import * as vscode from 'vscode'

import { newAgentClient } from '../../agent'

import { ModelsService, getDotComDefaultModels, graphqlClient } from '@sourcegraph/cody-shared'
import { startPollyRecording } from '../../../../vscode/src/testutils/polly'
import { allClientCapabilitiesEnabled } from '../../allClientCapabilitiesEnabled'
import { arrayOption, booleanOption, intOption } from './cli-parsers'
import { matchesGlobPatterns } from './matchesGlobPatterns'
import { evaluateAutocompleteStrategy } from './strategy-autocomplete'
import { evaluateChatStrategy } from './strategy-chat'
import { evaluateFixStrategy } from './strategy-fix'
import { evaluateGitLogStrategy } from './strategy-git-log'

export interface CodyBenchOptions {
    workspace: string
    worktree?: string
    treeSitterGrammars: string
    queriesDirectory: string
    testCount: number
    maxFileTestCount: number
    includeFixture: string[]
    excludeFixture: string[]
    includeWorkspace: string[]
    excludeWorkspace: string[]
    includeFilepath?: string[]
    excludeFilepath?: string[]
    includeLanguage?: string[]
    excludeLanguage?: string[]
    includeMatchKind?: string[]
    excludeMatchKind?: string[]
    testTypecheck?: boolean
    testParse?: boolean
    srcAccessToken: string
    srcEndpoint: string

    codyAgentBinary?: string

    matchMinimumSize?: number
    matchSkipSingleline?: number
    matchEveryN?: number
    matchKindDistribution?: number

    evaluationConfig: string
    snapshotDirectory: string
    csvPath?: string
    bfgBinary?: string
    installCommand?: string
    testCommand?: string
    gitLogFilter?: string
    fixture: EvaluationFixture

    verbose: boolean
}

interface EvaluationConfig extends Partial<CodyBenchOptions> {
    workspaces: CodyBenchOptions[]
    fixtures?: EvaluationFixture[]
}

export enum BenchStrategy {
    Autocomplete = 'autocomplete',
    GitLog = 'git-log',
    Fix = 'fix',
    Chat = 'chat',
}

interface EvaluationFixture {
    name: string
    customConfiguration?: Record<string, any>
    strategy: BenchStrategy
    codyAgentBinary?: string
}

async function loadEvaluationConfig(options: CodyBenchOptions): Promise<CodyBenchOptions[]> {
    if (!options?.evaluationConfig) {
        return [options]
    }
    const configBuffer = await fspromises.readFile(options.evaluationConfig)
    const config = JSON.parse(configBuffer.toString()) as EvaluationConfig
    const result: CodyBenchOptions[] = []
    for (const test of config?.workspaces ?? []) {
        if (!test.workspace) {
            console.error(
                `skipping test, missing required property 'workspace': ${JSON.stringify(test)}`
            )
            continue
        }
        const rootDir = path.dirname(options.evaluationConfig)
        const workspace = path.normalize(path.join(rootDir, test.workspace))
        const fixtures: EvaluationFixture[] = config.fixtures ?? [
            { name: 'default', strategy: BenchStrategy.Autocomplete },
        ]
        for (const fixture of fixtures) {
            if (!fixture.strategy) {
                throw new Error(`missing: fixture.strategy: ${JSON.stringify(fixture)}`)
            }
            const snapshotDirectory = test.snapshotDirectory
                ? path.join(rootDir, test.snapshotDirectory, fixture.name, test.workspace)
                : config.snapshotDirectory
                  ? path.join(rootDir, config.snapshotDirectory, fixture.name, test.workspace)
                  : options.snapshotDirectory

            const codyAgentBinary = fixture.codyAgentBinary
                ? path.resolve(path.dirname(options.evaluationConfig), fixture.codyAgentBinary)
                : undefined
            result.push({
                ...options,
                ...config,
                ...test,
                queriesDirectory: options?.queriesDirectory,
                workspace,
                snapshotDirectory,
                codyAgentBinary,
                fixture,
                csvPath: path.join(snapshotDirectory, 'cody-bench.csv'),
            })
        }
    }

    return result
}

export const codyBenchCommand = new commander.Command('cody-bench')
    .description(
        'Evaluate Cody autocomplete by running the Agent in headless mode. ' +
            'See the repo https://github.com/sourcegraph/cody-bench-data for ' +
            'more details about running cody-bench and how to evaluate the data.'
    )
    .option(
        '--workspace <path>',
        'The workspace directory where to run the autocomplete evaluation',
        process.cwd()
    )
    .option(
        '--test-count <number>',
        'The number of autocomplete requests to run in this evaluation',
        intOption,
        10_000
    )
    .option(
        '--max-file-test-count <number>',
        'The maximum number of autocomplete requests to evaluate in a single document',
        intOption,
        // relatively safe to use large number because we spread usages
        // across different autocomplete kinds
        100
    )
    .option('--evaluation-config <path>', 'Path to a JSON with configuration for this evaluation', '')
    .option(
        '--snapshot-directory <path>',
        'Directory where to write snapshot files to document autocomplete results',
        ''
    )
    .option(
        '--include-match-kind <kind>',
        'Glob to determine what kinds of matches to trigger autocomplete against.',
        arrayOption as any,
        []
    )
    .option(
        '--exclude-match-kind <kind>',
        'Glob to determine what kinds of matches to not trigger autocomplete against.',
        arrayOption as any,
        []
    )
    .option('--match-skip-singleline <bool>', 'Whether to skip single line ranges', booleanOption, false)
    .option(
        '--match-minimum-size <number>',
        'Minimum size of a match to trigger an autocomplete',
        intOption,
        20
    )
    .option(
        '--match-every-n <number>',
        'Only trigger autocomplete in every N-th match. The motivation to do this is a to get a wider spread of matches. ' +
            'Sometimes, the same code pattern repeats multiple times and eats up the limit for the file. ' +
            ' By skipping every few matches, there is a bigger chance that we will hit requests further down in the file before hitting the file request limit.',
        intOption,
        1
    )
    .option(
        '--match-kind-distribution <number>',
        "Don't allow a bigger gap than X between the autocomplete kind with most triggers and least triggers. " +
            'Sometimes, the same code pattern repeats multiple times and eats up the limit for the file. ' +
            ' By skipping every few matches, there is a bigger chance that we will hit requests further down in the file before hitting the file request limit.',
        intOption,
        1.4
    )
    .option('--verbose', 'Verbose output', false)
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
    .option(
        '--include-workspace <glob>',
        'A glob pattern to determine what workspace paths to include in the evaluation',
        arrayOption as any,
        []
    )
    .option(
        '--exclude-workspace <glob>',
        'A glob pattern to determine what workspace paths to exclude in the evaluation',
        arrayOption as any,
        []
    )
    .option(
        '--include-language <glob>',
        'A glob pattern to determine what language paths to include in the evaluation',
        arrayOption as any,
        []
    )
    .option(
        '--exclude-language <glob>',
        'A glob pattern to determine what language paths to exclude in the evaluation',
        arrayOption as any,
        []
    )
    .option(
        '--include-fixture <glob>',
        'A glob pattern to determine what fixtures to include in the evaluation',
        arrayOption as any,
        []
    )
    .option(
        '--exclude-fixture <glob>',
        'A glob pattern to determine what fixtures exclude in the evaluation',
        arrayOption as any,
        []
    )
    .option(
        '--include-filepath <glob>',
        'A glob pattern to determine what files to include in the evaluation',
        arrayOption as any,
        []
    )
    .option(
        '--exclude-filepath <glob>',
        'A glob pattern to determine what files exclude in the evaluation',
        arrayOption as any,
        []
    )
    .addOption(
        new commander.Option('--bfg-binary <path>', 'Optional path to a BFG binary').env('BFG_BINARY')
    )
    .option(
        '--tree-sitter-grammars <path>',
        'Path to a directory containing tree-sitter grammars',
        path.resolve(__dirname, '../../vscode/dist')
    )
    .option(
        '--queries-directory <path>',
        'Path to a directory containing tree-sitter queries',
        path.resolve(__dirname, '../src/cli/cody-bench/queries')
    )
    .option(
        '--test-typecheck',
        'If enabled, runs the test command to typecheck the generated code',
        booleanOption,
        false // disabled by default because it's slow and requires custom configuration
    )
    .option(
        '--test-parse',
        'If enabled, parses the generated code to validate whether it has syntax errors or not',
        booleanOption,
        true
    )
    .action(async (options: CodyBenchOptions) => {
        const testOptions = await loadEvaluationConfig(options)
        const workspacesToRun = testOptions.filter(
            testOptions =>
                matchesGlobPatterns(
                    options.includeWorkspace,
                    options.excludeWorkspace,
                    testOptions.workspace
                ) &&
                matchesGlobPatterns(
                    options.includeFixture,
                    options.excludeFixture,
                    testOptions.fixture.name
                )
        )

        // Required to use `PromptString`.
        graphqlClient.onConfigurationChange({
            accessToken: options.srcAccessToken,
            serverEndpoint: options.srcEndpoint,
            customHeaders: {},
        })

        const recordingDirectory = path.join(path.dirname(options.evaluationConfig), 'recordings')
        const polly = startPollyRecording({
            recordingName: 'cody-bench',
            recordingMode: 'replay',
            recordIfMissing: true,
            recordingDirectory,
            keepUnusedRecordings: true,
        })
        ModelsService.setModels(getDotComDefaultModels())
        try {
            await Promise.all(
                workspacesToRun.map(workspace => evaluateWorkspace(workspace, recordingDirectory))
            )
        } finally {
            await polly.stop()
        }
        process.exit(0)
    })

async function evaluateWorkspace(options: CodyBenchOptions, recordingDirectory: string): Promise<void> {
    console.log(`starting evaluation: fixture=${options.fixture.name} workspace=${options.workspace}`)

    if (!options.srcAccessToken) {
        console.error('environment variable SRC_ACCESS_TOKEN must be non-empty')
        process.exit(1)
    }
    if (!options.srcEndpoint) {
        console.error('environment variable SRC_ENDPOINT must be non-empty')
        process.exit(1)
    }

    const workspaceRootUri = vscode.Uri.from({ scheme: 'file', path: options.workspace })

    const baseGlobalState: Record<string, any> = {}
    const editModel = options.fixture.customConfiguration?.['cody-bench.editModel']
    if (typeof editModel === 'string') {
        // There is no VSC setting yet to configure the base edit model. Users
        // can only modify this setting by changing it through the quickpick
        // menu in VSC.
        const provider = ModelsService.getModelByIDSubstringOrError(editModel)
        baseGlobalState.editModel = provider.model
    }

    const client = await newAgentClient({
        name: 'cody-bench',
        version: '0.1.0',
        workspaceRootUri: workspaceRootUri.toString(),
        extensionConfiguration: {
            accessToken: options.srcAccessToken,
            serverEndpoint: options.srcEndpoint,
            customHeaders: {},
            customConfiguration: {
                'cody.experimental.symf.enabled': false, // fixes errors in Polly.js related to fetchin the symf binary
                'cody.experimental.telemetry.enabled': false,
                ...options.fixture.customConfiguration,
            },
            baseGlobalState,
        },
        codyAgentPath: options.codyAgentBinary,
        capabilities: allClientCapabilitiesEnabled,
        inheritStderr: true,
        extraEnvVariables: {
            CODY_RECORDING_NAME: `${options.fixture.name}-${path.basename(options.workspace)}`,
            CODY_RECORDING_DIRECTORY: recordingDirectory,
            CODY_RECORDING_MODE: 'replay',
            CODY_RECORD_IF_MISSING: 'true',
            CODY_KEEP_UNUSED_RECORDINGS: 'true',
            CODY_DISABLE_FASTPATH: 'true',
        },
    })
    try {
        if (options.fixture.strategy === BenchStrategy.Autocomplete) {
            await evaluateAutocompleteStrategy(client, options)
        } else if (options.fixture.strategy === BenchStrategy.GitLog) {
            await evaluateGitLogStrategy(client, options)
        }
        switch (options.fixture.strategy) {
            case BenchStrategy.Autocomplete:
                await evaluateAutocompleteStrategy(client, options)
                break
            case BenchStrategy.GitLog:
                await evaluateGitLogStrategy(client, options)
                break
            case BenchStrategy.Fix:
                await evaluateFixStrategy(client, options)
                break
            case BenchStrategy.Chat:
                await evaluateChatStrategy(client, options)
                break
            default:
                throw new Error(`unknown strategy ${options.fixture.strategy}`)
        }
    } catch (error) {
        console.error('unexpected error running cody-bench', error)
    }
    console.log('cody-bench completed, shutting down...')
    await client.request('shutdown', null)
    client.notify('exit', null)
}
