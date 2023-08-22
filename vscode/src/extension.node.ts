import * as vscode from 'vscode'

import { ContextSearch } from '@sourcegraph/cody-shared/src/chat/recipes/context-search'
import { PrDescription } from '@sourcegraph/cody-shared/src/chat/recipes/generate-pr-description'
import { ReleaseNotes } from '@sourcegraph/cody-shared/src/chat/recipes/generate-release-notes'
import { GitHistory } from '@sourcegraph/cody-shared/src/chat/recipes/git-log'
import { SourcegraphNodeCompletionsClient } from '@sourcegraph/cody-shared/src/sourcegraph-api/completions/nodeClient'

import { LocalIndexedKeywordSearch } from './chat/local-code-search'
import { CommandsController } from './custom-prompts/CommandsController'
import { ExtensionApi } from './extension-api'
import { activate as activateCommon } from './extension.common'
import { VSCODE_WEB_RECIPES } from './extension.web'
import { FilenameContextFetcher } from './local-context/filename-context-fetcher'
import { LocalKeywordContextFetcher } from './local-context/local-keyword-context-fetcher'
import { SymfRunner } from './local-context/symf'
import { getRgPath } from './rg'

/**
 * Activation entrypoint for the VS Code extension when running VS Code as a desktop app
 * (Node.js/Electron).
 */
export function activate(context: vscode.ExtensionContext): ExtensionApi {
    return activateCommon(context, {
        getRgPath,
        createCommandsController: (...args) => new CommandsController(...args),
        createLocalKeywordContextFetcher: (...args) => new LocalKeywordContextFetcher(...args),
        createFilenameContextFetcher: (...args) => new FilenameContextFetcher(...args),
        createCompletionsClient: (...args) => new SourcegraphNodeCompletionsClient(...args),
        createSymfRunner: (...args) => new SymfRunner(...args),

        // Include additional recipes that require Node packages (such as `child_process`).
        recipes: [
            ...VSCODE_WEB_RECIPES,
            new GitHistory(),
            new ReleaseNotes(),
            new PrDescription(),
            new LocalIndexedKeywordSearch(),
            new ContextSearch(),
        ],
    })
}
