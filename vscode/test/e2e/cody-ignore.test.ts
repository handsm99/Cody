import { expect } from '@playwright/test'
import path from 'path'
import { sidebarExplorer, sidebarSignin } from './common'
import { test } from './helpers'

/**
 * NOTE: .cody/ignore current supports behind 'cody.internal.unstable' flag
 *
 * End-to-end test for Cody behavior when files are ignored.
 *
 * Tests that Cody commands and chat do not work on ignored files,
 * and ignored files are not included in chat context.
 */
test('chat and command do not work in .cody/ignore file', async ({ page, sidebar }) => {
    // Sign into Cody
    await sidebarSignin(page, sidebar)

    // Open the file that is on the .cody/ignore list from the tree view
    await sidebarExplorer(page).click()
    await page.getByRole('treeitem', { name: 'ignoredByCody.css' }).locator('a').dblclick()
    await page.getByRole('tab', { name: 'ignoredByCody.css' }).hover()

    // Open Cody sidebar to start a new chat
    await page.click('.badge[aria-label="Cody"]')
    await page.getByRole('button', { name: 'New Chat', exact: true }).click()

    /* TEST: Chat Context - Ignored file do not show up with context */
    const chatPanel = page.frameLocator('iframe.webview').last().frameLocator('iframe')
    const chatInput = chatPanel.getByRole('textbox', { name: 'Chat message' })
    await chatInput.focus()
    await chatInput.fill('Ignore me')
    await chatInput.press('Enter')
    // Assistant should response to your chat question,
    // but the current file is excluded (ignoredByCody.css) and not on the context list
    await expect(chatPanel.getByText('hello from the assistant')).toBeVisible()
    expect(await chatPanel.getByText(/^✨ Context:/).count()).toEqual(0)

    /* TEST: At-file - Ignored file does not show up as context when using @-mention */
    await chatInput.focus()
    await chatInput.clear()
    await chatInput.fill('@ignoredByCody')
    await expect(chatPanel.getByRole('heading', { name: 'No matching files found' })).toBeVisible()
    await chatInput.clear()
    await chatInput.fill('@ignore')
    await expect(
        chatPanel.getByRole('button', { name: withPlatformSlashes('.cody/ignore') })
    ).toBeVisible()
    await expect(chatPanel.getByRole('button', { name: 'ignoredByCody.css' })).not.toBeVisible()

    /* TEST: Command - Ignored file do not show up with context */
    await page.getByText('Explain code').hover()
    await page.getByText('Explain code').click()
    // Assistant should response to your command,
    // but the current file is excluded (ignoredByCody.css) and not on the context list
    await expect(chatPanel.getByText('hello from the assistant')).toBeVisible()
    // TODO bee update current behavior to following:
    // A system message shows up to notify users that the file is ignored
    // await expect(page.getByText(/^Current file is ignored/)).toBeVisible()
})

function withPlatformSlashes(input: string) {
    return input.replaceAll(path.posix.sep, path.sep)
}
