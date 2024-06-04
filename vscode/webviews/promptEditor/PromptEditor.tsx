import { $isRootTextContentEmpty } from '@lexical/text'
import type { ChatMessage, ContextItem } from '@sourcegraph/cody-shared'
import { clsx } from 'clsx'
import {
    $createTextNode,
    $getRoot,
    $getSelection,
    $insertNodes,
    type LexicalEditor,
    type SerializedEditorState,
    type SerializedRootNode,
} from 'lexical'
import type { EditorState, SerializedLexicalNode } from 'lexical'
import { type FunctionComponent, useCallback, useEffect, useImperativeHandle, useRef } from 'react'
import type { UserAccountInfo } from '../Chat'
import {
    isEditorContentOnlyInitialContext,
    lexicalNodesForContextItems,
} from '../chat/cells/messageCell/human/editor/initialContext'
import { BaseEditor, editorStateToText } from './BaseEditor'
import styles from './PromptEditor.module.css'
import {
    type SerializedContextItem,
    deserializeContextItem,
    isSerializedContextItemMentionNode,
    serializeContextItem,
} from './nodes/ContextItemMentionNode'
import type { KeyboardEventPluginProps } from './plugins/keyboardEvent'

interface Props extends KeyboardEventPluginProps {
    userInfo?: UserAccountInfo
    editorClassName?: string
    contentEditableClassName?: string
    seamless?: boolean

    placeholder?: string

    initialEditorState?: SerializedPromptEditorState
    onChange?: (value: SerializedPromptEditorValue) => void
    onFocusChange?: (focused: boolean) => void

    disabled?: boolean

    editorRef?: React.RefObject<PromptEditorRefAPI>
}

export interface PromptEditorRefAPI {
    getSerializedValue(): SerializedPromptEditorValue
    setFocus(focus: boolean, options?: { moveCursorToEnd?: boolean; scrollTo?: boolean }): void
    appendText(text: string, ensureWhitespaceBefore?: boolean): void
    addMentions(items: ContextItem[]): void
    setInitialContextMentions(items: ContextItem[]): void
    isEmpty(): boolean
}

/**
 * The component for composing and editing prompts.
 */
