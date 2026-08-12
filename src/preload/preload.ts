import { contextBridge, ipcRenderer } from 'electron'

import { HISTORY_IPC_CHANNELS, LIVE_IPC_CHANNELS } from '../contracts/ipc-v1/channels'
import type { DanmakuAppApi, HistoryPageCursor, LiveSnapshot } from '../contracts/ipc-v1/live'

const api: DanmakuAppApi = {
  apiVersion: 1,
  live: Object.freeze({
    getSnapshot: () => ipcRenderer.invoke(LIVE_IPC_CHANNELS.getSnapshot) as Promise<LiveSnapshot>,
    start: (input) => ipcRenderer.invoke(LIVE_IPC_CHANNELS.start, input),
    stop: () => ipcRenderer.invoke(LIVE_IPC_CHANNELS.stop),
    subscribe: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, snapshot: LiveSnapshot) => {
        listener(snapshot)
      }
      ipcRenderer.on(LIVE_IPC_CHANNELS.snapshot, handler)
      return () => ipcRenderer.removeListener(LIVE_IPC_CHANNELS.snapshot, handler)
    },
  }),
  history: Object.freeze({
    list: () => ipcRenderer.invoke(HISTORY_IPC_CHANNELS.list),
    getReview: (sessionId: number) =>
      ipcRenderer.invoke(HISTORY_IPC_CHANNELS.getReview, { sessionId }),
    listDanmaku: (sessionId: number, before?: HistoryPageCursor) =>
      ipcRenderer.invoke(HISTORY_IPC_CHANNELS.listDanmaku, {
        sessionId,
        ...(before === undefined ? {} : { before }),
      }),
    searchDanmaku: (sessionId: number, query: string, before?: HistoryPageCursor) =>
      ipcRenderer.invoke(HISTORY_IPC_CHANNELS.searchDanmaku, {
        sessionId,
        query,
        ...(before === undefined ? {} : { before }),
      }),
    deleteSession: async (sessionId: number) => {
      const prepared = (await ipcRenderer.invoke(HISTORY_IPC_CHANNELS.prepareDelete, {
        sessionId,
      })) as { ok: boolean; confirmationId?: string; code?: string }
      if (!prepared.ok || prepared.confirmationId === undefined) {
        return { ok: false, code: 'COLLECTOR_STOP_FAILED' } as const
      }
      return ipcRenderer.invoke(HISTORY_IPC_CHANNELS.confirmDelete, {
        confirmationId: prepared.confirmationId,
      })
    },
  }),
}

contextBridge.exposeInMainWorld('danmakuApp', Object.freeze(api))
