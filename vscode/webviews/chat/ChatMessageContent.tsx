import { type Guardrails, type PromptString, isError } from '@sourcegraph/cody-shared'
import type React from 'react'
import { useEffect, useRef } from 'react'

import {
    CheckCodeBlockIcon,
    CopyCodeBlockIcon,
    EllipsisIcon,
    InsertCodeBlockIcon,
    SaveCodeBlockIcon,
    ShieldIcon,
    SparkleIcon,
} from '../icons/CodeBlockActionIcons'

import { clsx } from 'clsx'
import { MarkdownFromCody } from '../components/MarkdownFromCody'
import styles from './ChatMessageContent.module.css'
import type { PriorHumanMessageInfo } from './cells/messageCell/assistant/AssistantMessageCell'

export interface CodeBlockActionsProps {
    copyButtonOnSubmit: (text: string, event?: 'Keydown' | 'Button') => void
    insertButtonOnSubmit: (text: string, newFile?: boolean) => void
    smartApplyButtonOnSubmit: (text: string, instruction?: PromptString, fileName?: string) => void
}

interface ChatMessageContentProps {
    displayMarkdown: string
    isMessageLoading: boolean
    humanMessage: PriorHumanMessageInfo | null

    copyButtonOnSubmit?: CodeBlockActionsProps['copyButtonOnSubmit']
    insertButtonOnSubmit?: CodeBlockActionsProps['insertButtonOnSubmit']

    experimentalSmartApplyEnabled?: boolean
    smartApplyButtonOnSubmit?: CodeBlockActionsProps['smartApplyButtonOnSubmit']

    guardrails?: Guardrails
    className?: string
}

function createButtons(
    preText: string,
    copyButtonOnSubmit?: CodeBlockActionsProps['copyButtonOnSubmit'],
    insertButtonOnSubmit?: CodeBlockActionsProps['insertButtonOnSubmit']
): HTMLElement {
    const container = document.createElement('div')
    container.className = styles.buttonsContainer

    if (!copyButtonOnSubmit) {
        return container
    }

    // The container will contain the buttons and the <pre> element with the code.
    // This allows us to position the buttons independent of the code.
    const buttons = document.createElement('div')
    buttons.className = styles.buttons

    const codeBlockActions = {
        copy: copyButtonOnSubmit,
        insert: insertButtonOnSubmit,
    }

    const copyButton = createCodeBlockActionButton(
        'copy',
        preText,
        'Copy Code',
        CopyCodeBlockIcon,
        codeBlockActions
    )
    buttons.append(copyButton)

    // The insert buttons only exists for IDE integrations
    if (insertButtonOnSubmit) {
        buttons.append(
            createCodeBlockActionButton(
                'insert',
                preText,
                'Insert Code at Cursor',
                InsertCodeBlockIcon,
                codeBlockActions
            )
        )

        buttons.append(
            createCodeBlockActionButton(
                'new',
                preText,
                'Save Code to New File...',
                SaveCodeBlockIcon,
                codeBlockActions
            )
        )
    }

    container.append(buttons)

    return container
}

function createButtonsExperimentalUI(
    preText: string,
    humanMessage: PriorHumanMessageInfo | null,
    fileName?: string,
    copyButtonOnSubmit?: CodeBlockActionsProps['copyButtonOnSubmit'],
    smartApplyButtonOnSubmit?: CodeBlockActionsProps['smartApplyButtonOnSubmit']
): HTMLElement {
    // The container will contain the buttons and the <pre> element with the code.
    // This allows us to position the buttons independent of the code.
    const container = document.createElement('div')
    container.className = styles.buttonsContainer
    if (!copyButtonOnSubmit) {
        return container
    }

    const buttons = document.createElement('div')
    buttons.className = styles.buttons

    const copyButton = createCopyButton(preText, copyButtonOnSubmit)
    buttons.append(copyButton)

    if (smartApplyButtonOnSubmit) {
        const applyButton = createApplyButton(preText, humanMessage, smartApplyButtonOnSubmit, fileName)
        buttons.append(applyButton)
    }

    const actionsDropdown = createActionsDropdown(preText)
    buttons.append(actionsDropdown)

    container.append(buttons)

    return container
}

/**
 * Creates a button to perform an action on a code block.
 * @returns The button element.
 */
function createCodeBlockActionButton(
    type: 'copy' | 'insert' | 'new',
    text: string,
    title: string,
    iconSvg: string,
    codeBlockActions: {
        copy: CodeBlockActionsProps['copyButtonOnSubmit']
        insert?: CodeBlockActionsProps['insertButtonOnSubmit']
    }
): HTMLElement {
    const button = document.createElement('button')

    const className = type === 'copy' ? styles.copyButton : styles.insertButton

    button.innerHTML = iconSvg
    button.title = title
    button.className = className

    if (type === 'copy') {
        button.addEventListener('click', () => {
            button.innerHTML = CheckCodeBlockIcon
            navigator.clipboard.writeText(text).catch(error => console.error(error))
            button.className = className
            codeBlockActions.copy(text, 'Button')
            setTimeout(() => {
                button.innerHTML = iconSvg
            }, 5000)

            // Log for `chat assistant response code buttons` e2e test.
            console.log('Code: Copy to Clipboard', text)
        })
    }

    const insertOnSubmit = codeBlockActions.insert
    if (!insertOnSubmit) {
        return button
    }

    switch (type) {
        case 'insert':
            button.addEventListener('click', () => insertOnSubmit(text, false))
            break
        case 'new':
            button.addEventListener('click', () => insertOnSubmit(text, true))
            break
    }

    return button
}

