import type { Response as NodeResponse } from 'node-fetch'
import { URI } from 'vscode-uri'
import { fetch } from '../../fetch'

import type { TelemetryEventInput } from '@sourcegraph/telemetry'

import { escapeRegExp } from 'lodash'
import semver from 'semver'
import type { ConfigurationWithAccessToken } from '../../configuration'
import { logDebug, logError } from '../../logger'
import { addTraceparent, wrapInActiveSpan } from '../../tracing'
import { isError } from '../../utils'
import { DOTCOM_URL, isDotCom } from '../environments'
import {
    CONTEXT_FILTERS_QUERY,
    CONTEXT_SEARCH_QUERY,
    CURRENT_SITE_CODY_CONFIG_FEATURES,
    CURRENT_SITE_CODY_LLM_CONFIGURATION,
    CURRENT_SITE_CODY_LLM_CONFIGURATION_SMART_CONTEXT,
    CURRENT_SITE_CODY_LLM_PROVIDER,
    CURRENT_SITE_GRAPHQL_FIELDS_QUERY,
    CURRENT_SITE_HAS_CODY_ENABLED_QUERY,
    CURRENT_SITE_IDENTIFICATION,
    CURRENT_SITE_VERSION_QUERY,
    CURRENT_USER_CODY_PRO_ENABLED_QUERY,
    CURRENT_USER_CODY_SUBSCRIPTION_QUERY,
    CURRENT_USER_ID_QUERY,
    CURRENT_USER_INFO_QUERY,
    EVALUATE_FEATURE_FLAG_QUERY,
    FILE_CONTENTS_QUERY,
    FILE_MATCH_SEARCH_QUERY,
    FUZZY_FILES_QUERY,
    FUZZY_SYMBOLS_QUERY,
    GET_FEATURE_FLAGS_QUERY,
    GET_REMOTE_FILE_QUERY,
    LOG_EVENT_MUTATION,
    LOG_EVENT_MUTATION_DEPRECATED,
    PACKAGE_LIST_QUERY,
    RECORD_TELEMETRY_EVENTS_MUTATION,
    REPOSITORY_IDS_QUERY,
    REPOSITORY_ID_QUERY,
    REPOSITORY_LIST_QUERY,
    REPOSITORY_SEARCH_QUERY,
    REPO_NAME_QUERY,
    SEARCH_ATTRIBUTION_QUERY,
} from './queries'
import { buildGraphQLUrl } from './url'

export type BrowserOrNodeResponse = Response | NodeResponse

export function isNodeResponse(response: BrowserOrNodeResponse): response is NodeResponse {
    return Boolean(response.body && !('getReader' in response.body))
}

interface APIResponse<T> {
    data?: T
    errors?: { message: string; path?: string[] }[]
}

interface SiteVersionResponse {
    site: { productVersion: string } | null
}

export type FuzzyFindFilesResponse = {
    __typename?: 'Query'
    search: {
        results: {
            results: Array<FuzzyFindFile>
        }
    } | null
}

export type FuzzyFindSymbolsResponse = {
    __typename?: 'Query'
    search: {
        results: {
            results: FuzzyFindSymbol[]
        }
    }
}

type FuzzyFindFile = {
    file: {
        path: string
        url: string
        name: string
        byteSize: number
        isDirectory: boolean
    }
    repository: { id: string; name: string }
}

type FuzzyFindSymbol = {
    symbols: {
        name: string
        location: {
            range: {
                start: { line: number }
                end: { line: number }
            }
            resource: {
                path: string
            }
        }
    }[]
    repository: { id: string; name: string }
}

interface RemoteFileContentReponse {
    __typename?: 'Query'
    repository: {
        id: string
        commit: {
            id: string
            oid: string
            blob: {
                content: string
            }
        }
    }
}

interface SiteIdentificationResponse {
    site: {
        siteID: string
        productSubscription: { license: { hashedKey: string } }
    } | null
}

interface SiteGraphqlFieldsResponse {
    __type: { fields: { name: string }[] } | null
}

interface SiteHasCodyEnabledResponse {
    site: { isCodyEnabled: boolean } | null
}

interface CurrentUserIdResponse {
    currentUser: { id: string } | null
}

interface CurrentUserInfoResponse {
    currentUser: {
        id: string
        hasVerifiedEmail: boolean
        displayName?: string
        username: string
        avatarURL: string
        codyProEnabled: boolean
        primaryEmail?: { email: string } | null
        organizations: {
            nodes: { name: string; id: string }[]
        }
    } | null
}

// The client configuration describing all of the features that are currently available.
//
// This is fetched from the Sourcegraph instance and is specific to the current user.
//
// For the canonical type definition, see https://sourcegraph.com/github.com/sourcegraph/sourcegraph/-/blob/internal/clientconfig/types.go
interface CodyClientConfig {
    // Whether the site admin allows this user to make use of Cody at all.
    codyEnabled: boolean

    // Whether the site admin allows this user to make use of the Cody chat feature.
    chatEnabled: boolean

    // Whether the site admin allows this user to make use of the Cody autocomplete feature.
    autoCompleteEnabled: boolean

    // Whether the site admin allows the user to make use of the **custom** Cody commands feature.
    customCommandsEnabled: boolean

    // Whether the site admin allows this user to make use of the Cody attribution feature.
    attributionEnabled: boolean

    // Whether the 'smart context window' feature should be enabled, and whether the Sourcegraph
    // instance supports various new GraphQL APIs needed to make it work.
    smartContextWindowEnabled: boolean

    // Whether the new Sourcegraph backend LLM models API endpoint should be used to query which
    // models are available.
    modelsAPIEnabled: boolean
}

interface CodyConfigFeatures {
    chat: boolean
    autoComplete: boolean
    commands: boolean
    attribution: boolean
}

interface CodyConfigFeaturesResponse {
    site: { codyConfigFeatures: CodyConfigFeatures | null } | null
}

