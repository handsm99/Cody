import { expect } from '@playwright/test'

import { sidebarSignin } from './common'
import { test } from './helpers'

test('editing follow-up messages in chat view', async ({ page, sidebar }) => {
    await sidebarSignin(page, sidebar)

    await page.getByRole('button', { name: 'New Chat', exact: true }).click()

    const chatFrame = page.frameLocator('iframe.webview').last().frameLocator('iframe')
    const chatInput = chatFrame.getByRole('textbox', { name: 'Chat message' })

    // Chat Action Buttons - above the input box
    const editLastMessageButton = chatFrame.getByRole('button', { name: /^Edit Last Message / })
    const newChatButton = chatFrame.getByRole('button', { name: /^New Chat / })
    const cancelEditButton = chatFrame.getByTitle('Cancel Edit')

    // Chat Submit Buttons - on the left of the input box
    const updateMessageButton = chatFrame.getByTitle('Update Message')
    const submitMessageButton = chatFrame.getByTitle('Send Message')
    const startNewChatButton = chatFrame.getByTitle('Start New Chat')

    // Submit three new messages
    await chatInput.fill('One')
    await chatInput.press('Enter')
    await chatInput.fill('Two')
    await chatInput.press('Enter')
    await chatInput.fill('Three')
    await chatInput.press('Enter')

    // Three edit buttons should show up, one per each message submitted
    const editButtons = chatFrame.locator('.codicon-edit')
    await expect(editButtons).toHaveCount(3)

    // Click on the first edit button to get into the editing mode
    // The text area should automatically get the focuse,
    // and contains the original message text,
    // The submit button will also be replaced with "Update Message" button
    await editButtons.nth(0).click()
    await expect(chatInput).toBeFocused()
    await expect(chatInput).toHaveValue('One')
    await expect(updateMessageButton).toBeVisible()
    await expect(submitMessageButton).not.toBeVisible()

    // Only 1 cancel button should be displayed above the input box
    // All the edit buttons will be invisible during editing
    await expect(cancelEditButton).toHaveCount(1)
    await expect(editButtons).toHaveCount(0)

    // Pressing escape should exit editing mode,
    // edit buttons should up on each message again
    // and the main chat input box should automatically get the focus back
    await page.keyboard.press('Escape')
    await expect(cancelEditButton).not.toBeVisible()
    await expect(chatInput).toBeFocused()
    await expect(chatFrame.locator('.codicon-edit')).toHaveCount(3)

    // click on the second edit button to get into the editing mode again
    // edit the message from "Two" to "Four"
    await chatFrame.locator('.codicon-edit').nth(1).click()
    // the original message text should shows up in the text box
    await expect(chatInput).toHaveValue('Two')
    await chatInput.click()
    await chatInput.fill('Four')
    await page.keyboard.press('Enter')

    // Only two messages are left after the edit (e.g. "One", "Four"),
    // as all the messages after the edited message have be removed
    await expect(chatFrame.locator('.codicon-edit')).toHaveCount(2)
    await expect(chatFrame.getByText('One')).toBeVisible()
    await expect(chatFrame.getByText('Two')).not.toBeVisible()
    await expect(chatFrame.getByText('Three')).not.toBeVisible()
    await expect(chatFrame.getByText('Four')).toBeVisible()

    // When not in editing mode, there are two buttons above the input box
    // Edit Last Message button and New Chat button
    await expect(editLastMessageButton).toBeVisible()
    await expect(newChatButton).toBeVisible()

    // "MetaKey(MacOS)/Control" + "K" should enter the editing mode on the last message
    await chatInput.press('Meta+k')
    await expect(chatInput).toHaveValue('Four')
    // There should be no "New Chat" action button in editing mode
    // But will show up again after exiting editing mode
    await expect(newChatButton).not.toBeVisible()
    await chatInput.press('Escape')
    await expect(newChatButton).toBeVisible()

    // At-file should work in the edit mode
    await chatInput.press('Meta+k')
    await expect(chatInput).toHaveValue('Four')
    await chatInput.fill('Explain @mj')
    await expect(chatInput).not.toHaveValue('Four')
    await expect(chatFrame.getByRole('button', { name: 'Main.java' })).toBeVisible()
    await chatInput.press('Tab')
    await expect(chatInput).toHaveValue('Explain @Main.java ')

    // Enter should submit the message and exit editing mode
    // The last message should be "Explain @Main.java"
    // With input box emptied with no cancel button
    await chatInput.press('Enter')
    await expect(cancelEditButton).not.toBeVisible()
    await expect(chatInput).toBeEmpty()
    await expect(chatFrame.getByText('Explain @Main.java')).toBeVisible()
    await chatInput.press('Escape')

    // "MetaKey(MacOS)/Control" + "Shift" to toggle "New Chat Mode" on and off
    // When it's on, the submit button will be replaced with "Start New Chat" button
    await expect(submitMessageButton).toBeVisible()
    await chatInput.press('Meta+Shift')
    await expect(submitMessageButton).not.toBeVisible()
    await expect(startNewChatButton).toBeVisible()
    await chatInput.press('Meta+Shift')
    await expect(startNewChatButton).not.toBeVisible()
    await chatInput.press('Meta+Shift')
    await expect(startNewChatButton).toBeVisible()

    // With "New Chat Mode" enabled,  submit a new message to start a new chat
    // The new message should be "The End"
    // And the last message should not be visible anymore
    await chatInput.fill('The End')
    await chatInput.press('Enter')
    await expect(chatFrame.getByText('The End')).toBeVisible()
    await expect(chatFrame.getByText('Explain @Main.java')).not.toBeVisible()

    // Meta+/ also creates a new chat session
    await chatInput.press('Meta+/')
    await expect(chatFrame.getByText('The End')).not.toBeVisible()
})
