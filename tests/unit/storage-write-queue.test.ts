import { describe, expect, it, vi } from 'vitest'

import type { DanmakuEvent } from '../../src/domain/events'
import { StorageWriteQueue } from '../../src/main/queue/storage-write-queue'
import type { StorageWriter } from '../../src/main/storage/storage-writer'

const event = (index: number): DanmakuEvent => ({
  type: 'danmaku',
  sessionId: 1,
  sourceEventKey: Uint8Array.from({ length: 16 }, (_, offset) => index + offset),
  receivedAtMs: 1_780_000_000_000 + index,
  sentAtMs: null,
  localUserKey: null,
  displayName: `观众${index}`,
  text: `弹幕${index}`,
  medalName: null,
  medalLevel: null,
})

describe('StorageWriteQueue', () => {
  it('可等待对应事件批次真正提交', async () => {
    vi.useFakeTimers()
    const pending = event(1)
    const appendBatch = vi.fn<StorageWriter['appendBatch']>().mockResolvedValue({
      sessionId: 1,
      activeUserCount: 0,
      insertedCounts: { danmaku: 1, gift: 0, superChat: 0, popularity: 0 },
      highWatermark: { receivedAtMs: pending.receivedAtMs, eventId: 1 },
      committedEvents: [pending],
    })
    const queue = new StorageWriteQueue(
      { appendBatch },
      { onCommitted: vi.fn(), flushAfterMs: 100, maxBatchSize: 500 },
    )

    let resolved = false
    const confirmation = queue.enqueueAndWait(1, [pending]).then(() => {
      resolved = true
    })
    await Promise.resolve()
    expect(resolved).toBe(false)

    await vi.advanceTimersByTimeAsync(100)
    await confirmation
    expect(resolved).toBe(true)
    expect(appendBatch).toHaveBeenCalledWith(1, [pending])
    await queue.shutdown()
    vi.useRealTimers()
  })

  it('实时投影只收到writer确认插入的事件', async () => {
    const committed = event(1)
    const appendBatch = vi.fn<StorageWriter['appendBatch']>().mockResolvedValue({
      sessionId: 1,
      activeUserCount: 0,
      insertedCounts: { danmaku: 1, gift: 0, superChat: 0, popularity: 0 },
      highWatermark: { receivedAtMs: committed.receivedAtMs, eventId: 1 },
      committedEvents: [committed],
    })
    const onCommitted = vi.fn()
    const queue = new StorageWriteQueue(
      { appendBatch },
      { onCommitted, flushAfterMs: 100, maxBatchSize: 500 },
    )

    queue.enqueue(1, [committed, event(1)])
    await queue.flush()

    expect(appendBatch).toHaveBeenCalledTimes(1)
    expect(onCommitted).toHaveBeenCalledWith(
      expect.objectContaining({ committedEvents: [committed] }),
    )
    await queue.shutdown()
  })
})
