import * as vscode from 'vscode'
import type { ChatEventSource, ContextFile } from '@sourcegraph/cody-shared'

import * as defaultCommands from '../../commands/prompt/cody.json'
import type { EditSupportedModels } from '../prompt'
import { getEditor } from '../../editor/active-editor'
import { getLabelForContextFile, getTitleRange, removeAfterLastAt } from './utils'
import { type TextChange, updateRangeMultipleChanges } from '../../non-stop/tracked-range'
import { getEditMaximumSelection, getEditSmartSelection } from '../utils/edit-selection'
import { createQuickPick } from './quick-pick'
import { FILE_HELP_LABEL, NO_MATCHES_LABEL, SYMBOL_HELP_LABEL } from './constants'
import { getMatchingContext } from './get-matching-context'
import type { EditIntent, EditRangeSource } from '../types'
import { DOCUMENT_ITEM, MODEL_ITEM, RANGE_ITEM, TEST_ITEM, getEditInputItems } from './get-items/edit'
import { MODEL_ITEMS, getModelInputItems } from './get-items/model'
import { RANGE_ITEMS, getRangeInputItems } from './get-items/range'
import {
    DEFAULT_DOCUMENT_ITEMS,
    DOCUMENT_ITEMS_RANGE_MAP,
    getDocumentInputItems,
} from './get-items/document'
import { DEFAULT_TEST_ITEMS, TEST_ITEMS_RANGE_MAP, getTestInputItems } from './get-items/test'
import { executeEdit } from '../execute'

interface QuickPickInput {
    /** The user provided instruction */
    instruction: string
    /** Any user provided context, from @ or @# */
    userContextFiles: ContextFile[]
    /** The LLM that the user has selected */
    model: EditSupportedModels
    /** The range that the user has selected */
    range: vscode.Range
    /** The source of the range selection */
    rangeSource: EditRangeSource
}

export interface EditInputInitialValues {
    initialRange: vscode.Range
    initialModel: EditSupportedModels
    initialRangeSource: EditRangeSource
    initialInputValue?: string
    initialSelectedContextFiles?: ContextFile[]
}

