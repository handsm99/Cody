import * as child_process from 'child_process'
import * as fs from 'fs'
import * as fspromises from 'fs/promises'
import * as os from 'os'
import path from 'path'
import * as util from 'util'

import * as rimraf from 'rimraf'
import { afterAll, assert, beforeAll, describe, expect, it } from 'vitest'
import * as vscode from 'vscode'

import { BfgRetriever } from '../../../vscode/src/completions/context/retrievers/bfg/bfg-retriever'
import { getCurrentDocContext } from '../../../vscode/src/completions/get-current-doc-context'
import { initTreeSitterParser } from '../../../vscode/src/completions/test-helpers'
import { Agent, initializeVscodeExtension } from '../agent'
import { MessageHandler } from '../jsonrpc-alias'
import * as vscode_shim from '../vscode-shim'

const exec = util.promisify(child_process.exec)

let dir = path.join(process.cwd(), 'agent', 'src', 'bfg', '__tests__', 'typescript')
if (!fs.existsSync(dir)) {
    dir = path.join(process.cwd(), 'src', 'bfg', '__tests__', 'typescript')
}
const bfgCratePath = process.env.BFG_CRATE_PATH
const testFile = path.join('src', 'main.ts')
const gitdir = path.join(dir, '.git')
const shouldCreateGitDir = !fs.existsSync(gitdir)

describe('BfgRetriever', async () => {
    if (process.env.SRC_ACCESS_TOKEN === undefined || process.env.SRC_ENDPOINT === undefined) {
        // The test runs successfully without these environment variables. We
        // only have this check enabled for now to skip running BFG tests in CI.
        // We should prioritize figuring out how to enable these tests to run in
        // CI alongside other agent tests.
        it('no-op test because SRC_ACCESS_TOKEN is not set. To actually run BFG tests, set the environment variables SRC_ENDPOINT and SRC_ACCESS_TOKEN', () => {})
        return
    }
    const tmpDir = await fspromises.mkdtemp(path.join(os.tmpdir(), 'bfg-'))
    beforeAll(async () => {
        process.env.CODY_TESTING = 'true'
        await initTreeSitterParser()
        initializeVscodeExtension()

        if (shouldCreateGitDir) {
            await exec('git init', { cwd: dir })
            await exec('git add .', { cwd: dir })
            await exec('git commit -m "First commit"', { cwd: dir })
        }

        if (bfgCratePath && process.env.BFG_BUILD === 'true') {
            await exec('cargo build', { cwd: bfgCratePath })
        }
    })
    afterAll(async () => {
        if (shouldCreateGitDir) {
            await rimraf.rimraf(gitdir)
            // rimraf.rimrafSync(tmpDir)
        }
    })

    const agent = new Agent()

    const debugHandler = new MessageHandler()
    debugHandler.registerNotification('debug/message', params => console.log(`${params.channel}: ${params.message}`))
    debugHandler.messageEncoder.pipe(agent.messageDecoder)
    agent.messageEncoder.pipe(debugHandler.messageDecoder)

    const filePath = path.join(dir, testFile)
    const content = await fspromises.readFile(filePath, 'utf8')
    const CURSOR = '/*CURSOR*/'
    it('returns non-empty context', async () => {
        const gitdirUri = vscode.Uri.from({ scheme: 'file', path: gitdir })
        if (bfgCratePath) {
            const bfgBinary = path.join(bfgCratePath, '..', '..', 'target', 'debug', 'bfg')
            vscode_shim.customConfiguration['cody.experimental.bfg.path'] = bfgBinary
        }
        const extensionContext: Partial<vscode.ExtensionContext> = {
            globalStorageUri: vscode.Uri.from({ scheme: 'file', path: tmpDir }),
        }
        agent.workspace.addDocument({
            filePath,
            content: content.replace(CURSOR, ''),
        })

        const bfg = new BfgRetriever(extensionContext as vscode.ExtensionContext, () => gitdirUri)

        const document = agent.workspace.agentTextDocument({ filePath })
        assert(document.getText().length > 0)
        const offset = content.indexOf(CURSOR)
        assert(offset >= 0, content)
        const position = document.positionAt(offset)
        const docContext = getCurrentDocContext({ document, position, maxPrefixLength: 10_000, maxSuffixLength: 1_000 })
        const maxChars = 1_000
        const maxMs = 100

        expect(await bfg.retrieve({ document, position, docContext, hints: { maxChars, maxMs } })).toHaveLength(2)
    })
})
