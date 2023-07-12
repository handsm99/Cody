import { ChatClient } from '../../chat/chat';
import { Configuration } from '../../configuration'
import { Message } from '../../sourcegraph-api/completions/types'

import { makePrompt } from './prompt'
import { IPlugin, IPluginFunctionCallDescriptor, IPluginFunctionChosenDescriptor } from './types'

export const chooseDataSources = (
    humanChatInput: string,
    client: ChatClient,
    plugins: IPlugin[],
    history: Message[] = []
): Promise<[string, IPluginFunctionCallDescriptor][]> => {
    const allDataSources = plugins.flatMap(plugin => plugin.dataSources)

    const messages = makePrompt(
        humanChatInput,
        allDataSources.map(({ handler, ...rest }) => rest),
        history
    )
    return new Promise<[string, IPluginFunctionCallDescriptor][]>((resolve, reject) => {
        let lastResponse = ''
        client.chat(
            messages,
            {
                onChange: text => {
                    lastResponse = text
                },
                onComplete: () => {
                    try {
                        const descriptors = JSON.parse(lastResponse.trim()) as IPluginFunctionChosenDescriptor[]
                        resolve(
                            descriptors.map(item => {
                                const dataSource = allDataSources.find(dataSource => dataSource.name === item.name)
                                const plugin = plugins.find(plugin =>
                                    plugin.dataSources.some(ds => ds.name === item.name)
                                )
                                return [plugin?.name, [dataSource, item.parameters]] as [
                                    string,
                                    IPluginFunctionCallDescriptor
                                ]
                            })
                        )
                    } catch (error) {
                        reject(new Error(`Error parsing llm intent detection response: ${error}`))
                    }
                },
                onError: (error, statusCode) => {
                    reject(new Error(`error: ${error}\nstatus code: ${statusCode}`))
                },
            },
            {
                fast: true,
            }
        )
    })
}

export const getContext = async (
    dataSourcesCallDescriptors: IPluginFunctionCallDescriptor[],
    config: Configuration['plugins']
): Promise<Message[]> => {
    let outputs = await Promise.all(
        dataSourcesCallDescriptors.map(async ([dataSource, parameters]) => {
            const response = await dataSource.handler(parameters, { config }).catch(error => {
                console.error(error)
                return []
            })

            if (!response.length) {
                return
            }

            return `from ${dataSource.name} data source:\n\`\`\`json\n${JSON.stringify(response)}`
        })
    )

    outputs = outputs.filter(Boolean)
    if (outputs.length === 0) {
        return []
    }

    return [
        {
            speaker: 'human',
            text: 'I have following responses from external APIs that I called now:\n' + outputs.join('\n'),
        },
        {
            speaker: 'assistant',
            text: 'Understood, I have additional knowledge when answering your question.',
        },
    ]
}