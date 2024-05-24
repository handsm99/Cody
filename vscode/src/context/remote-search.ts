import * as vscode from 'vscode'

import {
    type ContextGroup,
    type ContextSearchResult,
    type ContextStatusProvider,
    type Disposable,
    type PromptString,
    contextFiltersProvider,
    graphqlClient,
    SourcegraphCompletionsClient,
} from '@sourcegraph/cody-shared'

import type * as repofetcher from './repo-fetcher'
import {rewriteKeywordQuery} from "../local-context/rewrite-keyword-query";

export enum RepoInclusion {
    Automatic = 'auto',
    Manual = 'manual',
}

interface DisplayRepo {
    displayName: string
}

export class RemoteSearch implements ContextStatusProvider {
    public static readonly MAX_REPO_COUNT = 10
    private disposeOnContextFilterChanged: () => void

    constructor(private completions: SourcegraphCompletionsClient) {
        this.disposeOnContextFilterChanged = contextFiltersProvider.onContextFiltersChanged(() => {
            this.statusChangedEmitter.fire(this)
        })
    }

    private statusChangedEmitter = new vscode.EventEmitter<ContextStatusProvider>()

    // Repositories we are including automatically because of the workspace.
    private reposAuto: Map<string, DisplayRepo> = new Map()

    // Repositories the user has added manually.
    private reposManual: Map<string, DisplayRepo> = new Map()

    public dispose(): void {
        this.statusChangedEmitter.dispose()
        this.disposeOnContextFilterChanged()
    }

    // #region ContextStatusProvider implementation.

    public onDidChangeStatus(callback: (provider: ContextStatusProvider) => void): Disposable {
        return this.statusChangedEmitter.event(callback)
    }

    public get status(): ContextGroup[] {
        return [...this.getRepoIdSet()].map(id => {
            const auto = this.reposAuto.get(id)
            const manual = this.reposManual.get(id)
            const displayName = auto?.displayName || manual?.displayName || '?'
            return {
                displayName,
                providers: [
                    {
                        kind: 'search',
                        type: 'remote',
                        state: 'ready',
                        id,
                        inclusion: auto ? 'auto' : 'manual',
                        isIgnored: contextFiltersProvider.isRepoNameIgnored(displayName),
                    },
                ],
            }
        })
    }

    // #endregion

    // Removes a manually included repository.
    public removeRepo(repoId: string): void {
        if (this.reposManual.delete(repoId)) {
            this.statusChangedEmitter.fire(this)
        }
    }

    // Sets the repos to search. RepoInclusion.Automatic is for repositories added
    // automatically based on the workspace; these are presented differently
    // and can't be removed by the user. RepoInclusion.Manual is for repositories
    // added manually by the user.
    public setRepos(repos: repofetcher.Repo[], inclusion: RepoInclusion): void {
        const repoMap: Map<string, DisplayRepo> = new Map(
            repos.map(repo => [repo.id, { displayName: repo.name }])
        )
        switch (inclusion) {
            case RepoInclusion.Automatic: {
                this.reposAuto = repoMap
                break
            }
            case RepoInclusion.Manual: {
                this.reposManual = repoMap
                break
            }
        }
        this.statusChangedEmitter.fire(this)
    }

    public getRepos(inclusion: RepoInclusion): repofetcher.Repo[] {
        return [
            ...(inclusion === RepoInclusion.Automatic ? this.reposAuto : this.reposManual).entries(),
        ].map(([id, repo]) => ({ id, name: repo.displayName }))
    }

    // Gets the set of all repositories to search.
    public getRepoIdSet(): Set<string> {
        return new Set([...this.reposAuto.keys(), ...this.reposManual.keys()])
    }

    public async query(query: PromptString): Promise<ContextSearchResult[]> {
        let rewritten = await rewriteKeywordQuery(this.completions, query, true)
        const result = await graphqlClient.contextSearch(this.getRepoIdSet(), rewritten)
        if (result instanceof Error) {
            throw result
        }
        return result || []
    }
}