interface CodyEnterpriseConfigSmartContextResponse {
    site: { codyLLMConfiguration: { smartContextWindow: string } | null } | null
}

interface CurrentUserCodyProEnabledResponse {
    currentUser: {
        codyProEnabled: boolean
    } | null
}

interface CurrentUserCodySubscriptionResponse {
    currentUser: {
        codySubscription: {
            status: string
            plan: string
            applyProRateLimits: boolean
            currentPeriodStartAt: Date
            currentPeriodEndAt: Date
        }
    } | null
}

interface CodyLLMSiteConfigurationResponse {
    site: {
        codyLLMConfiguration: Omit<CodyLLMSiteConfiguration, 'provider'> | null
    } | null
}

interface CodyLLMSiteConfigurationProviderResponse {
    site: {
        codyLLMConfiguration: Pick<CodyLLMSiteConfiguration, 'provider'> | null
    } | null
}

interface PackageListResponse {
    packageRepoReferences: {
        nodes: {
            id: string
            name: string
            kind: string
            repository: { id: string; name: string; url: string }
        }[]
        pageInfo: {
            endCursor: string | null
        }
    }
}

export interface RepoListResponse {
    repositories: {
        nodes: { name: string; id: string }[]
        pageInfo: {
            endCursor: string | null
        }
    }
}

export interface RepoSearchResponse {
    repositories: {
        nodes: { name: string; id: string; url: string }[]
        pageInfo: {
            endCursor: string | null
        }
    }
}
interface FileMatchSearchResponse {
    search: {
        results: {
            results: {
                __typename: string
                repository: {
                    name: string
                }
                file: {
                    url: string
                    path: string
                    commit: {
                        oid: string
                    }
                }
            }[]
        }
    }
}

interface FileContentsResponse {
    repository: {
        commit: {
            file: {
                path: string
                url: string
                content: string
            } | null
        } | null
    } | null
}

interface RepositoryIdResponse {
    repository: { id: string } | null
}

interface RepositoryNameResponse {
    repository: { name: string } | null
}

interface RepositoryIdsResponse {
    repositories: {
        nodes: { name: string; id: string }[]
    }
}

interface SearchAttributionResponse {
    snippetAttribution: {
        limitHit: boolean
        nodes: { repositoryName: string }[]
    }
}

type LogEventResponse = unknown

interface ContextSearchResponse {
    getCodyContext: {
        blob: {
            commit: {
                oid: string
            }
            path: string
            repository: {
                id: string
                name: string
            }
            url: string
        }
        startLine: number
        endLine: number
        chunkContent: string
    }[]
}

export interface EmbeddingsSearchResult {
    repoName?: string
    revision?: string
    uri: URI
    startLine: number
    endLine: number
    content: string
}

export interface ContextSearchResult {
    repoName: string
    commit: string
    uri: URI
    path: string
    startLine: number
    endLine: number
    content: string
}

interface ContextFiltersResponse {
    site: {
        codyContextFilters: {
            raw: ContextFilters | null
        } | null
    } | null
}

export interface ContextFilters {
    include?: CodyContextFilterItem[] | null
    exclude?: CodyContextFilterItem[] | null
}

export interface CodyContextFilterItem {
    repoNamePattern: string
    // Not implemented
    filePathPatterns?: string[]
}

/**
 * Default value used on the client in case context filters are not set.
 */
export const INCLUDE_EVERYTHING_CONTEXT_FILTERS = {
    include: [{ repoNamePattern: '.*' }],
    exclude: null,
} satisfies ContextFilters

/**
 * Default value used on the client in case client encounters errors
 * fetching or parsing context filters.
 */
export const EXCLUDE_EVERYTHING_CONTEXT_FILTERS = {
    include: null,
    exclude: [{ repoNamePattern: '.*' }],
} satisfies ContextFilters

interface SearchAttributionResults {
    limitHit: boolean
    nodes: { repositoryName: string }[]
}

export interface CodyLLMSiteConfiguration {
    chatModel?: string
    chatModelMaxTokens?: number
    fastChatModel?: string
    fastChatModelMaxTokens?: number
    completionModel?: string
    completionModelMaxTokens?: number
    provider?: string
    smartContextWindow?: boolean
}

export interface CurrentUserCodySubscription {
    status: string
    plan: string
    applyProRateLimits: boolean
    currentPeriodStartAt: Date
    currentPeriodEndAt: Date
}

export interface CurrentUserInfo {
    id: string
    hasVerifiedEmail: boolean
    username: string
    displayName?: string
    avatarURL: string
    primaryEmail?: { email: string } | null
    organizations: {
        nodes: { name: string; id: string }[]
    }
}

interface EvaluatedFeatureFlag {
    name: string
    value: boolean
}

interface EvaluatedFeatureFlagsResponse {
    evaluatedFeatureFlags: EvaluatedFeatureFlag[]
}

interface EvaluateFeatureFlagResponse {
    evaluateFeatureFlag: boolean
}

function extractDataOrError<T, R>(response: APIResponse<T> | Error, extract: (data: T) => R): R | Error {
    if (isError(response)) {
        return response
    }
    if (response.errors && response.errors.length > 0) {
        return new Error(response.errors.map(({ message }) => message).join(', '))
    }
    if (!response.data) {
        return new Error('response is missing data')
    }
    return extract(response.data)
}

/**
 * @deprecated Use 'TelemetryEvent' instead.
 */
export interface event {
    event: string
    userCookieID: string
    url: string
    source: string
    argument?: string | unknown
    publicArgument?: string | unknown
    client: string
    connectedSiteID?: string
    hashedLicenseKey?: string
}

export type GraphQLAPIClientConfig = Pick<
    ConfigurationWithAccessToken,
    'serverEndpoint' | 'accessToken' | 'customHeaders'
> &
    Pick<Partial<ConfigurationWithAccessToken>, 'telemetryLevel'>

