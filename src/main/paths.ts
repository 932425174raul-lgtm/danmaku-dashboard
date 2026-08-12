import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, resolve, win32 } from 'node:path'

import type { App } from 'electron'

import type { LaunchMode } from './environment'

interface AppPathRoots {
  home: string
  userData: string
}

export function resolveSessionDataPath(platform: NodeJS.Platform, roots: AppPathRoots): string {
  if (platform === 'darwin') {
    return posix.join(
      roots.home,
      'Library',
      'Caches',
      'com.songjinzhao.danmaku-dashboard',
      'Chromium',
    )
  }
  if (platform === 'win32') return win32.join(roots.userData, 'Chromium')
  throw new Error('UNSUPPORTED_DESKTOP_PLATFORM')
}

export function configureAppPaths(
  app: App,
  launchMode: LaunchMode,
  platform: NodeJS.Platform = process.platform,
): () => void {
  app.setName('弹幕看板')

  if (launchMode.kind !== 'app') {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'danmaku-dashboard-electron-'))
    const sessionDataPath = join(temporaryRoot, 'Chromium')
    mkdirSync(sessionDataPath, { recursive: true })
    app.setPath('userData', temporaryRoot)
    app.setPath('sessionData', sessionDataPath)
    return () => rmSync(temporaryRoot, { recursive: true, force: true })
  }

  const sessionDataPath = resolveSessionDataPath(platform, {
    home: app.getPath('home'),
    userData: app.getPath('userData'),
  })
  mkdirSync(sessionDataPath, { recursive: true })
  app.setPath('sessionData', sessionDataPath)
  app.setAppLogsPath()
  return () => undefined
}

export function getPreloadPath(bundleDirectory: string): string {
  return join(bundleDirectory, 'preload.js')
}

export function getWorkerPath(bundleDirectory: string, role: 'reader' | 'writer'): string {
  return join(bundleDirectory, `${role}.js`)
}

export function getRendererRoot(bundleDirectory: string, rendererName: string): string {
  return resolve(bundleDirectory, '..', 'renderer', rendererName)
}
