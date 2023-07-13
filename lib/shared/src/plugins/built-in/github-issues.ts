import fetch from 'isomorphic-fetch'
import { pick } from 'lodash'

import { IPlugin, IPluginAPI, IPluginFunctionOutput, IPluginFunctionParameters } from '../api/types'

const org = 'sourcegraph'

const defaultBaseURL = 'https://api.github.com/'
const path = '/search/issues'

interface User {
    name: string | null
    login: string
    html_url?: string
    url?: string
}

interface Item {
    title: string
    body: string
    html_url: string
    assignee: User | null
    user: User | null
    created_at: string
    updated_at: string
    state: string
}

interface OutputItem extends Omit<Item, 'html_url'> {
    url: Item['html_url']
}

interface GitHubResponse {
    items: Item[]
}

const searchGitHub = async (query: string, baseUrl: string, apiToken: string): Promise<OutputItem[]> => {
    const url = new URL(path, baseUrl)
    // TODO: what is a good limit of results here?
    url.searchParams.set('per_page', '2')
    url.searchParams.set('q', `${query} org:${org}`)
    const opts = {
        method: 'GET',
        headers: {
            Authorization: apiToken,
            'Content-Type': 'application/json',
        },
    }

    try {
        const rawResponse = await fetch(url, opts)
        const response = (await rawResponse.json()) as GitHubResponse

        const items = response?.items
        return items.map(item => {
            const title = item.title.slice(0, 180) // up to 180 characters
            const body = removeHtmlTags(item.body).slice(0, 300) // up to 300 characters
            const user: User | null = item.user
                ? {
                      name: item.user.name,
                      login: item.user.login,
                      url: item.user.html_url,
                  }
                : null
            const assignee: User | null = item.assignee
                ? {
                      name: item.assignee.name,
                      login: item.assignee.login,
                      url: item.assignee.html_url,
                  }
                : null
            const output: OutputItem = {
                ...pick(item, ['created_at', 'updated_at', 'state']),
                title,
                body,
                user,
                assignee,
                url: item.html_url,
            }
            return output
        })
    } catch (error) {
        // Handle and log any errors
        console.error('Error in searchGitHub:', error)
        throw error
    }
}

// todo: add isEnabled check function
export const githubIssuesPlugin: IPlugin = {
    name: 'GitHub Issues plugin',
    description:
        'Search GitHub Issues and pull requests. Use this to understand current code problems, feature implementations, their rationale, and to gain deeper insights into various topics.',
    dataSources: [
        {
            name: 'search_github_issues',
            description:
                'Search GitHub Issues and pull requests. Use this to understand current code problems, feature implementations, their rationale, and to gain deeper insights into various topics.',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Query, uses github issue search query format',
                    },
                },
                required: ['query'],
            },
            handler: async (
                parameters: IPluginFunctionParameters,
                api: IPluginAPI
            ): Promise<IPluginFunctionOutput[]> => {
                const { query } = parameters

                if (typeof query !== 'string') {
                    return Promise.reject(new Error('Invalid parameters'))
                }
                const apiToken = api.config?.github?.apiToken
                if (!apiToken) {
                    return Promise.reject(new Error('Missing GitHub API token'))
                }
                const baseUrl = api.config?.github?.baseURL ?? defaultBaseURL

                return searchGitHub(query, baseUrl, apiToken)
            },
        },
    ],
}

// This function is meant to sanitize confluence content that's semi-html:
// <h1> hello </h1> and @@@h1@@@ hello @@@endh1@@@ will both result in `hello`.
function removeHtmlTags(input: string): string {
    return input.replace(/<[^>]+>|@@@[^@]+@@@/g, '')
}
