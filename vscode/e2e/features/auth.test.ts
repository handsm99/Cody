import { expect } from '@playwright/test'
import { fixture as test, uix } from '../utils/vscody'
import { MITM_AUTH_TOKEN_PLACEHOLDER } from '../utils/vscody/constants'

test.describe('Auth', () => {
    test('normal auth flow - desktop', async ({ page, vscodeUI, mitmProxy, workspaceDir }, testInfo) => {
        const vsc = uix.vscode.Session.pending({ page, vscodeUI, workspaceDir })
        const cody = uix.cody.Extension.with({ page, workspaceDir })

        await test.step('setup', async () => {
            await vsc.start()
            await cody.waitUntilReady()
        })

        await vsc.runCommand('workbench.view.extension.cody')
        const [sidebar] = await uix.cody.WebView.all({ page }, { atLeast: 1 })
        await sidebar.content
            .getByRole('button', { name: 'Sign In to Your Enterprise Instance' })
            .click()

        await expect(vsc.QuickPick.locator).toBeVisible()
        await vsc.QuickPick.items({ hasText: 'Sign in with URL and Access Token' }).click()
        await vsc.QuickPick.input.fill(mitmProxy.sourcegraph.dotcom.endpoint)
        await vsc.QuickPick.input.press('Enter')
        await expect(vsc.QuickPick.input).toHaveAttribute('placeholder', 'Access Token')
        await vsc.QuickPick.input.fill(MITM_AUTH_TOKEN_PLACEHOLDER)

        await vsc.QuickPick.input.press('Enter')
        await sidebar.content.getByTestId('tab-account').click()
        await expect(page.getByText('Signed in as SourcegraphBot')).toBeVisible()
        await expect(page.getByText('Plan: Cody Pro')).toBeVisible()

        await page.getByText('Sign Out').click()
        await expect(sidebar.content.getByText('Sign In To Your Enterprise Instance')).toBeVisible()

        //TODO: Intercept network call to verify logout happened
    })

    // TODO: verify telemetry events
    // TODO: Anonymous User ID
    // TODO: OAuth Providers
    // TODO: Normal auth flow simplified
})