import { execSync } from 'child_process'
import * as fspromises from 'fs/promises'
import * as path from 'path'

import * as commander from 'commander'
import { calcPatch } from 'fast-myers-diff'
import { minimatch } from 'minimatch'
import { rimraf } from 'rimraf'
import { Range, Uri } from 'vscode'
import { QueryCapture } from 'web-tree-sitter'

import { Input } from '@sourcegraph/scip-typescript/src/Input'
import * as scip from '@sourcegraph/scip-typescript/src/scip'

import { getParseLanguage } from '../../../../vscode/src/tree-sitter/grammars'
import { createParser } from '../../../../vscode/src/tree-sitter/parser'
import { newAgentClient } from '../../agent'
import { AgentTextDocument } from '../../AgentTextDocument'
import { MessageHandler } from '../../jsonrpc-alias'
import { getLanguageForFileName } from '../../language'

import { formatSnapshot } from './formatSnapshot'
import { Queries } from './Queries'

interface EvaluateAutocompleteOptions {
    workspace: string
    treeSitterGrammars: string
    queriesDirectory: string
    testCount: number
    includeFixture: string[]
    excludeFixture: string[]
    includeWorkspace: string[]
    excludeWorkspace: string[]
    includeFilepath?: string[]
    excludeFilepath?: string[]
    srcAccessToken: string
    srcEndpoint: string
    evaluationConfig: string
    snapshotDirectory: string
    bfgBinary?: string
    installCommands?: string[]
    testCommands?: string[]
    fixture: EvaluationFixture
}

interface EvaluationConfig extends Partial<EvaluateAutocompleteOptions> {
    tests: EvaluateAutocompleteOptions[]
    fixtures?: EvaluationFixture[]
}

enum EvaluationStrategy {
    BFG = 'bfg',
    GitLog = 'git-log',
}

interface EvaluationFixture {
    name: string
    customConfiguration?: Record<string, any>
    strategy: EvaluationStrategy
}

async function loadEvaluationConfig(options: EvaluateAutocompleteOptions): Promise<EvaluateAutocompleteOptions[]> {
    if (!options?.evaluationConfig) {
        return [options]
    }
    const configBuffer = await fspromises.readFile(options.evaluationConfig)
    const config = JSON.parse(configBuffer.toString()) as EvaluationConfig
    const result: EvaluateAutocompleteOptions[] = []
    for (const test of config?.tests ?? []) {
        if (!test.workspace) {
            console.error(`skipping test, missing required property 'workspace': ${JSON.stringify(test)}`)
            continue
        }
        const rootDir = path.dirname(options.evaluationConfig)
        const workspace = path.normalize(path.join(rootDir, test.workspace))
        const queriesDirectory = test.queriesDirectory
            ? path.join(rootDir, test.queriesDirectory)
            : config.queriesDirectory
            ? path.join(rootDir, config.queriesDirectory)
            : options.queriesDirectory
        const fixtures: EvaluationFixture[] = config.fixtures ?? [{ name: 'default', strategy: EvaluationStrategy.BFG }]
        for (const fixture of fixtures) {
            if (!fixture.strategy) {
                throw new Error(`missing: fixture.strategy: ${JSON.stringify(fixture)}`)
            }
            const snapshotDirectory = test.snapshotDirectory
                ? path.join(rootDir, test.snapshotDirectory, fixture.name, test.workspace)
                : config.snapshotDirectory
                ? path.join(rootDir, config.snapshotDirectory, fixture.name, test.workspace)
                : options.snapshotDirectory
            result.push({ ...options, ...config, ...test, workspace, queriesDirectory, snapshotDirectory, fixture })
        }
    }

    return result
}

function intOption(value: string): number {
    const parsedValue = Number.parseInt(value, 10)
    if (isNaN(parsedValue)) {
        throw new commander.InvalidArgumentError('Not a number.')
    }
    return parsedValue
}

function collect<T>(value: T, previous: T[]): T[] {
    return previous.concat([value])
}