export const PromptEditor: FunctionComponent<Props> = ({
    userInfo,
    editorClassName,
    contentEditableClassName,
    seamless,
    placeholder,
    initialEditorState,
    onChange,
    onFocusChange,
    disabled,
    editorRef: ref,
    onEnterKey,
}) => {
    const editorRef = useRef<LexicalEditor>(null)

    const hasSetInitialContext = useRef(false)
    useImperativeHandle(
        ref,
        (): PromptEditorRefAPI => ({
            getSerializedValue(): SerializedPromptEditorValue {
                if (!editorRef.current) {
                    throw new Error('PromptEditor has no Lexical editor ref')
                }
                return toSerializedPromptEditorValue(editorRef.current)
            },
            setFocus(focus, { moveCursorToEnd, scrollTo } = {}): void {
                const editor = editorRef.current
                if (editor) {
                    if (focus) {
                        editor.update(
                            () => {
                                const selection = $getSelection()
                                const root = $getRoot()

                                // Copied from LexicalEditor#focus, but we need to set the
                                // `skip-scroll-into-view` tag so that we don't always autoscroll.
                                if (selection !== null) {
                                    selection.dirty = true
                                } else if (root.getChildrenSize() !== 0) {
                                    root.selectEnd()
                                }

                                if (moveCursorToEnd) {
                                    root.selectEnd()
                                }

                                // Ensure element is focused in case the editor is empty. Copied
                                // from LexicalAutoFocusPlugin.
                                const doFocus = () =>
                                    editor.getRootElement()?.focus({ preventScroll: !scrollTo })
                                doFocus()

                                // HACK(sqs): Needed in VS Code webviews to actually get it to focus
                                // on initial load, for some reason.
                                setTimeout(doFocus)
                            },
                            !scrollTo ? { tag: 'skip-scroll-into-view' } : undefined
                        )
                    } else {
                        editor.blur()
                    }
                }
            },
            appendText(text: string, ensureWhitespaceBefore?: boolean): void {
                editorRef.current?.update(() => {
                    const root = $getRoot()
                    const needsWhitespaceBefore = !/(^|\s)$/.test(root.getTextContent())
                    root.selectEnd()
                    $insertNodes([
                        $createTextNode(
                            `${ensureWhitespaceBefore && needsWhitespaceBefore ? ' ' : ''}${text}`
                        ),
                    ])
                    root.selectEnd()
                })
            },
            addMentions(items: ContextItem[]) {
                editorRef.current?.update(() => {
                    const nodesToInsert = lexicalNodesForContextItems(items, {
                        isFromInitialContext: false,
                    })
                    $insertNodes([$createTextNode(' '), ...nodesToInsert])
                    nodesToInsert.at(-1)?.select()
                })
            },
            setInitialContextMentions(items: ContextItem[]) {
                const editor = editorRef.current
                if (!editor) {
                    return
                }

                editor.update(() => {
                    if (!hasSetInitialContext.current || isEditorContentOnlyInitialContext(editor)) {
                        $getRoot().clear()
                        const nodesToInsert = lexicalNodesForContextItems(items, {
                            isFromInitialContext: true,
                        })
                        $insertNodes(nodesToInsert)

                        const nodeToSelect = nodesToInsert.at(-1)
                        nodeToSelect?.select()

                        hasSetInitialContext.current = true
                    }
                })
            },
            isEmpty(): boolean {
                if (!editorRef.current) {
                    throw new Error('PromptEditor has no Lexical editor ref')
                }
                return editorRef.current.getEditorState().read(() => {
                    const root = $getRoot()
                    if (root.getChildrenSize() === 0) {
                        return true
                    }
                    return $isRootTextContentEmpty(false, true)
                })
            },
        }),
        []
    )

    const onBaseEditorChange = useCallback(
        (_editorState: EditorState, editor: LexicalEditor): void => {
            if (onChange) {
                onChange(toSerializedPromptEditorValue(editor))
            }
        },
        [onChange]
    )

    useEffect(() => {
        if (initialEditorState) {
            const editor = editorRef.current
            if (editor) {
                const newEditorState = editor.parseEditorState(initialEditorState.lexicalEditorState)
                editor.setEditorState(newEditorState)
            }
        }
    }, [initialEditorState])

    return (
        <BaseEditor
            userInfo={userInfo}
            className={clsx(styles.editor, editorClassName, {
                [styles.disabled]: disabled,
                [styles.seamless]: seamless,
            })}
            contentEditableClassName={contentEditableClassName}
            initialEditorState={initialEditorState?.lexicalEditorState ?? null}
            onChange={onBaseEditorChange}
            onFocusChange={onFocusChange}
            editorRef={editorRef}
            placeholder={placeholder}
            disabled={disabled}
            aria-label="Chat message"
            onEnterKey={onEnterKey}
        />
    )
}

export interface SerializedPromptEditorValue {
    /** The editor's value as plain text. */
    text: string

    /** The context items mentioned in the value. */
    contextItems: ContextItem[]

    /** The internal state of the editor that can be used to restore the editor. */
    editorState: SerializedPromptEditorState
}

export function toSerializedPromptEditorValue(editor: LexicalEditor): SerializedPromptEditorValue {
    const editorState = toPromptEditorState(editor)
    return {
        text: editorStateToText(editor.getEditorState()),
        contextItems: contextItemsFromPromptEditorValue(editorState).map(deserializeContextItem),
        editorState,
    }
}

/**
 * This version string is stored in {@link SerializedPromptEditorState} to indicate the schema
 * version of the value.
 *
 * This code must preserve (1) backward-compatibility, so that values written by older versions can
 * be read by newer versions and (2) forward-compatibility, so that values written by newer versions
 * can be partially read by older versions (such as supporting the text but not rich formatting).
 *
 * If you need to make a breaking change to the {@link SerializedPromptEditorState} schema, follow
 * these guidelines and consult with a tech lead first. There should be a period of time (at least 1
 * month) where both the old and new schemas are supported for reading, and the old schema is
 * written. Then you can switch to having it write the new schema (knowing that even clients ~1
 * month old can read that schema).
 */
const STATE_VERSION_CURRENT = 'lexical-v0' as const

/**
 * The representation of a user's prompt input in the chat view.
 */
export interface SerializedPromptEditorState {
    /**
     * Version identifier for this type. If this type changes, the version identifier must change,
     * and callers must check this value to ensure they are working with the correct type.
     */
    v: typeof STATE_VERSION_CURRENT