export let customUserAgent: string | undefined
export function addCustomUserAgent(headers: Headers): void {
    if (customUserAgent) {
        headers.set('User-Agent', customUserAgent)
    }
}
export function setUserAgent(newUseragent: string): void {
    customUserAgent = newUseragent
}

const QUERY_TO_NAME_REGEXP = /^\s*(?:query|mutation)\s+(\w+)/m

export class SourcegraphGraphQLAPIClient {
    private dotcomUrl = DOTCOM_URL
    public anonymousUserID: string | undefined

    /**
     * Should be set on extension activation via `localStorage.onConfigurationChange(config)`
     * Done to avoid passing the graphql client around as a parameter and instead
     * access it as a singleton via the module import.
     */
    private _config: GraphQLAPIClientConfig | null = null

    private get config(): GraphQLAPIClientConfig {
        if (!this._config) {
            throw new Error('GraphQLAPIClientConfig is not set')
        }

        return this._config
    }

    private isAgentTesting = process.env.CODY_SHIM_TESTING === 'true'

    constructor(config: GraphQLAPIClientConfig | null = null) {
        this._config = config
    }

    public onConfigurationChange(newConfig: GraphQLAPIClientConfig): void {
        this._config = newConfig
    }

    /**
     * If set, anonymousUID is transmitted as 'X-Sourcegraph-Actor-Anonymous-UID'
     * which is automatically picked up by Sourcegraph backends 5.2+
     */
    public setAnonymousUserID(anonymousUID: string): void {
        this.anonymousUserID = anonymousUID
    }

    public isDotCom(): boolean {
        return isDotCom(this.config.serverEndpoint)
    }

    // Gets the server endpoint for this client.
    public get endpoint(): string {
        return this.config.serverEndpoint
    }

    public async getSiteVersion(): Promise<string | Error> {
        return this.fetchSourcegraphAPI<APIResponse<SiteVersionResponse>>(
            CURRENT_SITE_VERSION_QUERY,
            {}
        ).then(response =>
            extractDataOrError(
                response,
                data => data.site?.productVersion ?? new Error('site version not found')
            )
        )
    }

    public async getRemoteFiles(
        repositories: string[],
        query: string
    ): Promise<FuzzyFindFile[] | Error> {
        return this.fetchSourcegraphAPI<APIResponse<FuzzyFindFilesResponse>>(FUZZY_FILES_QUERY, {
            query: `type:path count:30 ${
                repositories.length > 0 ? `repo:^(${repositories.map(escapeRegExp).join('|')})$` : ''
            } ${query}`,
        }).then(response =>
            extractDataOrError(
                response,
                data => data.search?.results.results ?? new Error('no files found')
            )
        )
    }

    public async getRemoteSymbols(
        repositories: string[],
        query: string
    ): Promise<FuzzyFindSymbol[] | Error> {
        return this.fetchSourcegraphAPI<APIResponse<FuzzyFindSymbolsResponse>>(FUZZY_SYMBOLS_QUERY, {
            query: `type:symbol count:30 ${
                repositories.length > 0 ? `repo:^(${repositories.map(escapeRegExp).join('|')})$` : ''
            } ${query}`,
        }).then(response =>
            extractDataOrError(
                response,
                data => data.search?.results.results ?? new Error('no symbols found')
            )
        )
    }

    public async getFileContent(
        repository: string,
        filePath: string,
        range?: { startLine?: number; endLine?: number }
    ): Promise<string | Error> {
        return this.fetchSourcegraphAPI<APIResponse<RemoteFileContentReponse>>(GET_REMOTE_FILE_QUERY, {
            repositoryName: repository,
            filePath,
            startLine: range?.startLine,
            endLine: range?.endLine,
        }).then(response =>
            extractDataOrError(
                response,
                data => data.repository.commit.blob.content ?? new Error('no file found')
            )
        )
    }

    public async getSiteIdentification(): Promise<{ siteid: string; hashedLicenseKey: string } | Error> {
        const response = await this.fetchSourcegraphAPI<APIResponse<SiteIdentificationResponse>>(
            CURRENT_SITE_IDENTIFICATION,
            {}
        )
        return extractDataOrError(response, data =>
            data.site?.siteID
                ? data.site?.productSubscription?.license?.hashedKey
                    ? {
                          siteid: data.site?.siteID,
                          hashedLicenseKey: data.site?.productSubscription?.license?.hashedKey,
                      }
                    : new Error('site hashed license key not found')
                : new Error('site ID not found')
        )
    }

    public async getSiteHasIsCodyEnabledField(): Promise<boolean | Error> {
        return this.fetchSourcegraphAPI<APIResponse<SiteGraphqlFieldsResponse>>(
            CURRENT_SITE_GRAPHQL_FIELDS_QUERY,
            {}
        ).then(response =>
            extractDataOrError(
                response,
                data => !!data.__type?.fields?.find(field => field.name === 'isCodyEnabled')
            )
        )
    }

    public async getSiteHasCodyEnabled(): Promise<boolean | Error> {
        return this.fetchSourcegraphAPI<APIResponse<SiteHasCodyEnabledResponse>>(
            CURRENT_SITE_HAS_CODY_ENABLED_QUERY,
            {}
        ).then(response => extractDataOrError(response, data => data.site?.isCodyEnabled ?? false))
    }

    public async getCurrentUserId(): Promise<string | Error> {
        return this.fetchSourcegraphAPI<APIResponse<CurrentUserIdResponse>>(
            CURRENT_USER_ID_QUERY,
            {}
        ).then(response =>
            extractDataOrError(response, data =>
                data.currentUser ? data.currentUser.id : new Error('current user not found')
            )
        )
    }

