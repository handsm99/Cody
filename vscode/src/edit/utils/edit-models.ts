import { type AuthStatus, ModelProvider } from '@sourcegraph/cody-shared'
import { type EditModel, ModelUsage } from '@sourcegraph/cody-shared/src/models/types'
import type { EditIntent } from '../types'

export function getEditModelsForUser(authStatus: AuthStatus): ModelProvider[] {
    return ModelProvider.getProviders(ModelUsage.Edit, authStatus.isDotCom && !authStatus.userCanUpgrade)
}

export function getOverridenModelForIntent(intent: EditIntent, currentModel: EditModel): EditModel {
    switch (intent) {
        case 'fix':
            // Edit commands have only been tested with Claude 2. Default to that for now.
            return 'anthropic/claude-2.0'
        case 'doc':
            return 'anthropic/claude-3-haiku-20240307'
        case 'test':
        case 'add':
        case 'edit':
            // Support all model usage for add and edit intents.
            return currentModel
    }
}
