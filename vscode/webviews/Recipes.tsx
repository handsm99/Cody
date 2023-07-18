import { VSCodeButton } from '@vscode/webview-ui-toolkit/react'

import { RecipeID } from '@sourcegraph/cody-shared/src/chat/recipes/recipe'

import { isInternalUser } from '../src/chat/protocol'

import { VSCodeWrapper } from './utils/VSCodeApi'

import styles from './Recipes.module.css'

export const recipesList = {
    'explain-code-detailed': 'Explain selected code (detailed)',
    'explain-code-high-level': 'Explain selected code (high level)',
    'generate-unit-test': 'Generate a unit test',
    'generate-docstring': 'Generate a docstring',
    'improve-variable-names': 'Improve variable names',
    'translate-to-language': 'Translate to different language',
    'git-history': 'Summarize recent code changes',
    'find-code-smells': 'Smell code',
    fixup: 'Fixup code from inline instructions',
    'context-search': 'Codebase context search',
    'release-notes': 'Generate release notes',
    'pr-description': 'Generate pull request description',
}

export const Recipes: React.FunctionComponent<{
    vscodeAPI: VSCodeWrapper
    myPrompts: string[]
    endpoint: string
}> = ({ vscodeAPI, myPrompts, endpoint }) => {
    const onRecipeClick = (recipeID: RecipeID): void => {
        vscodeAPI.postMessage({ command: 'executeRecipe', recipe: recipeID })
    }
    const onMyPromptClick = (promptID: string): void => {
        vscodeAPI.postMessage({ command: 'my-prompt', title: promptID })
    }
    const myPromptsEnabled = isInternalUser(endpoint)

    return (
        <div className="inner-container">
            <div className="non-transcript-container">
                <div className={styles.recipes}>
                    {myPromptsEnabled && (
                        <>
                            <div>
                                <div className={styles.recipesHeader}>
                                    <span>Custom Recipes</span>
                                    <VSCodeButton
                                        type="button"
                                        appearance="icon"
                                        onClick={() => onMyPromptClick('add')}
                                    >
                                        <i
                                            className="codicon codicon-plus"
                                            title="Create a new recipe with custom prompt"
                                        />
                                    </VSCodeButton>
                                </div>
                                {myPrompts?.length > 0 ? (
                                    <small className={styles.recipesNotes}>
                                        To create a new Workspace recipe, add a new recipe item to the
                                        `.vscode/cody.json` file located in the repository. You can also click the `+`
                                        icon above to create a new User recipe accessible only to you across Workspaces.
                                    </small>
                                ) : (
                                    <small className={styles.recipesNotes}>
                                        Custom Recipes let you build your own reusable prompts with tailored contexts.
                                        To get started, choose a custom recipe type below to create a new `cody.json`
                                        file containing sample recipes.
                                    </small>
                                )}
                            </div>
                            {!myPrompts?.length && (
                                <>
                                    <VSCodeButton
                                        className={styles.recipeButton}
                                        type="button"
                                        onClick={() => onMyPromptClick('add-user-file')}
                                        title="User Recipes are accessible only to you across
                                        Workspaces"
                                    >
                                        User Recipes
                                    </VSCodeButton>
                                    <VSCodeButton
                                        className={styles.recipeButton}
                                        type="button"
                                        onClick={() => onMyPromptClick('add-workspace-file')}
                                        title="Workspace Recipes are available to all users in your current
                                        repository"
                                    >
                                        Workspace Recipes
                                    </VSCodeButton>
                                </>
                            )}
                            {myPrompts?.map(promptID => (
                                <VSCodeButton
                                    key={promptID}
                                    className={styles.recipeButton}
                                    type="button"
                                    onClick={() => onMyPromptClick(promptID)}
                                >
                                    {promptID}
                                </VSCodeButton>
                            ))}
                            {myPrompts?.length > 0 && (
                                <VSCodeButton
                                    className={styles.recipeButton}
                                    type="button"
                                    onClick={() => onMyPromptClick('clear')}
                                >
                                    Remove cody.json for User Recipes
                                </VSCodeButton>
                            )}
                            <div className={styles.recipesHeader}>
                                <span>Featured Recipes</span>
                            </div>
                        </>
                    )}
                    {Object.entries(recipesList).map(([key, value]) => (
                        <VSCodeButton
                            key={key}
                            className={styles.recipeButton}
                            type="button"
                            onClick={() => onRecipeClick(key as RecipeID)}
                        >
                            {value}
                        </VSCodeButton>
                    ))}
                </div>
            </div>
        </div>
    )
}
