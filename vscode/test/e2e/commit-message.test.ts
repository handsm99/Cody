import { promises as fs } from 'fs'
import { spawn } from 'child_process'
import * as mockServer from '../fixtures/mock-server'

import { sidebarSignin } from './common'
import {
    type DotcomUrlOverride,
    test as baseTest,
    type WorkspaceDirectory,
    withTempDir,
    assertEvents,
} from './helpers'
import { expect } from 'playwright/test'
import path from 'path'

// Reconfigured test to enable features within the Git extension (initialise a Git repo)
const test = baseTest
    .extend<DotcomUrlOverride>({
        dotcomUrl: mockServer.SERVER_URL,
    })
    .extend<WorkspaceDirectory>({
        // biome-ignore lint/correctness/noEmptyPattern: Playwright needs empty pattern to specify "no dependencies".
        workspaceDirectory: async ({}, use) => {
            await withTempDir(async dir => {
                // Initialize a git repository there
                await runGit(['init'], { cwd: dir })
                await runGit(['config', 'user.name', 'Test User'], {
                    cwd: dir,
                })
                await runGit(['config', 'user.email', 'test@example.host'], { cwd: dir })

                // Add Cody ignore
                await fs.mkdir(path.join(dir, '.cody'), { recursive: true })
                await fs.writeFile(path.join(dir, '.cody', 'ignore'), 'ignored.js')

                // Add empty files to change later
                await Promise.all([
                    fs.writeFile(path.join(dir, 'index.js'), ''),
                    fs.writeFile(path.join(dir, 'ignored.js'), ''),
                ])

                // Commit initial files
                await runGit(['add', '.'], { cwd: dir })
                await runGit(['commit', '-m', 'Initial commit'], {
                    cwd: dir,
                })

                // Add some content to try to commit in our tests
                await Promise.all([
                    fs.writeFile(path.join(dir, 'index.js'), '// Hello World'),
                    fs.writeFile(path.join(dir, 'ignored.js'), '// Ignore me!'),
                ])

                await use(dir)
            })
        },
    })

test.beforeEach(() => {
    mockServer.resetLoggedEvents()
})

test('commit message generation - happy path with staged changes', async ({ page, sidebar }) => {
    // Sign into Cody
    await sidebarSignin(page, sidebar)

    // Open the Source Control view
    await page
        .getByLabel(/Source Control/)
        .nth(2)
        .click()

    // Check the change is showing as a Git change
    await page.getByRole('heading', { name: 'Source Control' }).hover()
    await page.getByText('index.js').hover()
    const gitChange = page.getByLabel(/index.js/).getByLabel('Stage Changes')
    await gitChange.hover()
    await expect(gitChange).toBeVisible()

    // Stage Git change
    await gitChange.click()

    // Activate the Cody commit message feature
    const generateCommitMessageCta = page.getByLabel('Generate Commit Message (Cody)')
    await generateCommitMessageCta.hover()
    await expect(generateCommitMessageCta).toBeVisible()
    await generateCommitMessageCta.click()

    const expectedEvents = [
        'CodyVSCodeExtension:command:generateCommitMessage:clicked',
        'CodyVSCodeExtension:command:generateCommitMessage:executed',
    ]
    await assertEvents(mockServer.loggedEvents, expectedEvents)

    // Check generated content is displayed in the source control input
    await expect(
        page.getByLabel('Source Control Input').getByText('hello from the assistant')
    ).toBeVisible()
})

test('commit message generation - happy path with no staged changes', async ({ page, sidebar }) => {
    // Sign into Cody
    await sidebarSignin(page, sidebar)

    // Open the Source Control view
    await page
        .getByLabel(/Source Control/)
        .nth(2)
        .click()

    // Check the change is showing as a Git change
    await page.getByRole('heading', { name: 'Source Control' }).hover()
    await page.getByText('index.js').hover()
    const gitChange = page.getByLabel(/index.js/).getByLabel('Stage Changes')
    await gitChange.hover()
    await expect(gitChange).toBeVisible()

    // Activate the Cody commit message feature
    const generateCommitMessageCta = page.getByLabel('Generate Commit Message (Cody)')
    await generateCommitMessageCta.hover()
    await expect(generateCommitMessageCta).toBeVisible()
    await generateCommitMessageCta.click()

    const expectedEvents = [
        'CodyVSCodeExtension:command:generateCommitMessage:clicked',
        'CodyVSCodeExtension:command:generateCommitMessage:executed',
    ]
    await assertEvents(mockServer.loggedEvents, expectedEvents)

    // Check generated content is displayed in the source control input
    await expect(
        page.getByLabel('Source Control Input').getByText('hello from the assistant')
    ).toBeVisible()
})

test('commit message generation - cody ignore', async ({ page, sidebar }) => {
    // Sign into Cody
    await sidebarSignin(page, sidebar)

    // Open the Source Control view
    await page
        .getByLabel(/Source Control/)
        .nth(2)
        .click()

    // Check the change is showing as a Git change
    await page.getByRole('heading', { name: 'Source Control' }).hover()
    await page.getByText('ignored.js').hover()
    const gitChange = page.getByLabel(/ignored.js/).getByLabel('Stage Changes')
    await gitChange.hover()
    await expect(gitChange).toBeVisible()

    // Stage Git change
    await gitChange.click()

    // Activate the Cody commit message feature
    const generateCommitMessageCta = page.getByLabel('Generate Commit Message (Cody)')
    await generateCommitMessageCta.hover()
    await expect(generateCommitMessageCta).toBeVisible()
    await generateCommitMessageCta.click()

    const expectedEvents = [
        'CodyVSCodeExtension:command:generateCommitMessage:clicked',
        'CodyVSCodeExtension:command:generateCommitMessage:empty',
    ]
    await assertEvents(mockServer.loggedEvents, expectedEvents)

    // Check generated content is not displayed in the source control input
    await expect(
        page.getByLabel('Source Control Input').getByText('hello from the assistant')
    ).not.toBeVisible()
})

/** Run 'git' and wait for the process to exit. */
async function runGit(args: string[], options?: any) {
    const proc = spawn('git', args, options)
    return new Promise(resolve => proc.on('close', resolve))
}