export const evaluateAutocompleteCommand = new commander.Command('evaluate-autocomplete')
    .description('Evaluate Cody autocomplete by running the Agent in headless mode')
    .option('--workspace <path>', 'The workspace directory where to run the autocomplete evaluation', process.cwd())
    .option('--test-count <number>', 'The number of autocomplete requests to run in this evaluation', intOption)
    .option('--evaluation-config <path>', 'Path to a JSON with configuration for this evaluation', '')
    .option(
        '--snapshot-directory <path>',
        'Directory where to write snapshot files to document autocomplete results',
        ''
    )
    .addOption(
        new commander.Option(
            '--src-access-token <token>',
            'The Sourcegraph access token to use for authentication'
        ).env('SRC_ACCESS_TOKEN')
    )
    .addOption(
        new commander.Option('--src-endpoint <url>', 'The Sourcegraph URL endpoint to use for authentication').env(
            'SRC_ENDPOINT'
        )
    )
    .option(
        '--include-workspace <glob>',
        'A glob pattern to determine what workspace paths to include in the evaluation',
        collect as any,
        []
    )
    .option(
        '--exclude-workspace <glob>',
        'A glob pattern to determine what workspace paths to exclude in the evaluation',
        collect as any,
        []
    )
    .option(
        '--include-fixture <glob>',
        'A glob pattern to determine what fixtures to include in the evaluation',
        collect as any,
        []
    )
    .option(
        '--exclude-fixture <glob>',
        'A glob pattern to determine what fixtures exclude in the evaluation',
        collect as any,
        []
    )
    .addOption(new commander.Option('--bfg-binary <path>', 'Optional path to a BFG binary').env('BFG_BINARY'))
    .option(
        '--tree-sitter-grammars <path>',
        'Path to a directory containing tree-sitter grammars',
        path.resolve(__dirname, '../../vscode/dist')
    )
    .option('--queries-directory <path>', 'Path to a directory containing tree-sitter queries')
    .action(async (options: EvaluateAutocompleteOptions) => {
        const testOptions = await loadEvaluationConfig(options)
        const workspacesToRun = testOptions.filter(
            testOptions =>
                matchesGlobPatterns(options.includeWorkspace, options.excludeWorkspace, testOptions.workspace) &&
                matchesGlobPatterns(options.includeFixture, options.excludeFixture, testOptions.fixture.name)
        )
        await Promise.all(workspacesToRun.map(workspace => evaluateWorkspace(workspace)))
    })

async function evaluateWorkspace(options: EvaluateAutocompleteOptions): Promise<void> {
    console.log(`starting evaluation: fixture=${options.fixture.name} workspace=${options.workspace}`)
    const workspace = path.normalize(options.workspace)

    if (!options.queriesDirectory) {
        console.error('missing required options: --queries-directory')
        process.exit(1)
    }
    if (!options.srcAccessToken) {
        console.error('environment variable SRC_ACCESS_TOKEN must be non-empty')
        process.exit(1)
    }
    if (!options.srcEndpoint) {
        console.error('environment variable SRC_ENDPOINT must be non-empty')
        process.exit(1)
    }

    const workspaceRootUri = Uri.from({ scheme: 'file', path: workspace })
    const client = await newAgentClient({
        name: 'evaluate-autocomplete',
        version: '0.1.0',
        workspaceRootUri: workspaceRootUri.toString(),
        extensionConfiguration: {
            accessToken: options.srcAccessToken,
            serverEndpoint: options.srcEndpoint,
            customHeaders: {},
            customConfiguration: options.fixture.customConfiguration,
        },
    })
    try {
        if (options.fixture.strategy === EvaluationStrategy.BFG) {
            await evaluateBfgStrategy(client, options, workspace)
        } else if (options.fixture.strategy === EvaluationStrategy.GitLog) {
            await evaluateGitLogStrategy(client, options, workspace)
        }
    } catch (error) {
        console.error('unexpected error running evaluate-autocomplete', error)
    }
    await client.request('shutdown', null)
    client.notify('exit', null)
}

async function evaluateGitLogStrategy(
    client: MessageHandler,
    options: EvaluateAutocompleteOptions,
    workspace: string
): Promise<void> {
    // TODO: complete this Philipp
}

/**
 * Runs autocomplete evaluation. The current logic is specifically optimized
 * to evaluate BFG.  The best way to customize the logic is by changing the
 * code. Eventually, we could make the logic configurable via command-line
 * flags so that we can reuse this command for different kinds of evaluations.
 */
async function evaluateBfgStrategy(
    client: MessageHandler,
    options: EvaluateAutocompleteOptions,
    workspace: string
): Promise<void> {
    const queries = new Queries(options.queriesDirectory)
    const grammarDirectory = path.normalize(options.treeSitterGrammars)
    const files = execSync('git ls-files', { cwd: workspace }).toString().split('\n')
    files.sort()
    let remainingTests = options.testCount
    if (options.snapshotDirectory) {
        await rimraf(options.snapshotDirectory)
    }
    for (const file of files) {
        if (!matchesGlobPatterns(options.includeFilepath ?? [], options.excludeFilepath ?? [], file)) {
            continue
        }
        const filePath = path.join(workspace, file)
        const stat = await fspromises.stat(filePath)
        if (!stat.isFile()) {
            continue
        }
        const content = (await fspromises.readFile(filePath)).toString()
        const languageid = getLanguageForFileName(file)
        const language = getParseLanguage(languageid)
        if (!language) {
            continue
        }
        client.notify('textDocument/didOpen', { filePath, content })
        const parser = await createParser({ language, grammarDirectory })
        const tree = parser.parse(content)
        const query = await queries.loadQuery(parser, language, 'context')
        if (!query) {
            continue
        }

        const document = new scip.scip.Document({ relative_path: file, language: languageid })
        for (const match of query.matches(tree.rootNode)) {
            if (remainingTests <= 0) {
                break
            }
            for (const capture of match.captures) {
                if (remainingTests <= 0) {
                    break
                }
                if (capture.name === 'range') {
                    if (capture.node.startPosition.row !== capture.node.endPosition.row) {
                        // TODO: handle multi-line
                        continue
                    }
                    try {
                        await triggerAutocomplete({ content, filePath, capture, client, document })
                    } catch {
                        // const message = error instanceof Error ? error.message : `${error}`
                        // TODO: push error occurrence
                        // const range
                        // const occurrence = new scip.scip.Occurrence({ symbol: message })
                        // document.occurrences.push(occurrence)
                        // ignore. Most common issue is that autocomplete times out.
                    }
                    remainingTests--
                }
            }
        }

        // Write snapshot file to disk we get non-empty autocomplete results.
        if (options.snapshotDirectory && document.occurrences.length > 0) {
            const outputPath = path.join(options.snapshotDirectory, file)
            await fspromises.mkdir(path.dirname(outputPath), { recursive: true })
            const input = new Input(filePath, content)
            const snapshot = formatSnapshot(input, document)
            await fspromises.writeFile(outputPath, snapshot)
        }
    }
}

