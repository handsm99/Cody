import path from 'node:path'

import { spawnSync } from 'node:child_process'
import { INCLUDE_EVERYTHING_CONTEXT_FILTERS } from '@sourcegraph/cody-shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { TESTING_CREDENTIALS } from '../../vscode/src/testutils/testing-credentials'
import { TestClient } from './TestClient'
import { TestWorkspace } from './TestWorkspace'

// Enterprise tests are run at demo instance, which is at a recent release version.
// Use this section if you need to run against S2 which is released continuously.
describe('Enterprise - S2 (close main branch)', { timeout: 5000 }, () => {
    const workspace = new TestWorkspace(path.join(__dirname, '__tests__', 'example-ts'))
    const s2EnterpriseClient = TestClient.create({
        workspaceRootUri: workspace.rootUri,
        name: 'enterpriseMainBranchClient',
        credentials: TESTING_CREDENTIALS.s2,
        logEventMode: 'connected-instance-only',
    })
    const sumUri = workspace.file('src', 'sum.ts')
    const animalUri = workspace.file('src', 'animal.ts')
    const squirrelUri = workspace.file('src', 'squirrel.ts')

    // Initialize inside beforeAll so that subsequent tests are skipped if initialization fails.
    beforeAll(async () => {
        await workspace.beforeAll()
        // Init a repo in the workspace to make the parent-dirs repo-name resolver work for Cody Context Filters tests.
        spawnSync('git', ['init'], { cwd: workspace.rootPath, stdio: 'inherit' })
        spawnSync('git', ['remote', 'add', 'origin', 'git@github.com:sourcegraph/cody.git'], {
            cwd: workspace.rootPath,
            stdio: 'inherit',
        })

        const serverInfo = await s2EnterpriseClient.initialize()

        expect(serverInfo.authStatus?.authenticated).toBeTruthy()
        if (!serverInfo.authStatus?.authenticated) {
            throw new Error('unreachable')
        }
        expect(serverInfo.authStatus?.username).toStrictEqual('codytesting')
    }, 10_000)

    // Use S2 instance for Cody Context Filters enterprise tests
    describe('Cody Context Filters for enterprise', () => {
        beforeAll(async () => {
            // Reset the ignore policy at the start so that we don't try to fetch in the background.
            await s2EnterpriseClient.request(
                'testing/ignore/overridePolicy',
                INCLUDE_EVERYTHING_CONTEXT_FILTERS
            )
        })

        it('testing/ignore/overridePolicy', async () => {
            await s2EnterpriseClient.openFile(sumUri)

            const onChangeCallback = vi.fn()

            // `sumUri` is located inside of the github.com/sourcegraph/cody repo.
            const ignoreTest = () =>
                s2EnterpriseClient.request('ignore/test', { uri: sumUri.toString() })
            s2EnterpriseClient.registerNotification('ignore/didChange', onChangeCallback)

            expect(await ignoreTest()).toStrictEqual({ policy: 'use' })
            expect(onChangeCallback).toBeCalledTimes(0)

            await s2EnterpriseClient.request('testing/ignore/overridePolicy', {
                include: [{ repoNamePattern: '' }],
                exclude: [{ repoNamePattern: '.*sourcegraph/cody.*' }],
            })

            expect(onChangeCallback).toBeCalledTimes(1)
            expect(await ignoreTest()).toStrictEqual({ policy: 'ignore' })

            await s2EnterpriseClient.request('testing/ignore/overridePolicy', {
                include: [{ repoNamePattern: '' }],
                exclude: [{ repoNamePattern: '.*sourcegraph/sourcegraph.*' }],
            })

            expect(onChangeCallback).toBeCalledTimes(2)
            expect(await ignoreTest()).toStrictEqual({ policy: 'use' })

            await s2EnterpriseClient.request('testing/ignore/overridePolicy', {
                include: [{ repoNamePattern: '' }],
                exclude: [{ repoNamePattern: '.*sourcegraph/sourcegraph.*' }],
            })

            // onChangeCallback is not called again because filters are the same
            expect(onChangeCallback).toBeCalledTimes(2)
            s2EnterpriseClient.unregisterNotification('ignore/didChange')
        })

        // The site config `cody.contextFilters` value on sourcegraph.sourcegraph.com instance
        // should include `sourcegraph/cody` repo for this test to pass.
        it('autocomplete/execute (with Cody Ignore filters)', async () => {
            // Documents to be used as context sources.
            await s2EnterpriseClient.openFile(animalUri)
            await s2EnterpriseClient.openFile(squirrelUri)

            // Document to generate a completion from.
            await s2EnterpriseClient.openFile(sumUri)

            const { items, completionEvent } = await s2EnterpriseClient.request('autocomplete/execute', {
                uri: sumUri.toString(),
                position: { line: 1, character: 4 },
                triggerKind: 'Invoke',
            })

            expect(items.length).toBeGreaterThan(0)
            expect(items.map(item => item.insertText)).toMatchInlineSnapshot(
                `
              [
                "    return a + b",
              ]
            `
            )

            // Two documents will be checked against context filters set in site-config on S2.
            expect(
                completionEvent?.params.contextSummary?.retrieverStats['jaccard-similarity']
                    .suggestedItems
            ).toEqual(2)

            s2EnterpriseClient.notify('autocomplete/completionAccepted', {
                completionID: items[0].id,
            })
        }, 10_000)
    })

    describe('attribution', () => {
        // Disabled because `attribution/search` GraphQL does not work on S2
        // See https://sourcegraph.slack.com/archives/C05JDP433DL/p1714017586160079
        it.skip('found', async () => {
            const id = await s2EnterpriseClient.request('chat/new', null)
            const { repoNames, error } = await s2EnterpriseClient.request('attribution/search', {
                id,
                snippet: 'sourcegraph.Location(new URL',
            })
            expect(repoNames).not.empty
            expect(error).null
        }, 20_000)

        it('not found', async () => {
            const id = await s2EnterpriseClient.request('chat/new', null)
            const { repoNames, error } = await s2EnterpriseClient.request('attribution/search', {
                id,
                snippet: 'sourcegraph.Location(new LRU',
            })
            expect(repoNames).empty
            expect(error).null
        }, 20_000)
    })

    afterAll(async () => {
        await workspace.afterAll()
        await s2EnterpriseClient.shutdownAndExit()
        // Long timeout because to allow Polly.js to persist HTTP recordings
    }, 30_000)
})