    /**
     * The [Lexical editor state](https://lexical.dev/docs/concepts/editor-state).
     */
    lexicalEditorState: SerializedEditorState
}

function toPromptEditorState(editor: LexicalEditor): SerializedPromptEditorState {
    const editorState = editor.getEditorState()
    return {
        v: STATE_VERSION_CURRENT,
        lexicalEditorState: editorState.toJSON(),
    }
}

/**
 * This treats the entire text as plain text and does not parse it for any @-mentions.
 */
export function serializedPromptEditorStateFromText(text: string): SerializedPromptEditorState {
    const editorState: SerializedEditorState = {
        root: {
            children: [
                {
                    children: [
                        {
                            detail: 0,
                            format: 0,
                            mode: 'normal',
                            style: '',
                            text,
                            type: 'text',
                            version: 1,
                        },
                    ],
                    direction: 'ltr',
                    format: '',
                    indent: 0,
                    type: 'paragraph',
                    version: 1,
                } as SerializedLexicalNode,
            ],
            direction: 'ltr',
            format: '',
            indent: 0,
            type: 'root',
            version: 1,
        },
    }
    return {
        v: STATE_VERSION_CURRENT,
        lexicalEditorState: editorState,
    }
}

export function serializedPromptEditorStateFromChatMessage(
    chatMessage: ChatMessage
): SerializedPromptEditorState {
    function isCurrentVersionEditorState(value: unknown): value is SerializedPromptEditorState {
        return Boolean(value) && (value as any).v === STATE_VERSION_CURRENT
    }

    if (isCurrentVersionEditorState(chatMessage.editorState)) {
        return chatMessage.editorState
    }

    // Fall back to using plain text for chat messages that don't have a serialized Lexical editor
    // state that we recognize.
    //
    // It would be smoother to automatically import or convert textual @-mentions to the Lexical
    // mention nodes, but that would add a lot of extra complexity for the relatively rare use case
    // of editing old messages in your chat history.
    return serializedPromptEditorStateFromText(chatMessage.text ? chatMessage.text.toString() : '')
}

export function contextItemsFromPromptEditorValue(
    state: SerializedPromptEditorState
): SerializedContextItem[] {
    const contextItems: SerializedContextItem[] = []

    if (state.lexicalEditorState) {
        const queue: SerializedLexicalNode[] = [state.lexicalEditorState.root]
        while (queue.length > 0) {
            const node = queue.shift()
            if (node && 'children' in node && Array.isArray(node.children)) {
                for (const child of node.children as SerializedLexicalNode[]) {
                    if (isSerializedContextItemMentionNode(child)) {
                        contextItems.push(child.contextItem)
                    }
                    queue.push(child)
                }
            }
        }
    }

    return contextItems
}

export function filterContextItemsFromPromptEditorValue(
    value: SerializedPromptEditorValue,
    keep: (item: SerializedContextItem) => boolean
): SerializedPromptEditorValue {
    const editorState: typeof value.editorState.lexicalEditorState = JSON.parse(
        JSON.stringify(value.editorState.lexicalEditorState)
    )
    const queue: SerializedLexicalNode[] = [editorState.root]
    while (queue.length > 0) {
        const node = queue.shift()
        if (node && 'children' in node && Array.isArray(node.children)) {
            node.children = node.children.filter(child =>
                isSerializedContextItemMentionNode(child) ? keep(child.contextItem) : true
            )
            for (const child of node.children as SerializedLexicalNode[]) {
                queue.push(child)
            }
        }
    }

    function getTextContent(root: SerializedRootNode): string {
        const text: string[] = []
        const queue: SerializedLexicalNode[] = [root]
        while (queue.length > 0) {
            const node = queue.shift()!
            if ('text' in node && typeof node.text === 'string') {
                text.push(node.text)
            }
            if (node && 'children' in node && Array.isArray(node.children)) {
                for (const child of node.children as SerializedLexicalNode[]) {
                    queue.push(child)
                }
            }
        }
        return text.join('')
    }

    return {
        ...value,
        editorState: {
            ...value.editorState,
            lexicalEditorState: editorState,
        },
        text: getTextContent(editorState.root),
        contextItems: value.contextItems.filter(item => keep(serializeContextItem(item))),
    }
}