    public async getCurrentUserCodyProEnabled(): Promise<{ codyProEnabled: boolean } | Error> {
        return this.fetchSourcegraphAPI<APIResponse<CurrentUserCodyProEnabledResponse>>(
            CURRENT_USER_CODY_PRO_ENABLED_QUERY,
            {}
        ).then(response =>
            extractDataOrError(response, data =>
                data.currentUser ? { ...data.currentUser } : new Error('current user not found')
            )
        )
    }

    public async getCurrentUserCodySubscription(): Promise<CurrentUserCodySubscription | Error> {
        return this.fetchSourcegraphAPI<APIResponse<CurrentUserCodySubscriptionResponse>>(
            CURRENT_USER_CODY_SUBSCRIPTION_QUERY,
            {}
        ).then(response =>
            extractDataOrError(response, data =>
                data.currentUser?.codySubscription
                    ? data.currentUser.codySubscription
                    : new Error('current user subscription data not found')
            )
        )
    }

    public async getCurrentUserInfo(): Promise<CurrentUserInfo | Error> {
        return this.fetchSourcegraphAPI<APIResponse<CurrentUserInfoResponse>>(
            CURRENT_USER_INFO_QUERY,
            {}
        ).then(response =>
            extractDataOrError(response, data =>
                data.currentUser ? { ...data.currentUser } : new Error('current user not found')
            )
        )
    }

    /**
     * Fetches the Site Admin enabled/disable Cody config features for the current instance.
     */
    public async getCodyConfigFeatures(): Promise<CodyConfigFeatures | Error> {
        const response = await this.fetchSourcegraphAPI<APIResponse<CodyConfigFeaturesResponse>>(
            CURRENT_SITE_CODY_CONFIG_FEATURES,
            {}
        )
        return extractDataOrError(
            response,
            data => data.site?.codyConfigFeatures ?? new Error('cody config not found')
        )
    }

    public async getCodyLLMConfiguration(): Promise<undefined | CodyLLMSiteConfiguration | Error> {
        // fetch Cody LLM provider separately for backward compatability
        const [configResponse, providerResponse, smartContextWindow] = await Promise.all([
            this.fetchSourcegraphAPI<APIResponse<CodyLLMSiteConfigurationResponse>>(
                CURRENT_SITE_CODY_LLM_CONFIGURATION
            ),
            this.fetchSourcegraphAPI<APIResponse<CodyLLMSiteConfigurationProviderResponse>>(
                CURRENT_SITE_CODY_LLM_PROVIDER
            ),
            this.getCodyLLMConfigurationSmartContext(),
        ])

        const config = extractDataOrError(
            configResponse,
            data => data.site?.codyLLMConfiguration || undefined
        )
        if (!config || isError(config)) {
            return config
        }

        let provider: string | undefined
        const llmProvider = extractDataOrError(
            providerResponse,
            data => data.site?.codyLLMConfiguration?.provider
        )
        if (llmProvider && !isError(llmProvider)) {
            provider = llmProvider
        }

        return { ...config, provider, smartContextWindow }
    }

    async getCodyLLMConfigurationSmartContext(): Promise<boolean> {
        return (
            this.fetchSourcegraphAPI<APIResponse<CodyEnterpriseConfigSmartContextResponse>>(
                CURRENT_SITE_CODY_LLM_CONFIGURATION_SMART_CONTEXT,
                {}
            )
                .then(response => {
                    const smartContextResponse = extractDataOrError(
                        response,
                        data => data?.site?.codyLLMConfiguration?.smartContextWindow ?? ''
                    )

                    if (isError(smartContextResponse)) {
                        throw new Error(smartContextResponse.message)
                    }

                    return smartContextResponse !== 'disabled'
                })
                // For backward compatibility, return false by default when the query fails.
                .catch(() => false)
        )
    }

    public async getPackageList(
        kind: string,
        name: string,
        first: number,
        after?: string
    ): Promise<PackageListResponse | Error> {
        return this.fetchSourcegraphAPI<APIResponse<PackageListResponse>>(PACKAGE_LIST_QUERY, {
            kind,
            name,
            first,
            after: after || null,
        }).then(response => extractDataOrError(response, data => data))
    }

    /**
     * Gets a subset of the list of repositories from the Sourcegraph instance.
     * @param first the number of repositories to retrieve.
     * @param after the last repository retrieved, if any, to continue enumerating the list.
     * @returns the list of repositories. If `endCursor` is null, this is the end of the list.
     */
    public async getRepoList(first: number, after?: string): Promise<RepoListResponse | Error> {
        return this.fetchSourcegraphAPI<APIResponse<RepoListResponse>>(REPOSITORY_LIST_QUERY, {
            first,
            after: after || null,
        }).then(response => extractDataOrError(response, data => data))
    }

    /**
     * Searches for repositories from the Sourcegraph instance.
     * @param first the number of repositories to retrieve.
     * @param after the last repository retrieved, if any, to continue enumerating the list.
     * @param query the query to search the repositories.
     * @returns the list of repositories. If `endCursor` is null, this is the end of the list.
     */
    public async searchRepos(
        first: number,
        after?: string,
        query?: string
    ): Promise<RepoSearchResponse | Error> {
        return this.fetchSourcegraphAPI<APIResponse<RepoSearchResponse>>(REPOSITORY_SEARCH_QUERY, {
            first,
            after: after || null,
            query,
        }).then(response => extractDataOrError(response, data => data))
    }

    public async searchFileMatches(query?: string): Promise<FileMatchSearchResponse | Error> {
        return this.fetchSourcegraphAPI<APIResponse<FileMatchSearchResponse>>(FILE_MATCH_SEARCH_QUERY, {
            query,
        }).then(response => extractDataOrError(response, data => data))
    }

    public async getFileContents(
        repoName: string,
        filePath: string,
        rev?: string
    ): Promise<FileContentsResponse | Error> {
        return this.fetchSourcegraphAPI<APIResponse<FileContentsResponse>>(FILE_CONTENTS_QUERY, {
            repoName,
            filePath,
            rev,
        }).then(response => extractDataOrError(response, data => data))
    }

