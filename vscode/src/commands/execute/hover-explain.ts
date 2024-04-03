import { displayPath, logDebug } from '@sourcegraph/cody-shared'
import { DefaultChatCommands } from '@sourcegraph/cody-shared/src/commands/types'
import type { ChatCommandResult } from '../../main'
import { telemetryService } from '../../services/telemetry'
import { telemetryRecorder } from '../../services/telemetry-v2'
import type { CodyCommandArgs } from '../types'
import { type ExecuteChatArguments, executeChat } from './ask'

import { wrapInActiveSpan } from '@sourcegraph/cody-shared/src/tracing'
import { getContextFileFromUri } from '../context/file-path'
import { getContextFileFromCursor } from '../context/selection'

async function hoverChatCommand(args: Partial<CodyCommandArgs>): Promise<ExecuteChatArguments> {
    const { uri, range, additionalInstruction } = args

    if (!uri) {
        throw new Error('No URI provided for the hover command')
    }

    const contextFiles = [...(await getContextFileFromUri(uri, range))]
    contextFiles.push(...(await getContextFileFromCursor(range?.start)))

    const startLine = range?.start?.line ?? 0
    const prompt = `Summarize @${displayPath(uri)}${startLine ? ':' + startLine : ''}${
        additionalInstruction ? `${additionalInstruction}` : ''
    }`

    return {
        text: prompt,
        submitType: 'user-newchat',
        contextFiles,
        addEnhancedContext: false,
        source: DefaultChatCommands.Hover,
    }
}

/**
 * Executes the hover command
 */
export async function executeHoverChatCommand(
    args: Partial<CodyCommandArgs>
): Promise<ChatCommandResult | undefined> {
    return wrapInActiveSpan('command.hover', async span => {
        span.setAttribute('sampled', true)
        logDebug('hoverChatCommand', 'executing', { args })
        telemetryService.log('CodyVSCodeExtension:command:hover:executed', {
            useCodebaseContex: false,
            requestID: args?.requestID,
            source: args?.source,
            traceId: span.spanContext().traceId,
        })
        telemetryRecorder.recordEvent('cody.command.hover', 'executed', {
            metadata: {
                useCodebaseContex: 0,
            },
            interactionID: args?.requestID,
            privateMetadata: {
                requestID: args?.requestID,
                source: args?.source,
                traceId: span.spanContext().traceId,
            },
        })

        return {
            type: 'chat',
            session: await executeChat(await hoverChatCommand(args)),
        }
    })
}
