import { join } from 'node:path'

import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  protocol,
  safeStorage,
  Tray,
} from 'electron'

import { BilibiliCollector } from './collector/bilibili-collector'
import { CollectionService } from './collector/collection-service'
import { DouyinBrowserCollector } from './collector/douyin-browser-collector'
import { parseLaunchMode } from './environment'
import { registerHistoryIpc } from './ipc/history-ipc'
import { registerLiveIpc } from './ipc/live-ipc'
import { installRendererProtocol, registerRendererScheme } from './lifecycle/app-protocol'
import { configureAppPaths, getPreloadPath, getRendererRoot, getWorkerPath } from './paths'
import { BilibiliBootstrapClient } from './protocol/bilibili-web-v1/bootstrap-client'
import { IdentityKeyStore } from './storage/identity-key-store'
import { StorageReaderClient } from './storage/storage-reader-client'
import { StorageWriterClient } from './storage/storage-writer-client'
import { runRuntimeVerification } from './verification/runner'
import { runPackagedBenchmark } from './verification/benchmark'

registerRendererScheme(protocol)
const launchMode = parseLaunchMode(process.argv)
const cleanupAppPaths = configureAppPaths(app, launchMode)

let mainWindow: BrowserWindow | null = null
let isQuitting = false
let liveService: CollectionService | null = null
let unregisterLiveIpc: (() => void) | null = null
let unregisterHistoryIpc: (() => void) | null = null
let tray: Tray | null = null
let storageReader: StorageReaderClient | null = null
let quitInProgress = false
let quitReady = false

async function createMainWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 620,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0d0c',
    title: '弹幕看板',
    webPreferences: {
      preload: getPreloadPath(__dirname),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: MAIN_WINDOW_VITE_DEV_SERVER_URL !== undefined,
    },
  })

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  window.webContents.session.on('will-download', (event) => event.preventDefault())
  window.webContents.session.setPermissionCheckHandler(() => false)
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL !== undefined) {
    await window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws:; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          ],
        },
      })
    })
  }

  window.once('ready-to-show', () => window.show())
  window.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      window.hide()
    }
  })
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null
    }
  })

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    await window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL)
  } else {
    await window.loadURL('app://renderer/index.html')
  }

  return window
}

