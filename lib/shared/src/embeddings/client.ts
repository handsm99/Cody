import { EmbeddingsSearchResults, SourcegraphGraphQLAPIClient } from '../sourcegraph-api/graphql'

import { EmbeddingsSearch } from '.'

export class SourcegraphEmbeddingsSearchClient implements EmbeddingsSearch {
    constructor(
        private client: SourcegraphGraphQLAPIClient,
        public readonly repoId: string,
        private web: boolean = false
    ) {}

    public get endpoint(): string {
        return this.client.endpoint
    }

    public async search(
        query: string,
        codeResultsCount: number,
        textResultsCount: number
    ): Promise<EmbeddingsSearchResults | Error> {
        if (this.web) {
            return this.client.searchEmbeddings([this.repoId], query, codeResultsCount, textResultsCount)
        }

        return this.client.legacySearchEmbeddings(this.repoId, query, codeResultsCount, textResultsCount)
    }
}
