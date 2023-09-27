import { promises as fspromises } from 'fs'
import * as os from 'os'
import * as path from 'path'

import axios from 'axios'
import * as unzip from 'unzipper'
import * as vscode from 'vscode'

import { logDebug } from '../log'

const symfVersion = 'v0.0.1'

/**
 * Get the path to `symf`. If the symf binary is not found, download it.
 */
export async function getSymfPath(context: vscode.ExtensionContext): Promise<string | null> {
    // If user-specified symf path is set, use that
    const config = vscode.workspace.getConfiguration()
    const userSymfPath = config.get<string>('cody.experimental.symf.path')
    if (userSymfPath) {
        logDebug('symf', `using user symf: ${userSymfPath}`)
        return userSymfPath
    }

    const osArch = getOSArch()
    if (!osArch) {
        return null
    }
    const { platform, arch } = osArch

    const symfContainingDir = path.join(context.globalStorageUri.fsPath, 'symf')
    const symfFilename = `symf-${symfVersion}-${arch}-${platform}`
    const symfPath = path.join(symfContainingDir, symfFilename)
    if (await fileExists(symfPath)) {
        return symfPath
    }

    const symfURL = `https://github.com/sourcegraph/symf/releases/download/${symfVersion}/symf-${arch}-${platform}.zip`
    logDebug('symf', `downloading symf from ${symfURL}`)

    // Download symf binary with vscode progress api
    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Downloading semantic code search utility, symf',
            cancellable: false,
        },
        async progress => {
            progress.report({ message: 'Downloading symf and extracting symf' })

            const symfTmpDir = symfPath + '.tmp'

            await downloadFile(symfURL, symfTmpDir)
            logDebug('symf', `downloaded symf to ${symfTmpDir}`)

            const tmpFile = path.join(symfTmpDir, `symf-${arch}-${platform}`)
            await fspromises.chmod(tmpFile, 0o755)
            await fspromises.rename(tmpFile, symfPath)
            await fspromises.rmdir(symfTmpDir, { recursive: true })

            logDebug('symf', `extracted symf to ${symfPath}`)
        }
    )
    void removeOldSymfBinaries(symfContainingDir, symfFilename)

    return symfPath
}

function getOSArch(): { platform: string; arch: string } | null {
    const nodePlatformToPlatform: { [key: string]: string } = {
        darwin: 'macos',
        linux: 'linux',
        win32: 'windows',
    }
    const nodeMachineToArch: { [key: string]: string } = {
        arm64: 'aarch64',
        aarch64: 'aarch64',
        x86_64: 'x86_64',
        i386: 'x86',
        i686: 'x86',
    }

    const platform = nodePlatformToPlatform[os.platform()]
    const arch = nodeMachineToArch[os.machine()]
    if (!platform || !arch) {
        // show vs code error message
        void vscode.window.showErrorMessage(`No symf binary available for ${os.platform()}/${os.machine()}`)
        return null
    }
    return {
        platform,
        arch,
    }
}

async function fileExists(path: string): Promise<boolean> {
    try {
        await fspromises.access(path)
        return true
    } catch {
        return false
    }
}

async function downloadFile(url: string, outputPath: string): Promise<void> {
    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream',
        maxRedirects: 10,
    })

    const uz = unzip.Extract({ path: outputPath })
    response.data.pipe(uz)

    await new Promise((resolve, reject) => {
        uz.on('finish', resolve)
        uz.on('error', reject)
    })
}

async function removeOldSymfBinaries(containingDir: string, currentSymfPath: string): Promise<void> {
    const symfDirContents = await fspromises.readdir(containingDir)
    const oldSymfBinaries = symfDirContents.filter(f => f.startsWith('symf-') && f !== currentSymfPath)
    for (const oldSymfBinary of oldSymfBinaries) {
        await fspromises.rm(path.join(containingDir, oldSymfBinary))
    }
}
