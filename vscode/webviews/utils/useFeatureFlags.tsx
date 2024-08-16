import type { FeatureFlagUsedInWebview } from '@sourcegraph/cody-shared'
import { useExtensionAPI } from '@sourcegraph/prompt-editor'
import { useAsyncGenerator } from '@sourcegraph/prompt-editor/src/useAsyncGenerator'
import { useCallback } from 'react'

/**
 * React hook for getting a feature flag's value.
 *
 * @returns `true` or `false` if the flag is exposed by the server endpoint, has been fetched, and
 * is not stale. Otherwise `undefined` (which callers should usually treat as `false`).
 */
export function useFeatureFlag(flag: FeatureFlagUsedInWebview): boolean | undefined {
    const evaluatedFeatureFlag = useExtensionAPI().evaluatedFeatureFlag
    return useAsyncGenerator(
        useCallback(
            (signal: AbortSignal) => evaluatedFeatureFlag(flag, signal),
            [evaluatedFeatureFlag, flag]
        )
    ).value
}
