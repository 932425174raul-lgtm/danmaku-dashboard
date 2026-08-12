import { createHmac, randomBytes, randomUUID } from 'node:crypto'

import { BrowserWindow, session } from 'electron'
import { z } from 'zod'

import {
  decodeDouyinChatFrame,
  decodeDouyinPushFrame,
  DouyinProtocolError,
} from '../protocol/douyin-web-v1/push-frame'
import type { DouyinCollector, DouyinCollectorCallbacks } from './douyin-collector'

const websocketCreatedSchema = z.object({
  requestId: z.string().min(1),
  url: z.string().url(),
})

const websocketRequestSchema = z.object({
  requestId: z.string().min(1),
})

const websocketFrameSchema = z.object({
  requestId: z.string().min(1),
  response: z.object({
    opcode: z.number().int(),
    payloadData: z.string(),
  }),
})

const CONNECT_TIMEOUT_MS = 30_000
const MAX_BASE64_FRAME_LENGTH = 1_500_000

export class DouyinBrowserCollector implements DouyinCollector {
  private window: BrowserWindow | null = null
  private callbacks: DouyinCollectorCallbacks | null = null
  private connectTimer: NodeJS.Timeout | null = null
  private readonly liveSocketIds = new Set<string>()
  private connected = false
  private stopping = false
  private pageLoaded = false
  private pageVisible = false
  private binaryFrameCount = 0
  private lastDecodeErrorCode: string | null = null
  private callbackChain: Promise<void> = Promise.resolve()

  constructor(private readonly userSalt: Uint8Array = randomBytes(32)) {}