function createCopyButton(
    preText: string,
    onCopy: CodeBlockActionsProps['copyButtonOnSubmit']
): HTMLElement {
    const button = document.createElement('button')
    button.innerHTML = 'Copy'
    button.className = styles.button

    const iconContainer = document.createElement('div')
    iconContainer.className = styles.iconContainer
    iconContainer.innerHTML = CopyCodeBlockIcon
    button.prepend(iconContainer)

    button.addEventListener('click', () => {
        iconContainer.innerHTML = CheckCodeBlockIcon
        iconContainer.className = styles.iconContainer
        button.innerHTML = 'Copied'
        button.className = styles.button
        button.prepend(iconContainer)

        navigator.clipboard.writeText(preText).catch(error => console.error(error))
        onCopy(preText, 'Button')
        setTimeout(() => {
            // Reset the icon to the original.
            iconContainer.innerHTML = CopyCodeBlockIcon
            iconContainer.className = styles.iconContainer
            button.innerHTML = 'Copy'
            button.className = styles.button
            button.prepend(iconContainer)
        }, 5000)

        // Log for `chat assistant response code buttons` e2e test.
        console.log('Code: Copy to Clipboard', preText)
    })

    return button
}

function createApplyButton(
    preText: string,
    humanMessage: PriorHumanMessageInfo | null,
    onApply: CodeBlockActionsProps['smartApplyButtonOnSubmit'],
    fileName?: string
): HTMLElement {
    const button = document.createElement('button')
    button.innerHTML = 'Apply'
    button.className = styles.button

    const iconContainer = document.createElement('div')
    iconContainer.className = styles.iconContainer
    iconContainer.innerHTML = SparkleIcon
    button.prepend(iconContainer)

    button.addEventListener('click', () => onApply(preText, humanMessage?.text, fileName))

    return button
}

function createActionsDropdown(preText: string): HTMLElement {
    const button = document.createElement('button')
    button.innerHTML = EllipsisIcon
    button.title = 'More Actions...'
    button.className = styles.button

    const vscodeContext = {
        webviewSection: 'codeblock-actions',
        preventDefaultContextMenuItems: true,
        text: preText,
    }

    // Attach `data-vscode-context`, this is also provided when the commands are executed,
    // so serves as a way for us to pass `vscodeContext.text` to each relevant command
    button.setAttribute('data-vscode-context', JSON.stringify(vscodeContext))

    button.addEventListener('click', event => {
        event.preventDefault()
        event.target?.dispatchEvent(
            new MouseEvent('contextmenu', {
                bubbles: true,
                clientX: event.clientX,
                clientY: event.clientY,
            })
        )
        event.stopPropagation()
    })

    return button
}

/*
 * GuardrailsStatusController manages the bit of UI with shield icon,
 * and spinner/check mark/status in the bottom-right corner of CodeBlocks
 * when attribution is enabled.
 */
class GuardrailsStatusController {
    readonly statusSpinning = `<i class="codicon codicon-loading ${styles.codiconLoading}"></i>`
    readonly statusPass = '<i class="codicon codicon-pass"></i>'
    readonly statusFailed = 'Guardrails Check Failed'
    readonly statusUnavailable = 'Guardrails API Error'

    readonly iconClass = 'guardrails-icon'
    readonly statusClass = 'guardrails-status'

    private status: HTMLElement

    constructor(public container: HTMLElement) {
        this.findOrAppend(this.iconClass, () => {
            const icon = document.createElement('div')
            icon.innerHTML = ShieldIcon
            icon.classList.add(styles.attributionIcon, this.iconClass)
            icon.setAttribute('data-testid', 'attribution-indicator')
            return icon
        })
        this.status = this.findOrAppend(this.statusClass, () => {
            const status = document.createElement('div')
            status.classList.add(styles.status, this.statusClass)
            return status
        })
    }

    /**
     * setPending displays a spinner next
     * to the attribution shield icon.
     */
    public setPending() {
        this.container.title = 'Guardrails: Running code attribution check…'
        this.status.innerHTML = this.statusSpinning
    }

    /**
     * setSuccess changes spinner on the right-hand side
     * of shield icon to a checkmark.
     */
    public setSuccess() {
        this.container.title = 'Guardrails check passed'
        this.status.innerHTML = this.statusPass
    }