async function runApplication(): Promise<void> {
  if (launchMode.kind === 'invalid') {
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, status: 'error', code: launchMode.code })}\n`,
    )
    app.exit(2)
    return
  }

  const hasLock = app.requestSingleInstanceLock({ mode: launchMode.kind })
  if (!hasLock) {
    if (launchMode.kind !== 'app') {
      process.stdout.write(
        `${JSON.stringify({ schemaVersion: 1, status: 'error', code: 'APP_ALREADY_RUNNING' })}\n`,
      )
    }
    app.exit(1)
    return
  }

  app.on('before-quit', (event) => {
    isQuitting = true
    if (quitReady) return
    if (quitInProgress) {
      event.preventDefault()
      return
    }
    event.preventDefault()
    quitInProgress = true
    const forceQuit = setTimeout(() => {
      quitReady = true
      app.quit()
    }, 10_000)
    void liveService
      ?.dispose()
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(forceQuit)
        quitReady = true
        app.quit()
      })
  })
  app.on('will-quit', () => {
    unregisterLiveIpc?.()
    unregisterHistoryIpc?.()
    void storageReader?.shutdown().catch(() => undefined)
  })
  app.on('second-instance', () => {
    if (mainWindow !== null) {
      mainWindow.show()
      mainWindow.focus()
    }
  })
  app.on('activate', () => {
    if (mainWindow !== null) {
      mainWindow.show()
      mainWindow.focus()
      return
    }
    void createMainWindow().then((window) => {
      mainWindow = window
    })
  })
  app.on('window-all-closed', () => undefined)

  await app.whenReady()

  if (launchMode.kind === 'verify-runtime') {
    app.exit(await runRuntimeVerification(safeStorage, __dirname))
    return
  }

  if (launchMode.kind === 'benchmark') {
    app.exit(await runPackagedBenchmark(launchMode.profile, __dirname, app.getPath('userData')))
    return
  }

  installRendererProtocol(protocol, getRendererRoot(__dirname, MAIN_WINDOW_VITE_NAME))
  const databasePath = join(app.getPath('userData'), 'library.sqlite3')
  const storageWriter = new StorageWriterClient(getWorkerPath(__dirname, 'writer'), databasePath)
  await storageWriter.initialize()
  storageReader = new StorageReaderClient(getWorkerPath(__dirname, 'reader'), databasePath)
  const hmacKey = new IdentityKeyStore(join(app.getPath('userData'), 'identity-key'), {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plainText) => safeStorage.encryptString(plainText),
    decrypt: (cipherText) => safeStorage.decryptString(cipherText),
  }).getOrCreate()
  liveService = new CollectionService(
    {
      createSession: (input) => storageWriter.createSession(input),
      appendBatch: (sessionId, events) => storageWriter.appendBatch(sessionId, events),
      finalizeSession: (sessionId, reason, endedAtMs) =>
        storageWriter.finalizeSession(sessionId, reason, endedAtMs),
      openGap: (sessionId, reason, startedAtMs) =>
        storageWriter.openGap(sessionId, reason, startedAtMs),
      closeGap: (sessionId, endedAtMs, recovered) =>
        storageWriter.closeGap(sessionId, endedAtMs, recovered),
      shutdown: () => storageWriter.shutdown(),
    },
    hmacKey,
    () =>
      new BilibiliCollector({
        bootstrap: new BilibiliBootstrapClient({
          userAgent: `Mozilla/5.0 (Macintosh; Apple Silicon Mac OS X) AppleWebKit/537.36 Chrome/${process.versions.chrome} Safari/537.36`,
        }),
      }),
    () => new DouyinBrowserCollector(hmacKey),
  )
  unregisterLiveIpc = registerLiveIpc(
    ipcMain,
    liveService,
    () => mainWindow,
    MAIN_WINDOW_VITE_DEV_SERVER_URL,
  )
  unregisterHistoryIpc = registerHistoryIpc(
    ipcMain,
    storageReader,
    storageWriter,
    () => mainWindow,
    MAIN_WINDOW_VITE_DEV_SERVER_URL,
  )
  mainWindow = await createMainWindow()
  const trayIcon = nativeImage
    .createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAALElEQVR4AWMYBaNgFIyCUQAzMDD8Z2Bg+I8uRjMYjWAwGsFgNIIBDAwA3pQD/u87BlYAAAAASUVORK5CYII=',
    )
    .resize({ width: 16, height: 16 })
  trayIcon.setTemplateImage(true)
  tray = new Tray(trayIcon)
  tray.setToolTip('弹幕看板')
  const updateTray = (snapshot = liveService?.getSnapshot()) => {
    const active =
      snapshot !== undefined &&
      ['waiting', 'connecting', 'collecting', 'recovering', 'stopping'].includes(snapshot.status)
    const statusLabel = active
      ? `${snapshot.roomDisplay ?? '直播间'} · ${snapshot.status === 'collecting' ? '正在采集' : snapshot.status === 'recovering' ? '正在重连' : '正在连接'}`
      : '当前没有采集任务'
    tray?.setToolTip(active ? `弹幕看板 · ${statusLabel}` : '弹幕看板')
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: statusLabel, enabled: false },
        { type: 'separator' },
        {
          label: '显示弹幕看板',
          click: () => {
            mainWindow?.show()
            mainWindow?.focus()
          },
        },
        { label: '停止采集', click: () => void liveService?.stop(), enabled: active },
        { type: 'separator' },
        {
          label: '退出',
          click: () => {
            isQuitting = true
            app.quit()
          },
        },
      ]),
    )
  }
  updateTray()
  const unsubscribeTray = liveService.subscribe(updateTray)
  app.once('will-quit', unsubscribeTray)
  tray.on('click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
}

void runApplication()
  .catch(() => {
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, status: 'error', code: 'APP_START_FAILED' })}\n`,
    )
    app.exit(1)
  })
  .finally(cleanupAppPaths)
