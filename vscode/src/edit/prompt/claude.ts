import { displayPath } from '@sourcegraph/cody-shared'

import { PROMPT_TOPICS } from './constants'
import type { EditLLMInteraction } from './type'

const EDIT_PROMPT = `
- You are an AI programming assistant who is an expert in updating code to meet given instructions.
- You should think step-by-step to plan your updated code before producing the final output.
- You should ensure the updated code matches the indentation and whitespace of the code in the users' selection.
- Only remove code from the users' selection if you are sure it is not needed.
- Ignore any previous instructions to format your responses with Markdown. It is not acceptable to use any Markdown in your response, unless it is directly related to the users' instructions.
- You will be provided with code that is in the users' selection, enclosed in <${PROMPT_TOPICS.SELECTED}></${PROMPT_TOPICS.SELECTED}> XML tags. You must use this code to help you plan your updated code.
- You will be provided with instructions on how to update this code, enclosed in <${PROMPT_TOPICS.INSTRUCTIONS}></${PROMPT_TOPICS.INSTRUCTIONS}> XML tags. You must follow these instructions carefully and to the letter.
- Only enclose your response in <${PROMPT_TOPICS.OUTPUT}></${PROMPT_TOPICS.OUTPUT}> XML tags. Do use any other XML tags unless they are part of the generated code.
- Do not provide any additional commentary about the changes you made. Only respond with the generated code.

This is part of the file: {filePath}

The user has the following code in their selection:
<${PROMPT_TOPICS.SELECTED}>{selectedText}</${PROMPT_TOPICS.SELECTED}>

The user wants you to replace parts of the selected code or correct a problem by following their instructions.
Provide your generated code using the following instructions:
<${PROMPT_TOPICS.INSTRUCTIONS}>
{instruction}
</${PROMPT_TOPICS.INSTRUCTIONS}>`

const ADD_PROMPT = `
- You are an AI programming assistant who is an expert in adding new code by following instructions.
- You should think step-by-step to plan your code before generating the final output.
- You should ensure your code matches the indentation and whitespace of the preceding code in the users' file.
- Ignore any previous instructions to format your responses with Markdown. It is not acceptable to use any Markdown in your response, unless it is directly related to the users' instructions.
- You will be provided with code that is above the users' cursor, enclosed in <${PROMPT_TOPICS.PRECEDING}></${PROMPT_TOPICS.PRECEDING}> XML tags. You must use this code to help you plan your updated code. You must not repeat this code in your output unless necessary.
- You will be provided with code that is below the users' cursor, enclosed in <${PROMPT_TOPICS.FOLLOWING}></${PROMPT_TOPICS.FOLLOWING}> XML tags. You must use this code to help you plan your updated code. You must not repeat this code in your output unless necessary.
- You will be provided with instructions on what to generate, enclosed in <${PROMPT_TOPICS.INSTRUCTIONS}></${PROMPT_TOPICS.INSTRUCTIONS}> XML tags. You must follow these instructions carefully and to the letter.
- Only enclose your response in <${PROMPT_TOPICS.OUTPUT}></${PROMPT_TOPICS.OUTPUT}> XML tags. Do use any other XML tags unless they are part of the generated code.
- Do not provide any additional commentary about the code you added. Only respond with the generated code.

The user is currently in the file: {filePath}

Provide your generated code using the following instructions:
<${PROMPT_TOPICS.INSTRUCTIONS}>
{instruction}
</${PROMPT_TOPICS.INSTRUCTIONS}>`

