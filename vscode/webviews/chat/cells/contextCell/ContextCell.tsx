import type { ContextItem, ModelProvider } from '@sourcegraph/cody-shared'
import { clsx } from 'clsx'
import { BrainIcon } from 'lucide-react'
import type React from 'react'
import { FileLink } from '../../../components/FileLink'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../components/shadcn/ui/tooltip'
import { SourcegraphLogo } from '../../../icons/SourcegraphLogo'
import { MENTION_CLASS_NAME } from '../../../promptEditor/nodes/ContextItemMentionNode'
import { getVSCodeAPI } from '../../../utils/VSCodeApi'
import { LoadingDots } from '../../components/LoadingDots'
import { Cell } from '../Cell'
import { NON_HUMAN_CELL_AVATAR_SIZE } from '../messageCell/assistant/AssistantMessageCell'
import styles from './ContextCell.module.css'

/**
 * A component displaying the context for a human message.
 */
export const ContextCell: React.FunctionComponent<{
    contextFiles: ContextItem[] | undefined
    model?: ModelProvider['model']
    className?: string

    /** For use in storybooks only. */
    __storybook__initialOpen?: boolean
}> = ({ contextFiles, model, className, __storybook__initialOpen }) => {
    const usedContext = []
    const excludedAtContext = []
    if (contextFiles) {
        for (const f of contextFiles) {
            if (f.isTooLarge || f.isIgnored) {
                excludedAtContext.push(f)
            } else {
                usedContext.push(f)
            }
        }
    }

    const fileCount = new Set(usedContext.map(file => file.uri.toString())).size
    let fileCountLabel = `${fileCount} file${fileCount > 1 ? 's' : ''}`
    if (excludedAtContext.length) {
        const excludedAtUnit = excludedAtContext.length === 1 ? 'mention' : 'mentions'
        fileCountLabel = `${fileCountLabel} — ${excludedAtContext.length} ${excludedAtUnit} excluded`
    }

    function logContextOpening() {
        getVSCodeAPI().postMessage({
            command: 'event',
            eventName: 'CodyVSCodeExtension:chat:context:opened',
            properties: {
                fileCount,
                excludedAtContext: excludedAtContext.length,
            },
        })
    }

    return contextFiles === undefined || contextFiles.length !== 0 ? (
        <Cell
            style="context"
            gutterIcon={
                <SourcegraphLogo
                    width={NON_HUMAN_CELL_AVATAR_SIZE}
                    height={NON_HUMAN_CELL_AVATAR_SIZE}
                />
            }
            containerClassName={className}
            contentClassName="tw-flex tw-flex-col tw-gap-4"
            data-testid="context"
        >
            {contextFiles === undefined ? (
                <LoadingDots />
            ) : (
                <details className={styles.details} open={__storybook__initialOpen}>
                    <summary
                        className={styles.summary}
                        onClick={logContextOpening}
                        onKeyUp={logContextOpening}
                        title={fileCountLabel}
                    >
                        <h4 className={styles.heading}>
                            Context <span className={styles.stats}>&mdash; {fileCountLabel}</span>
                        </h4>
                    </summary>
                    <ul className={styles.list}>
                        {contextFiles?.map((item, i) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: stable order
                            <li key={i}>
                                <FileLink
                                    uri={item.uri}
                                    repoName={item.repoName}
                                    revision={item.revision}
                                    source={item.source}
                                    range={item.range}
                                    title={item.title}
                                    isTooLarge={
                                        item.type === 'file' && item.isTooLarge && item.source === 'user'
                                    }
                                    isIgnored={
                                        item.type === 'file' && item.isIgnored && item.source === 'user'
                                    }
                                    className={clsx(styles.contextItem, MENTION_CLASS_NAME)}
                                    linkClassName={styles.contextItemLink}
                                />
                            </li>
                        ))}
                        <li>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                    <span
                                        className={clsx(
                                            styles.contextItem,
                                            'tw-flex tw-items-center tw-gap-2'
                                        )}
                                    >
                                        <BrainIcon size={12} className="tw-ml-1" /> Public knowledge{' '}
                                    </span>
                                </TooltipTrigger>
                                <TooltipContent>
                                    Information and general reasoning capabilities trained into the model{' '}
                                    {model && <code>{model}</code>}
                                </TooltipContent>
                            </Tooltip>
                        </li>
                    </ul>
                </details>
            )}
        </Cell>
    ) : null
}
