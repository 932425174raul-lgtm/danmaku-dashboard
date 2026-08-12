import { createWriteStream } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'

import MakerBase, { type MakerOptions } from '@electron-forge/maker-base'
import type { ForgePlatform } from '@electron-forge/shared-types'
import { ZipFile } from 'yazl'

async function addDirectory(
  zipFile: ZipFile,
  sourceRoot: string,
  directory: string,
): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const sourcePath = join(directory, entry.name)
    if (entry.isDirectory()) await addDirectory(zipFile, sourceRoot, sourcePath)
    else if (entry.isFile()) {
      zipFile.addFile(sourcePath, `${basename(sourceRoot)}/${relative(sourceRoot, sourcePath)}`)
    }
  }
}

export class WindowsZipMaker extends MakerBase<Record<string, never>> {
  name = 'windows-zip'
  defaultPlatforms: ForgePlatform[] = ['win32']

  isSupportedOnCurrentPlatform(): boolean {
    return true
  }

  async make({ dir, makeDir, packageJSON, targetArch }: MakerOptions): Promise<string[]> {
    const zipPath = resolve(
      makeDir,
      'zip',
      'win32',
      targetArch,
      `${basename(dir)}-${packageJSON.version}.zip`,
    )
    await this.ensureFile(zipPath)

    const zipFile = new ZipFile()
    await addDirectory(zipFile, dir, dir)
    await new Promise<void>((resolveArchive, rejectArchive) => {
      const output = createWriteStream(zipPath)
      output.on('close', resolveArchive)
      output.on('error', rejectArchive)
      zipFile.outputStream.on('error', rejectArchive)
      zipFile.outputStream.pipe(output)
      zipFile.end()
    })

    return [zipPath]
  }
}
