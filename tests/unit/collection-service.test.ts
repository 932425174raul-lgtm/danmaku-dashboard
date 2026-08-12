import { describe, expect, it, vi } from 'vitest'

import { CollectionService } from '../../src/main/collector/collection-service'
import type { DanmakuEvent } from '../../src/domain/events'
import type { BilibiliCollectorCallbacks } from '../../src/main/collector/bilibili-collector'
import type {
  DouyinCollector,
  DouyinCollectorCallbacks,
} from '../../src/main/collector/douyin-collector'

function createDouyinStub(): DouyinCollector {
  return {
    start: vi.fn<DouyinCollector['start']>().mockResolvedValue(undefined),
    stop: vi.fn(async () => undefined),
  }
}

const flush = async (): Promise<void> => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve()
}

describe('CollectionService', () => {
  it('重复恢复只保留连续单缺口并在重新鉴权后立即关闭', async () => {
    let now = 1_000
    let callbacks: BilibiliCollectorCallbacks | null = null
    const collector = {
      start: vi.fn(async (_room: string, nextCallbacks: BilibiliCollectorCallbacks) => {
        callbacks = nextCallbacks
      }),
      stop: vi.fn(async () => undefined),
    }
    const store = {
      createSession: vi.fn(async () => ({ id: 7 })),
      appendBatch: vi.fn(async () => ({
        sessionId: 7,
        activeUserCount: 0,
        insertedCounts: { danmaku: 0, gift: 0, superChat: 0, popularity: 0 },
        highWatermark: null,
        committedEvents: [],
      })),
      openGap: vi.fn(async () => ({
        id: 1,
        sessionId: 7,
        startedAtMs: 1_000,
        endedAtMs: null,
        firstReason: 'WEBSOCKET_DISCONNECTED',
        lastReason: 'WEBSOCKET_DISCONNECTED',
        retryCount: 0,
        recovered: false,
      })),
      closeGap: vi.fn(async () => ({
        id: 1,
        sessionId: 7,
        startedAtMs: 1_000,
        endedAtMs: 2_000,
        firstReason: 'WEBSOCKET_DISCONNECTED',
        lastReason: 'UPSTREAM_UNAVAILABLE',
        retryCount: 1,
        recovered: true,
      })),
      finalizeSession: vi.fn(async () => undefined),
    }
    const service = new CollectionService(
      store,
      new Uint8Array(32),
      () => collector,
      createDouyinStub,
      () => now,
    )

    await service.start({ platform: 'bilibili', roomInput: '123' })
    const registeredCallbacks = callbacks as unknown as BilibiliCollectorCallbacks
    await registeredCallbacks.onAuthenticated({ inputRoomId: '123', roomId: '98765' })
    await registeredCallbacks.onRecovering('WEBSOCKET_DISCONNECTED')
    now = 1_500
    await registeredCallbacks.onRecovering('UPSTREAM_UNAVAILABLE')

    expect(store.openGap).toHaveBeenNthCalledWith(1, 7, 'WEBSOCKET_DISCONNECTED', 1_000)
    expect(store.openGap).toHaveBeenNthCalledWith(2, 7, 'UPSTREAM_UNAVAILABLE', 1_500)
    expect(service.getSnapshot()).toMatchObject({
      status: 'recovering',
      gapCount: 1,
      currentGapSince: 1_000,
      lastGap: { lastReason: 'UPSTREAM_UNAVAILABLE', retryCount: 1 },
    })

    now = 2_000
    await registeredCallbacks.onConnectionAuthenticated?.()
    expect(store.closeGap).toHaveBeenCalledWith(7, 2_000, true)
    expect(service.getSnapshot()).toMatchObject({
      status: 'collecting',
      gapCount: 1,
      currentGapSince: null,
      lastGap: { endedAtMs: 2_000, recovered: true },
    })
  })

  it('实时投影只消费数据库实际插入的事件', async () => {
    vi.useFakeTimers()
    let callbacks: BilibiliCollectorCallbacks | null = null
    const collector = {
      start: vi.fn(async (_room: string, nextCallbacks: BilibiliCollectorCallbacks) => {
        callbacks = nextCallbacks
      }),
      stop: vi.fn(async () => undefined),
    }
    const event: DanmakuEvent = {
      type: 'danmaku',
      sessionId: 7,
      sourceEventKey: new Uint8Array(16),
      receivedAtMs: 1_100,
      sentAtMs: null,
      localUserKey: null,
      displayName: '测试用户',
      text: '去重弹幕',
      medalName: null,
      medalLevel: null,
    }
    const appendBatch = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: 7,
        activeUserCount: 1,
        insertedCounts: { danmaku: 1, gift: 0, superChat: 0, popularity: 0 },
        highWatermark: { receivedAtMs: 1_100, eventId: 1 },
        committedEvents: [event],
      })
      .mockResolvedValueOnce({
        sessionId: 7,
        activeUserCount: 1,
        insertedCounts: { danmaku: 0, gift: 0, superChat: 0, popularity: 0 },
        highWatermark: null,
        committedEvents: [],
      })
    const store = {
      createSession: vi.fn(async () => ({ id: 7 })),
      appendBatch,
      openGap: vi.fn(async () => undefined),
      closeGap: vi.fn(async () => undefined),
      finalizeSession: vi.fn(async () => undefined),
    }
    const service = new CollectionService(
      store,
      new Uint8Array(32),
      () => collector,
      createDouyinStub,
      () => 1_000,
    )

    await service.start({ platform: 'bilibili', roomInput: '123' })
    const registeredCallbacks = callbacks as unknown as BilibiliCollectorCallbacks
    await registeredCallbacks.onAuthenticated({ inputRoomId: '123', roomId: '98765' })
    const first = registeredCallbacks.onEvents([event])
    await vi.advanceTimersByTimeAsync(100)
    await first
    const duplicate = registeredCallbacks.onEvents([event])
    await vi.advanceTimersByTimeAsync(100)
    await duplicate

    expect(service.getSnapshot()).toMatchObject({ totalDanmaku: 1, activeSpeakers: 1 })
    expect(service.getSnapshot().recentDanmaku).toHaveLength(1)
    vi.useRealTimers()
  })

  it('抖音采集错误会结束会话并允许再次开始', async () => {
    const callbackRuns: DouyinCollectorCallbacks[] = []
    const collectors: DouyinCollector[] = []
    const createDouyinCollector = (): DouyinCollector => {
      const collector: DouyinCollector = {
        start: vi.fn(async (_url, callbacks) => {
          callbackRuns.push(callbacks)
        }),
        stop: vi.fn(async () => undefined),
      }
      collectors.push(collector)
      return collector
    }
    const store = {
      createSession: vi.fn(async () => ({ id: 7 })),
      appendBatch: vi.fn(),
      openGap: vi.fn(async () => undefined),
      closeGap: vi.fn(async () => undefined),
      finalizeSession: vi.fn(async () => undefined),
    }
    const service = new CollectionService(
      store,
      new Uint8Array(32),
      () => ({ start: vi.fn(), stop: vi.fn(async () => undefined) }),
      createDouyinCollector,
      () => 1_000,
    )

    expect(await service.start({ platform: 'douyin', roomInput: '123456' })).toEqual({ ok: true })
    await callbackRuns[0]?.onConnected()
    await callbackRuns[0]?.onError('WEBSOCKET_DISCONNECTED')
    await flush()

    expect(collectors[0]?.stop).toHaveBeenCalledTimes(1)
    expect(store.finalizeSession).toHaveBeenCalledWith(7, 'process_interrupted', 1_000)
    expect(service.getSnapshot()).toMatchObject({
      status: 'error',
      errorCode: 'WEBSOCKET_DISCONNECTED',
    })
    expect(await service.start({ platform: 'douyin', roomInput: '123456' })).toEqual({ ok: true })
    expect(collectors).toHaveLength(2)
  })

  it('抖音弹幕使用本机生成的16字节用户标识参与持久化去重', async () => {
    vi.useFakeTimers()
    let callbacks: DouyinCollectorCallbacks | null = null
    const localUserKey = Uint8Array.from({ length: 16 }, (_, index) => index + 1)
    const appendBatch = vi.fn(async (sessionId: number, events: DanmakuEvent[]) => ({
      sessionId,
      activeUserCount: 1,
      insertedCounts: { danmaku: 1, gift: 0, superChat: 0, popularity: 0 },
      highWatermark: { receivedAtMs: 1_000, eventId: 1 },
      committedEvents: events,
    }))
    const store = {
      createSession: vi.fn(async () => ({ id: 7 })),
      appendBatch,
      openGap: vi.fn(async () => undefined),
      closeGap: vi.fn(async () => undefined),
      finalizeSession: vi.fn(async () => undefined),
    }
    const service = new CollectionService(
      store,
      new Uint8Array(32),
      () => ({ start: vi.fn(), stop: vi.fn(async () => undefined) }),
      () => ({
        start: vi.fn(async (_url, nextCallbacks) => {
          callbacks = nextCallbacks
        }),
        stop: vi.fn(async () => undefined),
      }),
      () => 1_000,
    )

    await service.start({ platform: 'douyin', roomInput: '123456' })
    const registeredCallbacks = callbacks as unknown as DouyinCollectorCallbacks
    await registeredCallbacks.onConnected()
    const persisted = registeredCallbacks.onChats([
      {
        displayName: '抖音观众',
        content: '带去重标识的弹幕',
        localUserKey: Buffer.from(localUserKey).toString('base64url'),
      },
    ])
    await vi.advanceTimersByTimeAsync(100)
    await persisted

    expect(appendBatch.mock.calls[0]?.[1]?.[0]?.localUserKey).toEqual(Buffer.from(localUserKey))
    expect(service.getSnapshot()).toMatchObject({ totalDanmaku: 1, activeSpeakers: 1 })
    vi.useRealTimers()
  })
})
