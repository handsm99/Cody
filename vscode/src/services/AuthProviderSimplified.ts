import * as vscode from 'vscode'

import { DOTCOM_URL } from '@sourcegraph/cody-shared'

import type { AuthMethod } from '../chat/protocol'

import type { AuthProvider } from './AuthProvider'

// An auth provider for simplified onboarding. This is a sidecar to AuthProvider
// so we can deprecate the experiment later. AuthProviderSimplified only works
// for dotcom, and doesn't work on VScode web. See LoginSimplified.

export class AuthProviderSimplified {
    public async openExternalAuthUrl(
        classicAuthProvider: AuthProvider,
        method: AuthMethod,
        tokenReceiverUrl?: string
    ): Promise<void> {
        if (!(await openExternalAuthUrl(method, tokenReceiverUrl))) {
            return
        }
        classicAuthProvider.authProviderSimplifiedWillAttemptAuth()
    }
}

// Opens authentication URLs for simplified onboarding.
function openExternalAuthUrl(provider: AuthMethod, tokenReceiverUrl?: string): Thenable<boolean> {
    // Create the chain of redirects:
    // 1. Specific login page (GitHub, etc.) redirects to the post-sign up survey
    // 2. Post-sign up survery redirects to the new token page
    // 3. New token page redirects back to the extension with the new token
    const uriScheme = vscode.env.uriScheme
    const referralCode =
        {
            'vscode-insiders': 'CODY_INSIDERS',
            vscodium: 'CODY_VSCODIUM',
        }[uriScheme] || 'CODY'
    const tokenReceiver = tokenReceiverUrl
        ? `&tokenReceiverUrl=${encodeURIComponent(tokenReceiverUrl)}`
        : ''

    // FIXME: It's a complete mystery to me why a double URL decoding is necessary for this.
    const newTokenUrl = encodeURIComponent(
        encodeURIComponent(
            `/user/settings/tokens/new/callback?requestFrom=${referralCode}${tokenReceiver}`
        )
    )
    const postSignUpSurveyUrl = encodeURIComponent(`/post-sign-up?returnTo=${newTokenUrl}`)
    const site = DOTCOM_URL.toString() // Note, ends with the path /

    const genericLoginUrl = `${site}sign-in?returnTo=${postSignUpSurveyUrl}`
    const gitHubLoginUrl = `${site}.auth/openidconnect/login?prompt_auth=github&pc=sams&redirect=${postSignUpSurveyUrl}`
    const gitLabLoginUrl = `${site}.auth/openidconnect/login?prompt_auth=gitlab&pc=sams&redirect=${postSignUpSurveyUrl}`
    const googleLoginUrl = `${site}.auth/openidconnect/login?prompt_auth=google&pc=sams&redirect=${postSignUpSurveyUrl}`

    let uriSpec: string
    switch (provider) {
        case 'github':
            uriSpec = gitHubLoginUrl
            break
        case 'gitlab':
            uriSpec = gitLabLoginUrl
            break
        case 'google':
            uriSpec = googleLoginUrl
            break
        default:
            // This login form has links to other login methods, it is the best
            // catch-all
            uriSpec = genericLoginUrl
            break
    }

    // VScode Uri handling escapes ?, = in the redirect parameter. dotcom's
    // redirectTo handling does not unescape these. As a result we route
    // /post-sign-up%3F... as a search. Work around VScode's Uri handling
    // by passing a string which gets passed through to a string|Uri parameter
    // anyway.

    // FIXME: Pass a Uri here when dotcom redirectTo handling applies one level
    // of unescaping to the parameter, or we special case the routing for
    // /post-sign-up%3F...
    return vscode.env.openExternal(uriSpec as unknown as vscode.Uri)
}