    public async getRepoId(repoName: string): Promise<string | null | Error> {
        return this.fetchSourcegraphAPI<APIResponse<RepositoryIdResponse>>(REPOSITORY_ID_QUERY, {
            name: repoName,
        }).then(response =>
            extractDataOrError(response, data => (data.repository ? data.repository.id : null))
        )
    }

    public async getRepoIds(
        names: string[],
        first: number
    ): Promise<{ name: string; id: string }[] | Error> {
        return this.fetchSourcegraphAPI<APIResponse<RepositoryIdsResponse>>(REPOSITORY_IDS_QUERY, {
            names,
            first,
        }).then(response => extractDataOrError(response, data => data.repositories?.nodes || []))
    }

    public async getRepoName(cloneURL: string): Promise<string | null> {
        const response = await this.fetchSourcegraphAPI<APIResponse<RepositoryNameResponse>>(
            REPO_NAME_QUERY,
            {
                cloneURL,
            }
        )

        const result = extractDataOrError(response, data => data.repository?.name ?? null)
        return isError(result) ? null : result
    }

    public async contextSearch(
        repoIDs: string[],
        query: string
    ): Promise<ContextSearchResult[] | null | Error> {
        return this.fetchSourcegraphAPI<APIResponse<ContextSearchResponse>>(CONTEXT_SEARCH_QUERY, {
            repos: repoIDs,
            query,
            codeResultsCount: 15,
            textResultsCount: 5,
        }).then(response =>
            extractDataOrError(response, data =>
                (data.getCodyContext || []).map(item => ({
                    commit: item.blob.commit.oid,
                    repoName: item.blob.repository.name,
                    path: item.blob.path,
                    uri: URI.parse(
                        `${this.endpoint}${item.blob.repository.name}/-/blob/${item.blob.path}?L${
                            item.startLine + 1
                        }-${item.endLine}`
                    ),
                    startLine: item.startLine,
                    endLine: item.endLine,
                    content: item.chunkContent,
                }))
            )
        )
    }

    public async contextFilters(): Promise<ContextFilters> {
        // CONTEXT FILTERS are only available on Sourcegraph 5.3.3 and later.
        const minimumVersion = '5.3.3'
        const { enabled, version } = await this.isCodyEnabled()
        const insiderBuild = version.length > 12 || version.includes('dev')
        const isValidVersion = insiderBuild || semver.gte(version, minimumVersion)
        if (!enabled || !isValidVersion) {
            return INCLUDE_EVERYTHING_CONTEXT_FILTERS
        }

        const response =
            await this.fetchSourcegraphAPI<APIResponse<ContextFiltersResponse | null>>(
                CONTEXT_FILTERS_QUERY
            )

        const result = extractDataOrError(response, data => {
            if (data?.site?.codyContextFilters?.raw === null) {
                return INCLUDE_EVERYTHING_CONTEXT_FILTERS
            }

            if (data?.site?.codyContextFilters?.raw) {
                return data.site.codyContextFilters.raw
            }

            // Exclude everything in case of an unexpected response structure.
            return EXCLUDE_EVERYTHING_CONTEXT_FILTERS
        })

        if (result instanceof Error) {
            // Ignore errors caused by outdated Sourcegraph API instances.
            if (hasOutdatedAPIErrorMessages(result)) {
                return INCLUDE_EVERYTHING_CONTEXT_FILTERS
            }

            logError('SourcegraphGraphQLAPIClient', 'contextFilters', result.message)
            // Exclude everything in case of an unexpected error.
            return EXCLUDE_EVERYTHING_CONTEXT_FILTERS
        }

        return result
    }

    /**
     * Checks if Cody is enabled on the current Sourcegraph instance.
     * @returns
     * enabled: Whether Cody is enabled.
     * version: The Sourcegraph version.
     *
     * This method first checks the Sourcegraph version using `getSiteVersion()`.
     * If the version is before 5.0.0, Cody is disabled.
     * If the version is 5.0.0 or newer, it checks for the existence of the `isCodyEnabled` field using `getSiteHasIsCodyEnabledField()`.
     * If the field exists, it calls `getSiteHasCodyEnabled()` to check its value.
     * If the field does not exist, Cody is assumed to be enabled for versions between 5.0.0 - 5.1.0.
     */
    public async isCodyEnabled(): Promise<{ enabled: boolean; version: string }> {
        // Check site version.
        const siteVersion = await this.getSiteVersion()
        if (isError(siteVersion)) {
            return { enabled: false, version: 'unknown' }
        }
        const insiderBuild = siteVersion.length > 12 || siteVersion.includes('dev')
        if (insiderBuild) {
            return { enabled: true, version: siteVersion }
        }
        // NOTE: Cody does not work on version later than 5.0
        const versionBeforeCody = semver.lt(siteVersion, '5.0.0')
        if (versionBeforeCody) {
            return { enabled: false, version: siteVersion }
        }
        // Beta version is betwewen 5.0.0 - 5.1.0 and does not have isCodyEnabled field
        const betaVersion = semver.gte(siteVersion, '5.0.0') && semver.lt(siteVersion, '5.1.0')
        const hasIsCodyEnabledField = await this.getSiteHasIsCodyEnabledField()
        // The isCodyEnabled field does not exist before version 5.1.0
        if (!betaVersion && !isError(hasIsCodyEnabledField) && hasIsCodyEnabledField) {
            const siteHasCodyEnabled = await this.getSiteHasCodyEnabled()
            return {
                enabled: !isError(siteHasCodyEnabled) && siteHasCodyEnabled,
                version: siteVersion,
            }
        }
        return { enabled: insiderBuild || betaVersion, version: siteVersion }
    }