    /**
     * setFailure displays a failure message instead of spinner
     * on the right-hand side of shield icon. Tooltip indicates
     * where attribution was found, and whether the attribution limit was hit.
     */
    public setFailure(repos: string[], limitHit: boolean) {
        this.container.classList.add(styles.attributionIconFound)
        this.container.title = this.tooltip(repos, limitHit)
        this.status.innerHTML = this.statusFailed
    }

    /**
     * setUnavailable displays a failure message instead of spinner
     * on the right-hand side of shield icon. It indicates that attribution
     * search is unavailable.
     */
    public setUnavailable(error: Error) {
        this.container.classList.add(styles.attributionIconUnavailable)
        this.container.title = `Guardrails API error: ${error.message}`
        this.status.innerHTML = this.statusUnavailable
    }

    private findOrAppend(className: string, make: () => HTMLElement): HTMLElement {
        const elements = this.container.getElementsByClassName(className)
        if (elements.length > 0) {
            return elements[0] as HTMLElement
        }
        const newElement = make()
        this.container.append(newElement)
        return newElement
    }

    private tooltip(repos: string[], limitHit: boolean) {
        const prefix = 'Guardrails check failed. Code found in'
        if (repos.length === 1) {
            return `${prefix} ${repos[0]}.`
        }
        const tooltip = `${prefix} ${repos.length} repositories: ${repos.join(', ')}`
        return limitHit ? `${tooltip} or more...` : `${tooltip}.`
    }
}

/**
 * A component presenting the content of a chat message.
 */
export const ChatMessageContent: React.FunctionComponent<ChatMessageContentProps> = ({
    displayMarkdown,
    isMessageLoading,
    humanMessage,
    copyButtonOnSubmit,
    insertButtonOnSubmit,
    guardrails,
    className,
    experimentalSmartApplyEnabled,
    smartApplyButtonOnSubmit,
}) => {
    const rootRef = useRef<HTMLDivElement>(null)

    // biome-ignore lint/correctness/useExhaustiveDependencies: needs to run when `displayMarkdown` changes or else the buttons won't show up.
    useEffect(() => {
        if (!rootRef.current) {
            return
        }

        const preElements = rootRef.current.querySelectorAll('pre')
        if (!preElements?.length || !copyButtonOnSubmit) {
            return
        }

        const existingButtons = rootRef.current.querySelectorAll(`.${styles.buttonsContainer}`)
        for (const existingButton of existingButtons) {
            existingButton.remove()
        }

        for (const preElement of preElements) {
            const preText = preElement.textContent

            if (preText?.trim() && preElement.parentNode) {
                // Extract the <code> element and attached `data-file-path` if present.
                // This allows us to intelligently apply code to the suitable file.
                const codeElement = preElement.querySelectorAll('code')?.[0]
                const fileName = codeElement?.getAttribute('data-file-path') || undefined

                const buttons = experimentalSmartApplyEnabled
                    ? createButtonsExperimentalUI(
                          preText,
                          humanMessage,
                          fileName,
                          copyButtonOnSubmit,
                          smartApplyButtonOnSubmit
                      )
                    : createButtons(preText, copyButtonOnSubmit, insertButtonOnSubmit)

                if (experimentalSmartApplyEnabled && fileName?.length) {
                    const fileNameContainer = document.createElement('div')
                    fileNameContainer.className = styles.fileNameContainer
                    fileNameContainer.textContent = getFileName(fileName)
                    fileNameContainer.title = fileName
                    buttons.append(fileNameContainer)
                }

                if (guardrails) {
                    const container = document.createElement('div')
                    container.classList.add(styles.attributionContainer)
                    buttons.append(container)

                    if (!isMessageLoading) {
                        const g = new GuardrailsStatusController(container)
                        g.setPending()

                        guardrails
                            .searchAttribution(preText)
                            .then(attribution => {
                                if (isError(attribution)) {
                                    g.setUnavailable(attribution)
                                } else if (attribution.repositories.length === 0) {
                                    g.setSuccess()
                                } else {
                                    g.setFailure(
                                        attribution.repositories.map(r => r.name),
                                        attribution.limitHit
                                    )
                                }
                            })
                            .catch(error => {
                                g.setUnavailable(error)
                                return
                            })
                    }
                }

                // Insert the buttons after the pre using insertBefore() because there is no insertAfter()
                preElement.parentNode.insertBefore(buttons, preElement.nextSibling)
            }
        }
    }, [
        copyButtonOnSubmit,
        insertButtonOnSubmit,
        experimentalSmartApplyEnabled,
        smartApplyButtonOnSubmit,
        guardrails,
        displayMarkdown,
        isMessageLoading,
    ])

    return (
        <div ref={rootRef} data-testid="chat-message-content">
            <MarkdownFromCody className={clsx(styles.content, className)}>
                {displayMarkdown}
            </MarkdownFromCody>
        </div>
    )
}

function getFileName(filePath: string): string {
    return filePath.split('/').pop() || filePath
}
