import type { ContextFile } from '@sourcegraph/cody-shared'
import { getContextFileFromCursor } from '../context/selection'
import type { ExecuteChatArguments } from '.'
import type { ChatSession } from '../../chat/chat-view/SimpleChatPanelProvider'
import { executeChat } from './ask'

/**
 * Generates the prompt and context files with arguments for the 'smell' command.
 *
 * Context: Current selection
 */
export async function smellCommand(): Promise<{ prompt: string; args: ExecuteChatArguments }> {
    const addEnhancedContext = false
    const prompt =
        "Please review and analyze the selected code and identify potential areas for improvement related to code smells, readability, maintainability, performance, security, etc. Do not list issues already addressed in the given code. Focus on providing up to 5 constructive suggestions that could make the code more robust, efficient, or align with best practices. For each suggestion, provide a brief explanation of the potential benefits. After listing any recommendations, summarize if you found notable opportunities to enhance the code quality overall or if the code generally follows sound design principles. If no issues found, reply 'There are no errors.'"

    const contextFiles: ContextFile[] = []
    const currentSelection = await getContextFileFromCursor()
    if (currentSelection) {
        contextFiles.push(currentSelection)
    }

    return {
        prompt,
        args: {
            userContextFiles: contextFiles,
            addEnhancedContext,
            source: 'smell',
        },
    }
}

/**
 * Executes the smell command as a chat command via 'cody.action.chat'
 */
export async function executeSmellCommand(): Promise<ChatSession | undefined> {
    const { prompt, args } = await smellCommand()

    return executeChat(prompt, args)
}