    /**
     * recordTelemetryEvents uses the new Telemetry API to record events that
     * gets exported: https://sourcegraph.com/docs/dev/background-information/telemetry
     *
     * Only available on Sourcegraph 5.2.0 and later.
     *
     * DO NOT USE THIS DIRECTLY - use an implementation of implementation
     * TelemetryRecorder from '@sourcegraph/telemetry' instead.
     */
    public async recordTelemetryEvents(events: TelemetryEventInput[]): Promise<unknown | Error> {
        for (const event of events) {
            this.anonymizeTelemetryEventInput(event)
        }
        const initialResponse = await this.fetchSourcegraphAPI<APIResponse<unknown>>(
            RECORD_TELEMETRY_EVENTS_MUTATION,
            {
                events,
            }
        )
        return extractDataOrError(initialResponse, data => data)
    }

    /**
     * logEvent is the legacy event-logging mechanism.
     * @deprecated use an implementation of implementation TelemetryRecorder
     * from '@sourcegraph/telemetry' instead.
     */
    public async logEvent(event: event, mode: LogEventMode): Promise<LogEventResponse | Error> {
        if (process.env.CODY_TESTING === 'true') {
            return this.sendEventLogRequestToTestingAPI(event)
        }
        if (this.isAgentTesting) {
            return {}
        }
        if (this.config?.telemetryLevel === 'off') {
            return {}
        }
        /**
         * If connected to dotcom, just log events to the instance, as it means
         * the same thing.
         */
        if (this.isDotCom()) {
            return this.sendEventLogRequestToAPI(event)
        }

        switch (process.env.CODY_LOG_EVENT_MODE) {
            case 'connected-instance-only':
                mode = 'connected-instance-only'
                break
            case 'dotcom-only':
                mode = 'dotcom-only'
                break
            case 'all':
                mode = 'all'
                break
            default:
                if (process.env.CODY_LOG_EVENT_MODE) {
                    logDebug(
                        'SourcegraphGraphQLAPIClient.logEvent',
                        'unknown mode',
                        process.env.CODY_LOG_EVENT_MODE
                    )
                }
        }

        switch (mode) {
            /**
             * Only log events to dotcom, not the connected instance. Used when
             * another mechanism delivers event logs the instance (i.e. the
             * new telemetry clients)
             */
            case 'dotcom-only':
                return this.sendEventLogRequestToDotComAPI(event)

            /**
             * Only log events to the connected instance, not dotcom. Used when
             * another mechanism handles reporting to dotcom (i.e. the old
             * client and/or the new telemetry framework, which exports events
             * from all instances: https://sourcegraph.com/docs/dev/background-information/telemetry)
             */
            case 'connected-instance-only':
                return this.sendEventLogRequestToAPI(event)

            case 'all': // continue to default handling
        }

        /**
         * Otherwise, send events to the connected instance AND to dotcom (default)
         */
        const responses = await Promise.all([
            this.sendEventLogRequestToAPI(event),
            this.sendEventLogRequestToDotComAPI(event),
        ])
        if (isError(responses[0]) && isError(responses[1])) {
            return new Error(
                `Errors logging events: ${responses[0].toString()}, ${responses[1].toString()}`
            )
        }
        if (isError(responses[0])) {
            return responses[0]
        }
        if (isError(responses[1])) {
            return responses[1]
        }
        return {}
    }

    private anonymizeTelemetryEventInput(event: TelemetryEventInput): void {
        if (this.isAgentTesting) {
            event.timestamp = undefined
            event.parameters.interactionID = undefined
            event.parameters.billingMetadata = undefined
            event.parameters.metadata = undefined
            event.parameters.metadata = undefined
            event.parameters.privateMetadata = {}
        }
    }

    private anonymizeEvent(event: event): void {
        if (this.isAgentTesting) {
            event.publicArgument = undefined
            event.argument = undefined
            event.userCookieID = 'ANONYMOUS_USER_COOKIE_ID'
            event.hashedLicenseKey = undefined
        }
    }

    private async sendEventLogRequestToDotComAPI(event: event): Promise<LogEventResponse | Error> {
        this.anonymizeEvent(event)
        const response = await this.fetchSourcegraphDotcomAPI<APIResponse<LogEventResponse>>(
            LOG_EVENT_MUTATION,
            event
        )
        return extractDataOrError(response, data => data)
    }

    private async sendEventLogRequestToAPI(event: event): Promise<LogEventResponse | Error> {
        this.anonymizeEvent(event)
        const initialResponse = await this.fetchSourcegraphAPI<APIResponse<LogEventResponse>>(
            LOG_EVENT_MUTATION,
            event
        )
        const initialDataOrError = extractDataOrError(initialResponse, data => data)

        if (isError(initialDataOrError)) {
            const secondResponse = await this.fetchSourcegraphAPI<APIResponse<LogEventResponse>>(
                LOG_EVENT_MUTATION_DEPRECATED,
                event
            )
            return extractDataOrError(secondResponse, data => data)
        }

        return initialDataOrError
    }

    private async sendEventLogRequestToTestingAPI(event: event): Promise<LogEventResponse | Error> {
        const initialResponse =
            await this.fetchSourcegraphTestingAPI<APIResponse<LogEventResponse>>(event)
        const initialDataOrError = extractDataOrError(initialResponse, data => data)

        if (isError(initialDataOrError)) {
            const secondResponse =
                await this.fetchSourcegraphTestingAPI<APIResponse<LogEventResponse>>(event)
            return extractDataOrError(secondResponse, data => data)
        }

        return initialDataOrError
    }

    public async searchAttribution(snippet: string): Promise<SearchAttributionResults | Error> {
        return this.fetchSourcegraphAPI<APIResponse<SearchAttributionResponse>>(
            SEARCH_ATTRIBUTION_QUERY,
            {
                snippet,
            }
        ).then(response => extractDataOrError(response, data => data.snippetAttribution))
    }