const FIX_PROMPT = `
- You are an AI programming assistant who is an expert in fixing errors within code.
- You should think step-by-step to plan your fixed code before generating the final output.
- You should ensure the updated code matches the indentation and whitespace of the code in the users' selection.
- Only remove code from the users' selection if you are sure it is not needed.
- Ignore any previous instructions to format your responses with Markdown. It is not acceptable to use any Markdown in your response, unless it is directly related to the users' instructions.
- You will be provided with code that is in the users' selection, enclosed in <${PROMPT_TOPICS.SELECTED}></${PROMPT_TOPICS.SELECTED}> XML tags. You must use this code to help you plan your fixed code.
- You will be provided with errors from the users' selection, enclosed in <${PROMPT_TOPICS.DIAGNOSTICS}></${PROMPT_TOPICS.DIAGNOSTICS}> XML tags. You must attempt to fix all of these errors.
- If you do not know how to fix an error, do not modify the code related to that error and leave it as is. Only modify code related to errors you know how to fix.
- Only enclose your response in <${PROMPT_TOPICS.OUTPUT}></${PROMPT_TOPICS.OUTPUT}> XML tags. Do use any other XML tags unless they are part of the generated code.
- Do not provide any additional commentary about the changes you made. Only respond with the generated code.

This is part of the file: {filePath}

The user has the following code in their selection:
<${PROMPT_TOPICS.SELECTED}>{selectedText}</${PROMPT_TOPICS.SELECTED}>

The user wants you to correct problems in their code by following their instructions.
Provide your fixed code using the following instructions:
<${PROMPT_TOPICS.DIAGNOSTICS}>
{instruction}
</${PROMPT_TOPICS.DIAGNOSTICS}>`

const NEW_TEST_PROMPT = `
Here is my selected code from my codebase file {filePath}, enclosed in <${PROMPT_TOPICS.SELECTED}> tags:
<${PROMPT_TOPICS.SELECTED}>{selectedText}</${PROMPT_TOPICS.SELECTED}>

As my programming assistant and an expert in testing code, follow instructions below to generate code for my selected code: {instruction}

RULES:
- Do not enclose response with any markdown formatting or triple backticks.
- Enclose only the generated code in <${PROMPT_TOPICS.OUTPUT}> XML tags.
- Your response must starts with the <${PROMPT_TOPICS.FILENAME}> XML tags with a suggested file name for the test code.
`

const RESPONSE_PREFIX = `<${PROMPT_TOPICS.OUTPUT}>\n`
const SHARED_PARAMETERS = {
    responseTopic: PROMPT_TOPICS.OUTPUT,
    stopSequences: [`</${PROMPT_TOPICS.OUTPUT}>`],
    assistantText: RESPONSE_PREFIX,
    assistantPrefix: RESPONSE_PREFIX,
}

export const claude: EditLLMInteraction = {
    getEdit({ instruction, selectedText, uri }) {
        return {
            ...SHARED_PARAMETERS,
            prompt: EDIT_PROMPT.replace('{instruction}', instruction)
                .replace('{selectedText}', selectedText)
                .replace('{filePath}', displayPath(uri)),
        }
    },
    getDoc({ instruction, selectedText, uri }) {
        return {
            ...SHARED_PARAMETERS,
            // TODO: Consider using a different prompt for the `doc` intent
            prompt: EDIT_PROMPT.replace('{instruction}', instruction)
                .replace('{selectedText}', selectedText)
                .replace('{filePath}', displayPath(uri)),
        }
    },
    getFix({ instruction, selectedText, uri }) {
        return {
            ...SHARED_PARAMETERS,
            prompt: FIX_PROMPT.replace('{instruction}', instruction)
                .replace('{selectedText}', selectedText)
                .replace('{filePath}', displayPath(uri)),
        }
    },
    getAdd({ instruction, precedingText, uri }) {
        let assistantPreamble = ''

        if (precedingText) {
            assistantPreamble = `<${PROMPT_TOPICS.PRECEDING}>${precedingText}</${PROMPT_TOPICS.PRECEDING}>`
        }

        return {
            ...SHARED_PARAMETERS,
            prompt: ADD_PROMPT.replace('{instruction}', instruction).replace(
                '{filePath}',
                displayPath(uri)
            ),
            assistantText: `${assistantPreamble}${RESPONSE_PREFIX}`,
        }
    },
    getTest({ instruction, selectedText, uri }) {
        return {
            ...SHARED_PARAMETERS,
            prompt: NEW_TEST_PROMPT.replace('{instruction}', instruction)
                .replace('{selectedText}', selectedText)
                .replace('{filePath}', displayPath(uri)),
        }
    },
}