  async start(url: string, callbacks: DouyinCollectorCallbacks): Promise<void> {
    if (this.window !== null) {
      throw new Error('COLLECTOR_ALREADY_STARTED')
    }

    this.callbacks = callbacks
    this.stopping = false
    this.connected = false
    this.pageLoaded = false
    this.pageVisible = false
    this.binaryFrameCount = 0
    this.lastDecodeErrorCode = null
    this.liveSocketIds.clear()
    this.callbackChain = Promise.resolve()
    const collectorSession = session.fromPartition(`douyin-anonymous-${randomUUID()}`, {
      cache: false,
    })

    collectorSession.setPermissionCheckHandler(() => false)
    collectorSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false)
    })
    collectorSession.on('will-download', (event) => event.preventDefault())

    const window = new BrowserWindow({
      show: false,
      paintWhenInitiallyHidden: true,
      webPreferences: {
        session: collectorSession,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        devTools: false,
        backgroundThrottling: false,
        offscreen: true,
      },
    })
    this.window = window
    window.webContents.setAudioMuted(true)
    window.webContents.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    )
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-attach-webview', (event) => event.preventDefault())
    window.webContents.on('will-navigate', (event, navigationUrl) => {
      try {
        if (new URL(navigationUrl).origin !== 'https://live.douyin.com') {
          event.preventDefault()
        }
      } catch {
        event.preventDefault()
      }
    })
    window.on('closed', () => {
      if (this.window === window) {
        this.window = null
      }
      if (!this.stopping) {
        this.reportError('COLLECTOR_WINDOW_CLOSED')
      }
    })
    window.webContents.on('did-finish-load', () => {
      this.pageLoaded = true
      void window.webContents
        .executeJavaScript("document.visibilityState === 'visible'", true)
        .then((visible) => {
          this.pageVisible = visible === true
        })
        .catch(() => undefined)
    })

    window.webContents.debugger.attach('1.3')
    window.webContents.debugger.on('message', (_event, method, params) => {
      this.handleDebuggerMessage(method, params)
    })

    this.connectTimer = setTimeout(() => {
      if (!this.connected && !this.stopping) {
        let code = 'NO_DECODABLE_FRAME'
        if (!this.pageLoaded) code = 'ROOM_PAGE_NOT_LOADED'
        else if (!this.pageVisible) code = 'ROOM_PAGE_HIDDEN'
        else if (this.liveSocketIds.size === 0) code = 'NO_WEBSOCKET_CONNECTION'
        else if (this.binaryFrameCount === 0) code = 'NO_BINARY_FRAME'
        else if (this.lastDecodeErrorCode !== null) code = this.lastDecodeErrorCode
        this.reportError(code)
      }
    }, CONNECT_TIMEOUT_MS)

    void window.webContents.debugger
      .sendCommand('Network.enable')
      .catch(() => this.reportError('DEBUGGER_NETWORK_FAILED'))
    void window
      .loadURL(url, { httpReferrer: 'https://live.douyin.com/' })
      .catch(() => this.reportError('ROOM_PAGE_LOAD_FAILED'))
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.clearConnectTimer()
    this.liveSocketIds.clear()
    const window = this.window
    this.window = null
    this.callbacks = null
    this.connected = false
    this.pageLoaded = false
    this.pageVisible = false
    this.binaryFrameCount = 0
    this.lastDecodeErrorCode = null
    this.callbackChain = Promise.resolve()
    if (window !== null && !window.isDestroyed()) {
      if (window.webContents.debugger.isAttached()) {
        window.webContents.debugger.detach()
      }
      window.destroy()
    }
  }

  private handleDebuggerMessage(method: string, params: unknown): void {
    if (method === 'Network.webSocketCreated') {
      const parsed = websocketCreatedSchema.safeParse(params)
      if (!parsed.success) return
      try {
        if (new URL(parsed.data.url).pathname.startsWith('/webcast/im/push/v2')) {
          this.liveSocketIds.add(parsed.data.requestId)
        }
      } catch {
        return
      }
      return
    }

    if (method === 'Network.webSocketClosed' || method === 'Network.webSocketFrameError') {
      const parsed = websocketRequestSchema.safeParse(params)
      if (!parsed.success || !this.liveSocketIds.delete(parsed.data.requestId)) return
      if (this.connected && this.liveSocketIds.size === 0 && !this.stopping) {
        this.reportError('WEBSOCKET_DISCONNECTED')
      }
      return
    }

    if (method !== 'Network.webSocketFrameReceived') return
    const parsed = websocketFrameSchema.safeParse(params)
    if (
      !parsed.success ||
      !this.liveSocketIds.has(parsed.data.requestId) ||
      parsed.data.response.opcode !== 2 ||
      parsed.data.response.payloadData.length > MAX_BASE64_FRAME_LENGTH
    ) {
      return
    }

    this.binaryFrameCount += 1
    const frame = Buffer.from(parsed.data.response.payloadData, 'base64')
    let chats: ReturnType<typeof decodeDouyinChatFrame>
    try {
      decodeDouyinPushFrame(frame)
      chats = decodeDouyinChatFrame(frame, (platformUserId) =>
        createHmac('sha256', this.userSalt)
          .update(platformUserId)
          .digest()
          .subarray(0, 16)
          .toString('base64url'),
      )
    } catch (error) {
      this.lastDecodeErrorCode =
        error instanceof DouyinProtocolError ? `FRAME_${error.code}` : 'FRAME_DECODE_FAILED'
      return
    }

    if (!this.connected) {
      this.connected = true
      this.clearConnectTimer()
      this.enqueueCallback(() => this.callbacks?.onConnected())
    }
    if (chats.length > 0) {
      this.enqueueCallback(() => this.callbacks?.onChats(chats))
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
  }

  private async invokeCallback(callback: () => Promise<void> | undefined): Promise<void> {
    try {
      await callback()
    } catch {
      this.reportError('CALLBACK_FAILED')
    }
  }

  private enqueueCallback(callback: () => Promise<void> | undefined): void {
    this.callbackChain = this.callbackChain.then(() => this.invokeCallback(callback))
  }

  private reportError(code: string): void {
    const callback = this.callbacks?.onError
    if (callback !== undefined) void callback(code).catch(() => undefined)
  }
}
