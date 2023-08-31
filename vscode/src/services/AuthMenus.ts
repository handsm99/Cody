import * as vscode from 'vscode'

import { isDotCom, isLocalApp } from '@sourcegraph/cody-shared/src/sourcegraph-api/environments'

export interface LoginMenuItem {
    id: string
    label: string
    description: string
    totalSteps: number
    uri: string
}

export interface LoginInput {
    endpoint: string | null | undefined
    token: string | null | undefined
}

export type AuthMenuType = 'signin' | 'signout' | 'switch'

function getItemLabel(uri: string, current: boolean): string {
    const icon = current ? '$(check) ' : ''
    if (isLocalApp(uri)) {
        return `${icon}Cody App`
    }
    if (isDotCom(uri)) {
        return `${icon}Sourcegraph.com`
    }
    return `${icon}${uri}`
}

export const AuthMenu = async (type: AuthMenuType, historyItems: string[]): Promise<LoginMenuItem | null> => {
    // Create option items
    const historySize = historyItems?.length
    const history =
        historySize > 0
            ? historyItems
                  ?.map((uri, i) => ({
                      id: uri,
                      label: getItemLabel(uri, type === 'switch' && i === historySize - 1),
                      description: type === 'signout' && i === 0 ? 'current' : '',
                      uri,
                  }))
                  .reverse()
            : []
    const separator = [{ label: type === 'signin' ? 'previously used' : 'current', kind: -1 }]
    const optionItems = type === 'signout' ? history : [...LoginMenuOptionItems, ...separator, ...history]
    const option = (await vscode.window.showQuickPick(optionItems, AuthMenuOptions[type])) as LoginMenuItem
    return option
}

/**
 * Show a VS Code input box to ask the user to enter a Sourcegraph instance URL.
 */
export async function showInstanceURLInputBox(title: string): Promise<string | undefined> {
    const result = await vscode.window.showInputBox({
        title,
        prompt: 'Enter the URL of the Sourcegraph instance',
        placeHolder: 'https://sourcegraph.example.com',
        password: false,
        ignoreFocusOut: true,
    })

    if (typeof result === 'string') {
        return result.trim()
    }
    return result
}

/**
 * Show a VS Code input box to ask the user to enter an access token.
 */
export async function showAccessTokenInputBox(endpoint: string): Promise<string | undefined> {
    const result = await vscode.window.showInputBox({
        title: endpoint,
        prompt: 'Paste your access token. To create an access token, go to "Settings" and then "Access tokens" on the Sourcegraph instance.',
        placeHolder: 'Access Token',
        password: true,
        ignoreFocusOut: true,
    })

    if (typeof result === 'string') {
        return result.trim()
    }
    return result
}

export const AuthMenuOptions = {
    signin: {
        title: 'Other Sign in Options',
        placeholder: 'Choose a sign in option',
    },
    signout: {
        title: 'Sign Out',
        placeHolder: 'Choose instance to sign out',
    },
    switch: {
        title: 'Switch Account',
        placeHolder: 'Choose an account',
    },
}

export const LoginMenuOptionItems = [
    {
        id: 'enterprise',
        label: 'Sign in to Sourcegraph Enterprise instance',
        description: 'v5.1 and above',
        totalSteps: 1,
        picked: true,
    },
    {
        id: 'token',
        label: 'Sign in to Sourcegraph Enterprise instance via Access Token',
        description: 'v5.0 and above',
        totalSteps: 2,
    },
    {
        id: 'dotcom',
        label: 'Sign in to Sourcegraph.com',
        totalSteps: 0,
    },
    {
        id: 'token',
        label: 'Sign in with URL and Access Token',
        totalSteps: 2,
    },
]
