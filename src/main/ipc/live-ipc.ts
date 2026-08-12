import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'

import { LIVE_IPC_CHANNELS } from '../../contracts/ipc-v1/channels'
import type { LiveCommandResult, LiveSnapshot, StartLiveInput } from '../../contracts/ipc-v1/live'

interface LiveServiceApi {
  getSnapshot(): LiveSnapshot
  start(input: StartLiveInput): Promise<LiveCommandResult>
  stop(): Promise<LiveCommandResult>
  subscribe(listener: (snapshot: LiveSnapshot) => void): () => void
}

const MAX_IPC_DANMAKU = 200
const MAX_IPC_BYTES = 256 * 1_024

export function limitLiveSnapshotForIpc(snapshot: LiveSnapshot): LiveSnapshot {
  const recentDanmaku = snapshot.recentDanmaku.slice(-MAX_IPC_DANMAKU)
  const limited = { ...snapshot, recentDanmaku }
  while (Buffer.byteLength(JSON.stringify(limited), 'utf8') > MAX_IPC_BYTES) {
    if (recentDanmaku.length === 0) {
      throw new Error('LIVE_SNAPSHOT_TOO_LARGE')
    }
    recentDanmaku.shift()
  }
  return limited
}

const startInputSchema = z.object({
  platform: z.enum(['bilibili', 'douyin']),
  roomInput: z.string().min(1).max(256),
})

function isTrustedSender(event: IpcMainInvokeEvent, developmentOrigin?: string): boolean {
  try {
    if (event.senderFrame === null) return false
    if (event.senderFrame.parent !== null) return false
    const sender = new URL(event.senderFrame.url)
    if (sender.protocol === 'app:' && sender.hostname === 'renderer') {
      return true
    }
    return developmentOrigin !== undefined && sender.origin === new URL(developmentOrigin).origin
  } catch {
    return false
  }
}

export function registerLiveIpc(
  ipcMain: IpcMain,
  service: LiveServiceApi,
  getMainWindow: () => BrowserWindow | null,
  developmentOrigin?: string,
): () => void {
  ipcMain.handle(LIVE_IPC_CHANNELS.getSnapshot, (event) => {
    const window = getMainWindow()
    if (window === null || event.sender.id !== window.webContents.id) {
      throw new Error('UNTRUSTED_IPC_SENDER')
    }
    if (!isTrustedSender(event, developmentOrigin)) {
      throw new Error('UNTRUSTED_IPC_SENDER')
    }
    return limitLiveSnapshotForIpc(service.getSnapshot())
  })
  ipcMain.handle(LIVE_IPC_CHANNELS.start, async (event, input: unknown) => {
    const window = getMainWindow()
    if (window === null || event.sender.id !== window.webContents.id) {
      throw new Error('UNTRUSTED_IPC_SENDER')
    }
    if (!isTrustedSender(event, developmentOrigin)) {
      throw new Error('UNTRUSTED_IPC_SENDER')
    }
    const parsed = startInputSchema.safeParse(input)
    if (!parsed.success) {
      return { ok: false, code: 'INVALID_ROOM_INPUT' } as const
    }
    return service.start(parsed.data satisfies StartLiveInput)
  })
  ipcMain.handle(LIVE_IPC_CHANNELS.stop, async (event) => {
    const window = getMainWindow()
    if (window === null || event.sender.id !== window.webContents.id) {
      throw new Error('UNTRUSTED_IPC_SENDER')
    }
    if (!isTrustedSender(event, developmentOrigin)) {
      throw new Error('UNTRUSTED_IPC_SENDER')
    }
    return service.stop()
  })

  const unsubscribe = service.subscribe((snapshot) => {
    const window = getMainWindow()
    if (window !== null && !window.isDestroyed()) {
      window.webContents.send(LIVE_IPC_CHANNELS.snapshot, limitLiveSnapshotForIpc(snapshot))
    }
  })

  return () => {
    unsubscribe()
    ipcMain.removeHandler(LIVE_IPC_CHANNELS.getSnapshot)
    ipcMain.removeHandler(LIVE_IPC_CHANNELS.start)
    ipcMain.removeHandler(LIVE_IPC_CHANNELS.stop)
  }
}
