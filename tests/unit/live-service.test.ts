import { describe, expect, it } from 'vitest'

import type {
  DouyinCollector,
  DouyinCollectorCallbacks,
} from '../../src/main/collector/douyin-collector'
import { LiveService } from '../../src/main/collector/live-service'

class FakeCollector implements DouyinCollector {
  callbacks: DouyinCollectorCallbacks | null = null
  startedUrl: string | null = null
  stopped = false

  async start(url: string, callbacks: DouyinCollectorCallbacks): Promise<void> {
    this.startedUrl = url
    this.callbacks = callbacks
  }

  async stop(): Promise<void> {
    this.stopped = true
  }
}

describe('LiveService', () => {
  it('从公开房间输入开始会话并只投影规范化弹幕', async () => {
    const collector = new FakeCollector()
    const service = new LiveService(
      () => collector,
      () => 1_000,
    )

    await expect(
      service.start({ platform: 'douyin', roomInput: 'https://live.douyin.com/123456' }),
    ).resolves.toEqual({ ok: true })
    expect(collector.startedUrl).toBe('https://live.douyin.com/123456')
    expect(service.getSnapshot().status).toBe('connecting')

    collector.callbacks?.onConnected()
    collector.callbacks?.onChats([
      { displayName: '观众甲', content: '实时弹幕', localUserKey: 'local-a' },
    ])

    expect(service.getSnapshot()).toMatchObject({
      status: 'collecting',
      roomDisplay: '123456',
      totalDanmaku: 1,
      activeSpeakers: 1,
    })
    expect(service.getSnapshot().recentDanmaku[0]).toMatchObject({
      displayName: '观众甲',
      content: '实时弹幕',
    })

    await expect(service.stop()).resolves.toEqual({ ok: true })
    expect(collector.stopped).toBe(true)
    expect(service.getSnapshot().status).toBe('stopped')
  })

  it('拒绝任意外部URL且不启动采集器', async () => {
    const collector = new FakeCollector()
    const service = new LiveService(() => collector)

    await expect(
      service.start({ platform: 'douyin', roomInput: 'https://example.com/123456' }),
    ).resolves.toEqual({ ok: false, code: 'INVALID_ROOM_INPUT' })
    expect(collector.startedUrl).toBeNull()
  })

  it('采集器报错后立即释放隐藏窗口并允许重试', async () => {
    const firstCollector = new FakeCollector()
    const secondCollector = new FakeCollector()
    const collectors = [firstCollector, secondCollector]
    const service = new LiveService(() => collectors.shift() ?? secondCollector)

    await service.start({ platform: 'douyin', roomInput: '123456' })
    firstCollector.callbacks?.onError('NO_WEBSOCKET_CONNECTION')

    await expect.poll(() => firstCollector.stopped).toBe(true)
    expect(service.getSnapshot()).toMatchObject({
      status: 'error',
      errorCode: 'NO_WEBSOCKET_CONNECTION',
    })
    await expect(service.start({ platform: 'douyin', roomInput: '654321' })).resolves.toEqual({
      ok: true,
    })
    expect(secondCollector.startedUrl).toBe('https://live.douyin.com/654321')
  })
})
