import { getEditorRepoFileID } from './api'

const repository = {
    name: 'sourcegraph/sourcegraph',
    url: 'https://github.com/sourcegraph/sourcegraph',
    commit: {
        oid: 'deadbeef',
    },
    file: {
        path: 'index.ts',
        content: '// Hello world!',
    },
}
export const getRepoId = () => {
    return getEditorRepoFileID(repository.name, repository.file.path, repository.commit.oid)
}
