import type { DanmakuAppApi } from '../contracts/ipc-v1/live'

declare global {
  interface Window {
    danmakuApp: Readonly<DanmakuAppApi>
  }
}

export {}
