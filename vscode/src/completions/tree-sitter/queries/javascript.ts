import dedent from 'dedent'

import { SupportedLanguage } from '../grammars'
import type { QueryName } from '../queries'

const JS_BLOCKS_QUERY = dedent`
    (_ ("{") @block_start) @trigger

    [(try_statement)
    (if_statement)] @parents
`

/**
 * Incomplete code cases to cover:
 *
 * 1. call_expression: example(
 * 2. formal_parameters: function example(
 * 3. import_statement: import react
 * 4. lexical_declaration: const foo =
 *
 * The capture group name ending with "!" means this capture group does not require
 * a specific cursor position to match.
 *
 * TODO: classes, try/catch, members, if/else, loops, etc.
 * Tracking: https://github.com/sourcegraph/cody/issues/1456
 */
const JS_INTENTS_QUERY = dedent`
    ; Cursor dependent intents
    ;--------------------------------

    (function_declaration
        name: (identifier) @function.name!
        parameters: (formal_parameters ("(") @function.parameters.cursor) @function.parameters
        body: (statement_block ("{") @function.body.cursor) @function.body)

    (function
        name: (identifier) @function.name!
        parameters: (formal_parameters ("(") @function.parameters.cursor) @function.parameters
        body: (statement_block ("{") @function.body.cursor) @function.body)

    (arrow_function
        parameters: (formal_parameters ("(") @function.parameters.cursor) @function.parameters
        body: (statement_block ("{") @function.body.cursor) @function.body)

    (class_declaration
        name: (_) @class.name!
        body: (class_body ("{") @class.body.cursor) @class.body)

    (arguments ("(") @arguments.cursor) @arguments

    ; Atomic intents
    ;--------------------------------

    (import_statement
        source: (string) @import.source!)

    (comment) @comment!
    (arguments (_) @argument!)
    (formal_parameters) @parameters!
    (formal_parameters (_) @parameter!)
    (return_statement) @return_statement!
    (return_statement (_) @return_statement.value!)
`

const JSX_INTENTS_QUERY = dedent`
    ${JS_INTENTS_QUERY}

    (jsx_attribute (_) @jsx_attribute.value!)
`

const TS_INTENTS_QUERY = dedent`
    ${JS_INTENTS_QUERY}

    ; Cursor dependent intents
    ;--------------------------------

    (function_signature
        name: (identifier) @function.name!
        parameters: (formal_parameters ("(") @function.parameters.cursor) @function.parameters)

    (interface_declaration
        name: (type_identifier) @type_declaration.name!
        body: (object_type ("{") @type_declaration.body.cursor) @type_declaration.body)

    (type_alias_declaration
        name: (type_identifier) @type_declaration.name!
        value: (object_type ("{") @type_declaration.body.cursor) @type_declaration.body)
`

const TSX_INTENTS_QUERY = dedent`
    ${TS_INTENTS_QUERY}

    (jsx_attribute (_) @jsx_attribute.value!)
`

const TS_SINGLELINE_TRIGGERS_QUERY = dedent`
    (interface_declaration (object_type ("{") @block_start)) @trigger
    (type_alias_declaration (object_type ("{") @block_start)) @trigger
`

export const javascriptQueries = {
    [SupportedLanguage.JavaScript]: {
        blocks: JS_BLOCKS_QUERY,
        singlelineTriggers: '',
        intents: JS_INTENTS_QUERY,
    },
    [SupportedLanguage.JSX]: {
        blocks: JS_BLOCKS_QUERY,
        singlelineTriggers: '',
        intents: JSX_INTENTS_QUERY,
    },
    [SupportedLanguage.TypeScript]: {
        blocks: JS_BLOCKS_QUERY,
        singlelineTriggers: TS_SINGLELINE_TRIGGERS_QUERY,
        intents: TS_INTENTS_QUERY,
    },
    [SupportedLanguage.TSX]: {
        blocks: JS_BLOCKS_QUERY,
        singlelineTriggers: TS_SINGLELINE_TRIGGERS_QUERY,
        intents: TSX_INTENTS_QUERY,
    },
} satisfies Partial<Record<SupportedLanguage, Record<QueryName, string>>>
