import { execFile } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { MakerBase, type MakerOptions } from '@electron-forge/maker-base'
import type { ForgePlatform } from '@electron-forge/shared-types'

const execFileAsync = promisify(execFile)

export class HdiutilDmgMaker extends MakerBase<Record<string, never>> {
  name = 'dmg'
  defaultPlatforms: ForgePlatform[] = ['darwin']
  requiredExternalBinaries = ['/usr/bin/hdiutil']

  constructor() {
    super({})
  }

  isSupportedOnCurrentPlatform(): boolean {
    return process.platform === 'darwin'
  }

  async make({ dir, makeDir, appName, packageJSON, targetArch }: MakerOptions): Promise<string[]> {
    const version = packageJSON.version
    if (typeof version !== 'string' || version.length === 0) {
      throw new Error('PACKAGE_VERSION_REQUIRED')
    }

    this.ensureExternalBinariesExist()
    await mkdir(makeDir, { recursive: true })

    const outputPath = resolve(makeDir, `${appName}-${version}-${targetArch}.dmg`)
    const stagingRoot = await mkdtemp(join(tmpdir(), 'danmaku-dashboard-dmg-'))

    try {
      await cp(join(dir, `${appName}.app`), join(stagingRoot, `${appName}.app`), {
        recursive: true,
      })
      await symlink('/Applications', join(stagingRoot, 'Applications'))
      await this.ensureFile(outputPath)
      await execFileAsync('/usr/bin/hdiutil', [
        'create',
        '-volname',
        appName,
        '-srcfolder',
        stagingRoot,
        '-format',
        'ULFO',
        '-ov',
        outputPath,
      ])
      return [outputPath]
    } finally {
      await rm(stagingRoot, { recursive: true, force: true })
    }
  }
}
