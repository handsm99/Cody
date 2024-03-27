import { expect } from '@playwright/test'

import * as mockServer from '../fixtures/mock-server'

import { createEmptyChatPanel, sidebarSignin } from './common'
import { type DotcomUrlOverride, type ExpectedEvents, test as baseTest } from './helpers'

const test = baseTest.extend<DotcomUrlOverride>({ dotcomUrl: mockServer.SERVER_URL })

test.extend<ExpectedEvents>({
    // list of events we expect this test to log, add to this list as needed
    expectedEvents: [
        'CodyInstalled',
        'CodyVSCodeExtension:auth:clickOtherSignInOptions',
        'CodyVSCodeExtension:login:clicked',
        'CodyVSCodeExtension:auth:selectSigninMenu',
        'CodyVSCodeExtension:auth:fromToken',
        'CodyVSCodeExtension:Auth:connected',
        'CodyVSCodeExtension:chat-question:submitted',
        'CodyVSCodeExtension:chat-question:executed',
        'CodyVSCodeExtension:upsellUsageLimitCTA:shown',
    ],
})('shows upgrade rate limit message for free users', async ({ page, sidebar }) => {
    await fetch(`${mockServer.SERVER_URL}/.test/completions/triggerRateLimit/free`, {
        method: 'POST',
    })

    await sidebarSignin(page, sidebar)
    const [chatFrame, chatInput] = await createEmptyChatPanel(page)
    await chatInput.fill('test message')
    await chatInput.press('Enter')

    await expect(chatFrame.getByRole('heading', { name: 'Upgrade to Cody Pro' })).toBeVisible()
    await expect(chatFrame.getByRole('button', { name: 'Upgrade' })).toBeVisible()
})

test.extend<ExpectedEvents>({
    expectedEvents: [
        'CodyInstalled',
        'CodyVSCodeExtension:auth:clickOtherSignInOptions',
        'CodyVSCodeExtension:login:clicked',
        'CodyVSCodeExtension:auth:selectSigninMenu',
        'CodyVSCodeExtension:auth:fromToken',
        'CodyVSCodeExtension:Auth:connected',
        'CodyVSCodeExtension:chat-question:submitted',
        'CodyVSCodeExtension:chat-question:executed',
        'CodyVSCodeExtension:abuseUsageLimitCTA:shown',
    ],
})('shows standard rate limit message for pro users', async ({ page, sidebar }) => {
    await fetch(`${mockServer.SERVER_URL}/.test/completions/triggerRateLimit/pro`, {
        method: 'POST',
    })

    await sidebarSignin(page, sidebar)
    const [chatFrame, chatInput] = await createEmptyChatPanel(page)
    await chatInput.fill('test message')
    await chatInput.press('Enter')

    await expect(chatFrame.getByRole('heading', { name: 'Unable to Send Message' })).toBeVisible()
    await expect(chatFrame.getByRole('button', { name: 'Learn More' })).toBeVisible()
})

test.extend<ExpectedEvents>({
    expectedEvents: [
        'CodyInstalled',
        'CodyVSCodeExtension:auth:clickOtherSignInOptions',
        'CodyVSCodeExtension:login:clicked',
        'CodyVSCodeExtension:auth:selectSigninMenu',
        'CodyVSCodeExtension:auth:fromToken',
        'CodyVSCodeExtension:Auth:connected',
        'CodyVSCodeExtension:chat-question:submitted',
        'CodyVSCodeExtension:chat-question:executed',
        'CodyVSCodeExtension:abuseUsageLimitCTA:shown',
    ],
})('shows standard rate limit message for non-dotCom users', async ({ page, sidebar }) => {
    await fetch(`${mockServer.SERVER_URL}/.test/completions/triggerRateLimit`, {
        method: 'POST',
    })

    await sidebarSignin(page, sidebar)
    const [chatFrame, chatInput] = await createEmptyChatPanel(page)
    await chatInput.fill('test message')
    await chatInput.press('Enter')

    await expect(chatFrame.getByRole('heading', { name: 'Unable to Send Message' })).toBeVisible()
    await expect(chatFrame.getByRole('button', { name: 'Learn More' })).toBeVisible()
})