// TODO: rename to remove fixture from this interface
interface AutocompleteFixture {
    content: string
    filePath: string
    capture: QueryCapture
    client: MessageHandler
    document: scip.scip.Document
}

// TODO: complete this interface when we start using graphql/logEvent
// interface AutocompletePublicArgument {
//     fixture: string
//     filepath: string
//     commit: string
//     completionEvent?: CompletionEvent
//     error?: string
//     emptyResult?: boolean
//     exactMatch?: boolean
//     didParseSuccessfully?: boolean
//     didTypecheckSuccessfully?: boolean
// }

async function triggerAutocomplete(fixture: AutocompleteFixture): Promise<void> {
    const { content, filePath, capture, client, document } = fixture
    // Modify the content by replacing the argument list to the call expression
    // with an empty argument list. This evaluation is interesting because it
    // allows us to test how good Cody is at inferring the original argument
    // list.
    const modifiedContent = [
        content.slice(0, capture.node.startIndex),
        '()',
        content.slice(capture.node.endIndex),
    ].join('')
    const removedContent = content.slice(capture.node.startIndex, capture.node.endIndex)
    client.notify('textDocument/didChange', { filePath, content: modifiedContent })
    const result = await client.request('autocomplete/execute', {
        filePath,
        position: {
            line: capture.node.startPosition.row,
            character: capture.node.startPosition.column + 1,
        },
        // We don't use the "automatic" trigger to avoid certain code paths like
        // synthetic latency when acceptance rate is low.
        triggerKind: 'Invoke',
    })
    const didNotSendNetworkRequest =
        result.items.length === 0 && result.completionEvent?.networkRequestStartedAt === null
    if (didNotSendNetworkRequest) {
        return
    }
    const textDocument = new AgentTextDocument({ filePath, content: modifiedContent })
    const pushText = (text: string): void => {
        const scipRange = [
            capture.node.startPosition.row,
            capture.node.startPosition.column,
            capture.node.endPosition.column,
        ]
        const occurrence = new scip.scip.Occurrence({
            symbol: text,
            range: scipRange,
            symbol_roles: 0,
        })
        // TODO: log event
        // client.request('graphql/logEvent', {
        //     event: 'CodyEvaluation',
        //     client: 'evaluate-autocomplete',
        //     source: 'IDEEXTENSION',
        //     url: '',
        //     userCookieID: '',
        //     publicArgument:
        // })
        document.occurrences.push(occurrence)
    }
    for (const item of result.items) {
        const range = new Range(
            item.range.start.line,
            item.range.start.character,
            item.range.end.line,
            item.range.end.character
        )
        const original = textDocument.getText(range)
        const completion = item.insertText
        const patches: string[] = []
        for (const [sx, ex, text] of calcPatch(original, completion)) {
            if (sx !== ex) {
                // TODO: handle non-insert patches
                continue
            }
            patches.push(text)
        }
        if (patches.length > 0) {
            const text = patches.join('')
            if (['(', text, ')'].join('') === removedContent) {
                pushText('EXACT_MATCH')
            } else {
                pushText(text)
            }
        }
    }
    if (result.items.length === 0) {
        pushText(removedContent === '()' ? 'EXACT_MATCH' : 'EMPTY_RESULT')
    }
}

function matchesGlobPatterns(includeGlobs: string[], excludeGlobs: string[], value: string): boolean {
    const matchingIncludePattern =
        includeGlobs.length > 0 ? !!includeGlobs.find(includePattern => minimatch(value, includePattern)) : true
    if (!matchingIncludePattern) {
        return false
    }

    const matchingExcludePatttern = excludeGlobs.find(excludePattern => minimatch(value, excludePattern))
    return !matchingExcludePatttern
}