export const getInput = async (
    document: vscode.TextDocument,
    intent: EditIntent,
    initialValues: EditInputInitialValues,
    source: ChatEventSource
): Promise<QuickPickInput | null> => {
    const editor = getEditor().active
    if (!editor) {
        return null
    }

    let activeRange = initialValues.initialRange
    let activeModel: EditSupportedModels = initialValues.initialModel
    let activeRangeSource: EditRangeSource = initialValues.initialRangeSource

    // ContextItems to store possible user-provided context
    const contextItems = new Map<string, ContextFile>()
    const selectedContextItems = new Map<string, ContextFile>()

    // Initialize the selectedContextItems with any previous items
    // This is primarily for edit retries, where a user may want to reuse their context
    for (const file of initialValues.initialSelectedContextFiles ?? []) {
        selectedContextItems.set(getLabelForContextFile(file), file)
    }

    /**
     * Set the title of the quick pick to include the file and range
     * Update the title as the range changes
     */
    const relativeFilePath = vscode.workspace.asRelativePath(document.uri.fsPath)
    let activeTitle: string
    const updateActiveTitle = (newRange: vscode.Range) => {
        const fileRange = getTitleRange(newRange)
        activeTitle = `Edit ${relativeFilePath}:${fileRange} with Cody`
    }
    updateActiveTitle(activeRange)

    /**
     * Listens for text document changes and updates the range when changes occur.
     * This allows the range to stay in sync if the user continues editing after
     * requesting the refactoring.
     */
    const registerRangeListener = () => {
        return vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document !== document) {
                return
            }

            const changes = new Array<TextChange>(...event.contentChanges)
            const updatedRange = updateRangeMultipleChanges(activeRange, changes)
            if (!updatedRange.isEqual(activeRange)) {
                activeRange = updatedRange
                updateActiveTitle(activeRange)
            }
        })
    }
    let textDocumentListener = registerRangeListener()
    const updateActiveRange = (newSelection: vscode.Selection, selectionSource: EditRangeSource) => {
        // Pause listening to range changes to avoid a possible race condition
        textDocumentListener.dispose()

        // Update the current selection and the stored range and source
        editor.selection = newSelection
        editor.revealRange(newSelection, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
        activeRange = newSelection
        activeRangeSource = selectionSource

        // Resume listening to range changes
        textDocumentListener = registerRangeListener()
        // Update the title to reflect the new range
        updateActiveTitle(activeRange)
    }

    return new Promise(resolve => {
        const modelInput = createQuickPick({
            title: activeTitle,
            placeHolder: 'Change Model',
            getItems: () => getModelInputItems(activeModel),
            buttons: [vscode.QuickInputButtons.Back],
            onDidTriggerButton: () => editInput.render(activeTitle, editInput.input.value),
            onDidChangeActive: items => {
                const item = items[0]
                if (item.label === MODEL_ITEMS['anthropic/claude-2.1'].label) {
                    activeModel = 'anthropic/claude-2.1'
                    return
                }
                if (item.label === MODEL_ITEMS['anthropic/claude-instant-1.2'].label) {
                    activeModel = 'anthropic/claude-instant-1.2'
                    return
                }
            },
            onDidAccept: () => editInput.render(activeTitle, editInput.input.value),
        })

        const rangeInput = createQuickPick({
            title: activeTitle,
            placeHolder: 'Change Range',
            getItems: () => getRangeInputItems(activeRangeSource, initialValues.initialRangeSource),
            buttons: [vscode.QuickInputButtons.Back],
            onDidTriggerButton: () => editInput.render(activeTitle, editInput.input.value),
            onDidChangeActive: async items => {
                const item = items[0]
                if (item.label === RANGE_ITEMS.selection.label) {
                    updateActiveRange(
                        new vscode.Selection(
                            initialValues.initialRange.start,
                            initialValues.initialRange.end
                        ),
                        'selection'
                    )
                    return
                }
                if (item.label === RANGE_ITEMS.expanded.label) {
                    const smartSelection = await getEditSmartSelection(
                        editor.document,
                        initialValues.initialRange,
                        {
                            ignoreSelection: true,
                        }
                    )
                    updateActiveRange(
                        new vscode.Selection(smartSelection.start, smartSelection.end),
                        'expanded'
                    )
                    return
                }
                if (item.label === RANGE_ITEMS.maximum.label) {
                    const maximumRange = getEditMaximumSelection(
                        editor.document,
                        initialValues.initialRange
                    )
                    updateActiveRange(
                        new vscode.Selection(maximumRange.start, maximumRange.end),
                        'maximum'
                    )
                    return
                }
            },
            onDidAccept: () => editInput.render(activeTitle, editInput.input.value),
        })

        const documentInput = createQuickPick({
            title: activeTitle,
            placeHolder: 'Document...',
            getItems: () =>
                getDocumentInputItems(editor.document, activeRange, initialValues.initialRangeSource),
            buttons: [vscode.QuickInputButtons.Back],
            onDidTriggerButton: () => editInput.render(activeTitle, editInput.input.value),
            onDidChangeActive: async items => {
                const item = items[0]
                if (item.label === DEFAULT_DOCUMENT_ITEMS.selection.label) {
                    updateActiveRange(
                        new vscode.Selection(
                            initialValues.initialRange.start,
                            initialValues.initialRange.end
                        ),
                        'selection'
                    )
                    return
                }
                if (item.label === DEFAULT_DOCUMENT_ITEMS.expanded.label) {
                    const smartSelection = await getEditSmartSelection(
                        editor.document,
                        initialValues.initialRange,
                        {
                            ignoreSelection: true,
                        }
                    )
                    updateActiveRange(
                        new vscode.Selection(smartSelection.start, smartSelection.end),
                        'expanded'
                    )
                    return
                }
                const documentableRange = DOCUMENT_ITEMS_RANGE_MAP.get(item)
                if (documentableRange) {
                    updateActiveRange(
                        new vscode.Selection(documentableRange.start, documentableRange.end),
                        'selection'
                    )
                    return
                }
            },
            onDidAccept: () => {
                // Hide the input and execute a new edit for 'Document'
                documentInput.input.hide()
                return executeEdit(
                    {
                        document,
                        instruction: defaultCommands.commands.doc.prompt,
                        range: activeRange,
                        intent: 'doc',
                        mode: 'insert',
                        contextMessages: [],
                        userContextFiles: [],
                    },
                    'menu'
                )
            },
        })

        const unitTestInput = createQuickPick({
            title: activeTitle,
            placeHolder: 'Generate a Unit Test for...',
            getItems: () =>
                getTestInputItems(editor.document, activeRange, initialValues.initialRangeSource),
            buttons: [vscode.QuickInputButtons.Back],
            onDidTriggerButton: () => editInput.render(activeTitle, editInput.input.value),
            onDidChangeActive: async items => {
                const item = items[0]
                if (item.label === DEFAULT_TEST_ITEMS.selection.label) {
                    updateActiveRange(
                        new vscode.Selection(
                            initialValues.initialRange.start,
                            initialValues.initialRange.end
                        ),
                        'selection'
                    )
                    return
                }
                if (item.label === DEFAULT_TEST_ITEMS.expanded.label) {
                    const smartSelection = await getEditSmartSelection(
                        editor.document,
                        initialValues.initialRange,
                        {
                            ignoreSelection: true,
                        }
                    )
                    updateActiveRange(
                        new vscode.Selection(smartSelection.start, smartSelection.end),
                        'expanded'
                    )
                    return
                }

                const testableRange = TEST_ITEMS_RANGE_MAP.get(item)
                if (testableRange) {
                    updateActiveRange(
                        new vscode.Selection(testableRange.start, testableRange.end),
                        'selection'
                    )
                    return
                }
            },
            onDidAccept: () => {
                // Hide the input and execute a new edit for 'Test'
                unitTestInput.input.hide()
                // TODO: This should entirely run through `executeEdit` when
                // the unit test command has fully moved over to Edit.
                return vscode.commands.executeCommand('cody.command.unit-tests')
            },
        })

        unitTestInput.input.onDidHide(() => {
            console.log('HIDDEEENNN!!')
        })

        const editInput = createQuickPick({
            title: activeTitle,
            placeHolder: 'Your edit instructions (@ to include code, ⏎ to submit)',
            getItems: () =>
                getEditInputItems(intent, editInput.input.value, activeRangeSource, activeModel),
            ...(source === 'menu'
                ? {
                      buttons: [vscode.QuickInputButtons.Back],
                      onDidTriggerButton: target => {
                          if (target === vscode.QuickInputButtons.Back) {
                              void vscode.commands.executeCommand('cody.action.commands.menu')
                              editInput.input.hide()
                          }
                      },
                  }
                : {}),
            onDidChangeValue: async value => {
                const input = editInput.input
                if (
                    initialValues.initialInputValue !== undefined &&
                    value === initialValues.initialInputValue
                ) {
                    // Noop, this event is fired when an initial value is set
                    return
                }

                const isFileSearch = value.endsWith('@')
                const isSymbolSearch = value.endsWith('@#')

                // If we have the beginning of a file or symbol match, show a helpful label
                if (isFileSearch) {
                    input.items = [{ alwaysShow: true, label: FILE_HELP_LABEL }]
                    return
                }
                if (isSymbolSearch) {
                    input.items = [{ alwaysShow: true, label: SYMBOL_HELP_LABEL }]
                    return
                }

                const matchingContext = await getMatchingContext(value)
                if (matchingContext === null) {
                    // Nothing to match, clear existing items
                    // eslint-disable-next-line no-self-assign
                    input.items = getEditInputItems(
                        intent,
                        input.value,
                        activeRangeSource,
                        activeModel
                    ).items
                    return
                }

                if (matchingContext.length === 0) {
                    // Attempted to match but found nothing
                    input.items = [{ alwaysShow: true, label: NO_MATCHES_LABEL }]
                    return
                }

                // Update stored context items so we can retrieve them later
                for (const { key, file } of matchingContext) {
                    contextItems.set(key, file)
                }

                // Add human-friendly labels to the quick pick so the user can select them
                input.items = matchingContext.map(({ key, shortLabel }) => ({
                    alwaysShow: true,
                    label: shortLabel || key,
                    description: shortLabel ? key : undefined,
                }))
            },
            onDidAccept: () => {
                const input = editInput.input
                const instruction = input.value.trim()

                // Selected item flow, update the input and store it for submission
                const selectedItem = input.selectedItems[0]
                switch (selectedItem.label) {
                    case MODEL_ITEM.label:
                        modelInput.render(activeTitle, '')
                        return
                    case RANGE_ITEM.label:
                        rangeInput.render(activeTitle, '')
                        return
                    case DOCUMENT_ITEM.label:
                        documentInput.render(activeTitle, '')
                        return
                    case TEST_ITEM.label:
                        unitTestInput.render(activeTitle, '')
                        return
                }

                // Empty input flow, do nothing
                if (!instruction) {
                    return
                }

                // User provided context flow, the `key` is provided as the `description` for symbol items, use this if available.
                const key = selectedItem?.description || selectedItem?.label
                if (selectedItem) {
                    const contextItem = contextItems.get(key)
                    if (contextItem) {
                        // Replace fuzzy value with actual context in input
                        input.value = `${removeAfterLastAt(instruction)}@${key} `
                        selectedContextItems.set(key, contextItem)
                        return
                    }
                }

                // Submission flow, validate selected items and return final output
                input.hide()
                textDocumentListener.dispose()
                return resolve({
                    instruction: instruction.trim(),
                    userContextFiles: Array.from(selectedContextItems)
                        .filter(([key]) => instruction.includes(`@${key}`))
                        .map(([, value]) => value),
                    model: activeModel,
                    range: activeRange,
                    rangeSource: activeRangeSource,
                })
            },
        })

        // TODO: Restore selection on input?
        editInput.render(activeTitle, initialValues.initialInputValue || '')
        editInput.input.activeItems = []
    })
}
