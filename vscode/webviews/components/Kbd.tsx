import { isMacOS } from '@sourcegraph/cody-shared'
import {
    ArrowBigUpIcon,
    AtSignIcon,
    ChevronUpIcon,
    CommandIcon,
    CornerDownLeftIcon,
    OptionIcon,
} from 'lucide-react'
import type { FunctionComponent } from 'react'
import { cn } from './shadcn/utils'

const isMac = isMacOS()

function keyTextOrSvg(key: string): React.ReactElement | string {
    const iconClassName = 'tw-w-[1em] tw-h-[1em]'

    if (isMac && (/opt/i.test(key) || /option/i.test(key))) {
        return <OptionIcon className={iconClassName} />
    }
    if (isMac && /cmd/i.test(key)) {
        return <CommandIcon className={iconClassName} />
    }
    if (isMac && /ctrl/i.test(key)) {
        return <ChevronUpIcon className={cn(iconClassName, '-tw-translate-y-[.2em]')} />
    }
    if (isMac && /@/i.test(key)) {
        return <AtSignIcon className={cn(iconClassName)} />
    }
    if (/return/i.test(key)) {
        return <CornerDownLeftIcon className={iconClassName} />
    }
    if (/shift/i.test(key)) {
        return <ArrowBigUpIcon className={iconClassName} />
    }
    return <span>{key}</span>
}

/** A component that displays a keyboard shortcut. */
export const Kbd: FunctionComponent<{
    macOS: string
    linuxAndWindows: string
    variant?: 'ghost' | 'default'
    className?: string
}> = ({ macOS, linuxAndWindows, variant = 'default', className }) => {
    const keys = (isMac ? macOS : linuxAndWindows).split(/[ \+]/)

    return (
        <kbd
            className={cn(
                'tw-flex tw-items-stretch tw-gap-1.5 tw-text-sm tw-leading-none tw-uppercase',
                className
            )}
        >
            {keys.map((key, index) => {
                return (
                    <span
                        key={key}
                        className="tw-flex tw-min-w-[1.5em] tw-justify-center tw-rounded tw-border tw-text-keybinding-foreground tw-border-keybinding-border tw-bg-keybinding-background tw-p-1"
                    >
                        {keyTextOrSvg(key)}
                    </span>
                )
            })}
        </kbd>
    )
}
