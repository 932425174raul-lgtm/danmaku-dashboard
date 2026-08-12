import { randomUUID } from 'node:crypto'

import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'

import { HISTORY_IPC_CHANNELS } from '../../contracts/ipc-v1/channels'
import type { StorageReader } from '../storage/storage-reader-client'

interface HistoryWriter {
  deleteSession(sessionId: number, deletedAtMs: number): Promise<void>
}

const sessionInputSchema = z.object({ sessionId: z.number().int().positive().safe() }).strict()
const cursorSchema = z
  .object({ receivedAtMs: z.number().int().nonnegative(), id: z.number().int().positive() })
  .strict()
const pageInputSchema = sessionInputSchema.extend({ before: cursorSchema.optional() }).strict()
const searchInputSchema = pageInputSchema.extend({ query: z.string().max(200) }).strict()
const confirmationInputSchema = z.object({ confirmationId: z.string().uuid() }).strict()
const DELETE_CONFIRMATION_TTL_MS = 30_000

function isTrustedSender(
  event: IpcMainInvokeEvent,
  mainWindow: BrowserWindow | null,
  developmentOrigin?: string,
): boolean {
  if (mainWindow === null || event.sender.id !== mainWindow.webContents.id) return false
  if (event.senderFrame === null || event.senderFrame.parent !== null) return false
  try {
    const sender = new URL(event.senderFrame.url)
    if (sender.protocol === 'app:' && sender.hostname === 'renderer') return true
    return developmentOrigin !== undefined && sender.origin === new URL(developmentOrigin).origin
  } catch {
    return false
  }
}

export function registerHistoryIpc(
  ipcMain: IpcMain,
  reader: StorageReader,
  writer: HistoryWriter,
  getMainWindow: () => BrowserWindow | null,
  developmentOrigin?: string,
): () => void {
  const trusted = (event: IpcMainInvokeEvent) =>
    isTrustedSender(event, getMainWindow(), developmentOrigin)
  const confirmations = new Map<
    string,
    { sessionId: number; senderId: number; expiresAtMs: number }
  >()

  ipcMain.handle(HISTORY_IPC_CHANNELS.list, async (event) => {
    if (!trusted(event)) throw new Error('UNTRUSTED_IPC_SENDER')
    const sessions = await reader.listSessions(50)
    return sessions.map((session) => ({
      id: session.id,
      platform: session.platform,
      roomId: session.roomId,
      roomTitle: session.roomTitle,
      anchorDisplayName: session.anchorDisplayName,
      startedAtMs: session.startedAtMs,
      endedAtMs: session.endedAtMs,
      status: session.status,
      danmakuCount: session.danmakuCount,
      activeUserCount: session.activeUserCount,
      giftCount: session.giftCount,
      superChatCount: session.superChatCount,
    }))
  })
  ipcMain.handle(HISTORY_IPC_CHANNELS.listDanmaku, async (event, input: unknown) => {
    if (!trusted(event)) throw new Error('UNTRUSTED_IPC_SENDER')
    const parsed = pageInputSchema.parse(input)
    return reader.listDanmaku(parsed.sessionId, {
      limit: 100,
      ...(parsed.before === undefined ? {} : { before: parsed.before }),
    })
  })
  ipcMain.handle(HISTORY_IPC_CHANNELS.getReview, async (event, input: unknown) => {
    if (!trusted(event)) throw new Error('UNTRUSTED_IPC_SENDER')
    const parsed = sessionInputSchema.parse(input)
    return reader.getSessionReview(parsed.sessionId)
  })
  ipcMain.handle(HISTORY_IPC_CHANNELS.searchDanmaku, async (event, input: unknown) => {
    if (!trusted(event)) throw new Error('UNTRUSTED_IPC_SENDER')
    const parsed = searchInputSchema.parse(input)
    return reader.searchDanmaku(parsed.sessionId, parsed.query, {
      limit: 100,
      ...(parsed.before === undefined ? {} : { before: parsed.before }),
    })
  })
  ipcMain.handle(HISTORY_IPC_CHANNELS.prepareDelete, async (event, input: unknown) => {
    if (!trusted(event)) throw new Error('UNTRUSTED_IPC_SENDER')
    const parsed = sessionInputSchema.parse(input)
    const session = (await reader.listSessions(50)).find((item) => item.id === parsed.sessionId)
    if (session === undefined || session.status === 'active') {
      return { ok: false, code: 'COLLECTOR_STOP_FAILED' } as const
    }
    confirmations.clear()
    const confirmationId = randomUUID()
    confirmations.set(confirmationId, {
      sessionId: parsed.sessionId,
      senderId: event.sender.id,
      expiresAtMs: Date.now() + DELETE_CONFIRMATION_TTL_MS,
    })
    return { ok: true, confirmationId } as const
  })
  ipcMain.handle(HISTORY_IPC_CHANNELS.confirmDelete, async (event, input: unknown) => {
    if (!trusted(event)) throw new Error('UNTRUSTED_IPC_SENDER')
    const parsed = confirmationInputSchema.parse(input)
    const confirmation = confirmations.get(parsed.confirmationId)
    confirmations.delete(parsed.confirmationId)
    if (
      confirmation === undefined ||
      confirmation.senderId !== event.sender.id ||
      confirmation.expiresAtMs < Date.now()
    ) {
      return { ok: false, code: 'COLLECTOR_STOP_FAILED' } as const
    }
    try {
      await writer.deleteSession(confirmation.sessionId, Date.now())
      return { ok: true } as const
    } catch {
      return { ok: false, code: 'COLLECTOR_STOP_FAILED' } as const
    }
  })

  return () => {
    confirmations.clear()
    for (const channel of Object.values(HISTORY_IPC_CHANNELS)) ipcMain.removeHandler(channel)
  }
}
