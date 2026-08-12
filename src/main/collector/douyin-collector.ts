import type { DouyinChatPayload } from '../protocol/douyin-web-v1/push-frame'

export interface DouyinCollectorCallbacks {
  onConnected(): Promise<void>
  onChats(chats: DouyinChatPayload[]): Promise<void>
  onError(code: string): Promise<void>
}

export interface DouyinCollector {
  start(url: string, callbacks: DouyinCollectorCallbacks): Promise<void>
  stop(): Promise<void>
}