    public async getEvaluatedFeatureFlags(): Promise<Record<string, boolean> | Error> {
        return this.fetchSourcegraphAPI<APIResponse<EvaluatedFeatureFlagsResponse>>(
            GET_FEATURE_FLAGS_QUERY,
            {}
        ).then(response => {
            return extractDataOrError(response, data =>
                data.evaluatedFeatureFlags.reduce((acc: Record<string, boolean>, { name, value }) => {
                    acc[name] = value
                    return acc
                }, {})
            )
        })
    }

    public async evaluateFeatureFlag(flagName: string): Promise<boolean | null | Error> {
        return this.fetchSourcegraphAPI<APIResponse<EvaluateFeatureFlagResponse>>(
            EVALUATE_FEATURE_FLAG_QUERY,
            {
                flagName,
            }
        ).then(response => extractDataOrError(response, data => data.evaluateFeatureFlag))
    }

    public fetchSourcegraphAPI<T>(
        query: string,
        variables: Record<string, any> = {},
        timeout = 6000 // Default timeout of 6000ms (6 seconds)
    ): Promise<T | Error> {
        const headers = new Headers(this.config.customHeaders as HeadersInit)
        headers.set('Content-Type', 'application/json; charset=utf-8')
        if (this.config.accessToken) {
            headers.set('Authorization', `token ${this.config.accessToken}`)
        }
        if (this.anonymousUserID && !process.env.CODY_WEB_DONT_SET_SOME_HEADERS) {
            headers.set('X-Sourcegraph-Actor-Anonymous-UID', this.anonymousUserID)
        }

        addTraceparent(headers)
        addCustomUserAgent(headers)

        const queryName = query.match(QUERY_TO_NAME_REGEXP)?.[1]

        const url = buildGraphQLUrl({
            request: query,
            baseUrl: this.config.serverEndpoint,
        })

        // Create an AbortController instance
        const controller = new AbortController()
        const signal = controller.signal

        // Set a timeout to trigger the abort
        const timeoutId = setTimeout(() => controller.abort(), timeout)

        return wrapInActiveSpan(`graphql.fetch${queryName ? `.${queryName}` : ''}`, () =>
            fetch(url, {
                method: 'POST',
                body: JSON.stringify({ query, variables }),
                headers,
                signal, // Pass the signal to the fetch request
            })
                .then(response => {
                    clearTimeout(timeoutId) // Clear the timeout if the request completes in time
                    return verifyResponseCode(response)
                })
                .then(response => response.json() as T)
                .catch(error => {
                    if (error.name === 'AbortError') {
                        return new Error(`EHOSTUNREACH: Request timed out after ${timeout}ms (${url})`)
                    }
                    return new Error(`accessing Sourcegraph GraphQL API: ${error} (${url})`)
                })
        )
    }
    // make an anonymous request to the dotcom API
    private fetchSourcegraphDotcomAPI<T>(
        query: string,
        variables: Record<string, any>
    ): Promise<T | Error> {
        const url = buildGraphQLUrl({
            request: query,
            baseUrl: this.dotcomUrl.href,
        })
        const headers = new Headers()
        addCustomUserAgent(headers)
        addTraceparent(headers)

        const queryName = query.match(QUERY_TO_NAME_REGEXP)?.[1]

        return wrapInActiveSpan(`graphql.dotcom.fetch${queryName ? `.${queryName}` : ''}`, () =>
            fetch(url, {
                method: 'POST',
                body: JSON.stringify({ query, variables }),
                headers,
            })
                .then(verifyResponseCode)
                .then(response => response.json() as T)
                .catch(error => new Error(`error fetching Sourcegraph GraphQL API: ${error} (${url})`))
        )
    }

    // make an anonymous request to the Testing API
    private fetchSourcegraphTestingAPI<T>(body: Record<string, any>): Promise<T | Error> {
        const url = 'http://localhost:49300/.test/testLogging'
        const headers = new Headers({
            'Content-Type': 'application/json',
        })
        addCustomUserAgent(headers)

        return fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        })
            .then(verifyResponseCode)
            .then(response => response.json() as T)
            .catch(error => new Error(`error fetching Testing Sourcegraph API: ${error} (${url})`))
    }

    // Performs an authenticated request to our non-GraphQL HTTP / REST API.
    public fetchHTTP<T>(
        queryName: string,
        method: string,
        urlPath: string,
        body?: string,
        timeout = 6000 // Default timeout of 6000ms (6 seconds)
    ): Promise<T | Error> {
        const headers = new Headers(this.config.customHeaders as HeadersInit)
        headers.set('Content-Type', 'application/json; charset=utf-8')
        if (this.config.accessToken) {
            headers.set('Authorization', `token ${this.config.accessToken}`)
        }
        if (this.anonymousUserID && !process.env.CODY_WEB_DONT_SET_SOME_HEADERS) {
            headers.set('X-Sourcegraph-Actor-Anonymous-UID', this.anonymousUserID)
        }

        addTraceparent(headers)
        addCustomUserAgent(headers)

        const url = new URL(urlPath, this.config.serverEndpoint).href

        // Create an AbortController instance
        const controller = new AbortController()
        const signal = controller.signal

        // Set a timeout to trigger the abort
        const timeoutId = setTimeout(() => controller.abort(), timeout)

        return wrapInActiveSpan(`httpapi.fetch${queryName ? `.${queryName}` : ''}`, () =>
            fetch(url, {
                method: method,
                body: body,
                headers,
                signal, // Pass the signal to the fetch request
            })
                .then(response => {
                    clearTimeout(timeoutId) // Clear the timeout if the request completes in time
                    return verifyResponseCode(response)
                })
                .then(response => response.json() as T)
                .catch(error => {
                    if (error.name === 'AbortError') {
                        return new Error(`EHOSTUNREACH: Request timed out after ${timeout}ms (${url})`)
                    }
                    return new Error(`accessing Sourcegraph HTTP API: ${error} (${url})`)
                })
        )
    }
}

