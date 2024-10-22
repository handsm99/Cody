import { fixture as test, uix } from '../utils/vscody'
import { expect } from '../utils/vscody/uix'

test.describe('cody.at-mention', () => {
    const repoVariants: Array<'public' | 'private'> = ['public', 'private'] as const
    const endpointVariants: Array<'dotcom' | 'enterprise'> = ['dotcom', 'enterprise'] as const

    for (const repoVariant of repoVariants) {
        for (const endpointVariant of endpointVariants) {
            test(`mention events fire correctly for @${endpointVariant} in a @${repoVariant}-repo`, async ({
                page,
                mitmProxy,
                vscodeUI,
                workspaceDir,
                telemetryRecorder,
                polly,
                context,
            }, testInfo) => {
                // Behavior is described here:
                // https://linear.app/sourcegraph/issue/CODY-3405/fix-mention-telemetry

                await uix.workspace.gitInit(
                    {
                        origin:
                            repoVariant === 'private'
                                ? 'https://github.com/sourcegraph/private-invisible.git'
                                : 'https://github.com/sourcegraph/cody.git',
                    },
                    { workspaceDir }
                )

                if (endpointVariant === 'enterprise') {
                    mitmProxy.sourcegraph.enterprise.authName = 'enterprise'
                }
                const codyEndpoint = mitmProxy.sourcegraph[endpointVariant].endpoint

                const { vsc } = await uix.vscode.Session.startWithCody(
                    { page, vscodeUI, workspaceDir, polly },
                    { codyEndpoint }
                )

                await vsc.editor.openFile({
                    workspaceFile: 'buzz.ts',
                    selection: { start: { line: 3 }, end: { line: 5 } },
                })

                const telemetry = uix.telemetry.TelemetrySnapshot.fromNow({
                    telemetryRecorder,
                })
                await vsc.runCommand('cody.chat.newEditorPanel')
                const [chat] = await uix.cody.WebView.all(vsc, { atLeast: 1 })

                //TODO: make a nice UIX class for this
                const chatInput = chat.content.getByRole('textbox', { name: 'Chat message' })
                await expect(chatInput).toBeVisible()

                const initTelemetry = telemetry.snap()
                // We don't want to have any at mention events triggered by default.
                // They should only trigger if we actually show the mention-menu. we
                expect(
                    initTelemetry.filter({
                        matching: { feature: 'cody.at-mention', action: 'selected' },
                    })
                ).toEqual([])

                const atMenu = chat.content.locator('[data-at-mention-menu]')

                // We fill the query a few times to make sure we don't see double firings
                await test.step('Trigger and fill at-menu', async () => {
                    await chatInput.fill('@')
                    await expect(atMenu).toBeVisible()
                    await atMenu.locator('[data-value="provider:file"]').click()
                    await expect(
                        atMenu.locator('[data-value^="[\\"file\\""]').locator('[title="buzz.ts"]')
                    ).toBeVisible()
                    await chatInput.pressSequentially('error', { delay: 5 })
                    await expect(
                        atMenu.locator('[data-value^="[\\"file\\""]').locator('[title="error.ts"]')
                    ).toBeVisible()
                    for (let i = 0; i < 'error'.length; i++) {
                        await chatInput.press('Backspace')
                    }
                })

                const mentionTelemetry = telemetry.snap(initTelemetry)
                expect(
                    mentionTelemetry.filter({ matching: { action: 'executed' } }),
                    'Execution events should not have fired'
                ).toEqual([])
                const mentionEvents = mentionTelemetry.filter({
                    matching: { feature: 'cody.at-mention' },
                })
                await expect
                    .soft(mentionEvents)
                    .toMatchJSONSnapshot(`mentionedEvents.${endpointVariant}.${repoVariant}`, {
                        normalizers: snapshotNormalizers,
                    })

                await uix.mitm.withFloorResponseTime(120 * 1000, { mitmProxy }, async () => {
                    // we now ensure that the event did fire if we do select a file
                    await atMenu
                        .locator('[data-value^="[\\"file\\""]')
                        .locator('[title="buzz.ts"]')
                        .click()
                    await expect(atMenu).not.toBeVisible()
                    await chatInput.press('Enter')

                    // wait until the response is displayed
                    await expect(chat.content.locator('[data-testid="message"]').nth(2)).toBeVisible()
                    const selectTelemetry = telemetry.snap(mentionTelemetry)
                    expect(
                        selectTelemetry.filter({ matching: { feature: 'cody.at-mention' } }),
                        'No additional at-mention events to fire on actual selection'
                    ).toEqual([])
                    await expect
                        .soft(
                            selectTelemetry.filter({
                                matching: [{ feature: 'cody.chat-question' }],
                            })
                        )
                        .toMatchJSONSnapshot(
                            `responseRecievedEvents.${endpointVariant}.${repoVariant}`,
                            {
                                normalizers: snapshotNormalizers,
                            }
                        )
                })
            })
        }
    }
})

const snapshotNormalizers = [
    uix.snapshot.Normalizers.pick('event', 'proxyName'),
    uix.snapshot.Normalizers.sortKeysDeep,
    uix.snapshot.Normalizers.sortPathBy('event.parameters.metadata', 'key'),
    uix.snapshot.Normalizers.blank(
        'event.source.clientVersion',
        'event.timestamp',
        'event.parameters.privateMetadata.requestID',
        'event.parameters.interactionID',
        'event.parameters.privateMetadata.sessionID',
        'event.parameters.privateMetadata.traceId',
        'event.parameters.privateMetadata.chatModel',
        'event.parameters.privateMetadata.promptText',
        'event.parameters.privateMetadata.responseText',
        'event.parameters.privateMetadata.gitMetadata'
    ),
]