/**
 * Singleton instance of the graphql client.
 * Should be configured on the extension activation via `graphqlClient.onConfigurationChange(config)`.
 */
export const graphqlClient = new SourcegraphGraphQLAPIClient()

/**
 * ClientConfigSingleton is a class that manages the retrieval
 * and caching of configuration features from GraphQL endpoints.
 */
export class ClientConfigSingleton {
    private static instance: ClientConfigSingleton
    private cachedClientConfig?: CodyClientConfig
    private featuresLegacy: Promise<CodyConfigFeatures>

    // Constructor is private to prevent creating new instances outside of the class
    private constructor() {
        // Fetch the latest client config periodically every 60 seconds
        setInterval(() => this.refreshConfig(), 60000)

        // Default values for the legacy GraphQL features API, used when a Sourcegraph instance
        // does not support even the legacy GraphQL API.
        this.featuresLegacy = Promise.resolve({
            chat: true,
            autoComplete: true,
            commands: true,
            attribution: false,
        })
    }

    // Static method to get the singleton instance
    public static getInstance(): ClientConfigSingleton {
        if (!ClientConfigSingleton.instance) {
            ClientConfigSingleton.instance = new ClientConfigSingleton()
        }
        return ClientConfigSingleton.instance
    }

    public async getConfig(): Promise<CodyClientConfig> {
        if (this.cachedClientConfig) {
            return this.cachedClientConfig
        }
        this.cachedClientConfig = await this.refreshConfig()
        return this.cachedClientConfig!
    }

    // Refreshes the config features by fetching them from the server and caching the result
    public async refreshConfig(): Promise<CodyClientConfig> {
        logDebug('ClientConfigSingleton', 'refreshing configuration')

        // Determine based on the site version if /.api/client-config is available.
        return graphqlClient
            .getSiteVersion()
            .then(siteVersion => {
                if (isError(siteVersion)) {
                    logError(
                        'ClientConfigSingleton',
                        'Failed to determine site version, GraphQL error',
                        siteVersion
                    )
                    return false // assume /.api/client-config is not supported
                }

                // Insiders and dev builds support the new /.api/client-config endpoint
                const insiderBuild = siteVersion.length > 12 || siteVersion.includes('dev')
                if (insiderBuild) {
                    return true
                }

                // Sourcegraph instances before 5.5.0 do not support the new /.api/client-config endpoint.
                if (semver.lt(siteVersion, '5.5.0')) {
                    return false
                }
                return true
            })
            .then(supportsClientConfig => {
                // If /.api/client-config is not available, fallback to the myriad of GraphQL
                // requests that we previously used to determine the client configuration
                if (!supportsClientConfig) {
                    return this.fetchClientConfigLegacy()
                }

                // Otherwise we use our centralized client config endpoint.
                return graphqlClient
                    .fetchHTTP<CodyClientConfig>('client-config', 'GET', '/.api/client-config')
                    .then(clientConfig => {
                        if (isError(clientConfig)) {
                            logError('ClientConfigSingleton', 'refresh client config', clientConfig)
                            throw clientConfig
                        }
                        return clientConfig
                    })
                    .catch(e => {
                        logError('ClientConfigSingleton', 'refresh client config', e)
                        throw e
                    })
            })
            .then(clientConfig => {
                logDebug('ClientConfigSingleton', 'refreshed', JSON.stringify(clientConfig))
                return clientConfig
            })
            .catch(e => {
                logError('ClientConfigSingleton', 'failed to refresh client config', e)
                throw e
            })
    }

    private async fetchClientConfigLegacy(): Promise<CodyClientConfig> {
        const previousFeaturesLegacy = await this.featuresLegacy

        // Note: all of these promises are written carefully to not throw errors internally, but
        // rather to return sane defaults, and so we do not catch() here.
        return graphqlClient.getCodyLLMConfigurationSmartContext().then(smartContextWindow =>
            this.fetchConfigFeaturesLegacy(previousFeaturesLegacy).then(features =>
                graphqlClient.isCodyEnabled().then(isCodyEnabled => ({
                    codyEnabled: isCodyEnabled.enabled,
                    chatEnabled: features.chat,
                    autoCompleteEnabled: features.autoComplete,
                    customCommandsEnabled: features.commands,
                    attributionEnabled: features.attribution,
                    smartContextWindowEnabled: smartContextWindow,

                    // Things that did not exist before logically default to disabled.
                    modelsAPIEnabled: false,
                }))
            )
        )
    }

    // Fetches the config features from the server and handles errors, using the old/legacy GraphQL API.
    private async fetchConfigFeaturesLegacy(
        defaultErrorValue: CodyConfigFeatures
    ): Promise<CodyConfigFeatures> {
        const features = await graphqlClient.getCodyConfigFeatures()
        if (features instanceof Error) {
            // An error here most likely indicates the Sourcegraph instance is so old that it doesn't
            // even support this legacy GraphQL API.
            logError('ClientConfigSingleton', 'refreshConfig', features)
            return defaultErrorValue
        }
        return features
    }
}

export async function verifyResponseCode(
    response: BrowserOrNodeResponse
): Promise<BrowserOrNodeResponse> {
    if (!response.ok) {
        const body = await response.text()
        throw new Error(`HTTP status code ${response.status}${body ? `: ${body}` : ''}`)
    }
    return response
}

export type LogEventMode =
    | 'dotcom-only' // only log to dotcom
    | 'connected-instance-only' // only log to the connected instance
    | 'all' // log to both dotcom AND the connected instance

function hasOutdatedAPIErrorMessages(error: Error): boolean {
    // Sourcegraph 5.2.3 returns an empty string ("") instead of an error message
    // when querying non-existent codyContextFilters; this produces
    // 'Unexpected end of JSON input'
    return (
        error.message.includes('Cannot query field') ||
        error.message.includes('Unexpected end of JSON input')
    )
}
