import { describe, expect, it } from 'vitest'

import { LiveProjection } from '../../src/main/realtime/live-projection'

describe('LiveProjection', () => {
  it('只用本地用户标识计算活跃人数并按最近一分钟计算速率', () => {
    let now = 1_000
    const projection = new LiveProjection(() => now)

    projection.start('抖音公开直播间')
    projection.markCollecting()
    projection.ingest({ displayName: '观众甲', content: '第一条', localUserKey: 'local-a' })
    now += 10_000
    projection.ingest({ displayName: '观众甲', content: '第二条', localUserKey: 'local-a' })
    projection.ingest({ displayName: '未署名观众', content: '第三条' })

    expect(projection.snapshot()).toMatchObject({
      status: 'collecting',
      totalDanmaku: 3,
      danmakuPerMinute: 3,
      activeSpeakers: 1,
      lastMessageAtMs: 11_000,
    })
    expect(projection.snapshot().recentDanmaku).toHaveLength(3)

    now += 61_000
    expect(projection.snapshot().danmakuPerMinute).toBe(0)
    expect(projection.snapshot().trend).toHaveLength(8)
    expect(projection.snapshot().trend.some((bucket) => bucket.danmakuCount === 0)).toBe(true)
  })

  it('停止后固定会话时长而不继续计时', () => {
    let now = 5_000
    const projection = new LiveProjection(() => now)

    projection.start('123456')
    now = 15_000
    projection.markStopped()
    now = 45_000

    expect(projection.snapshot().elapsedMs).toBe(10_000)
  })

  it('使用固定内存的基数估算去重活跃用户', () => {
    const projection = new LiveProjection(() => 1_000)
    projection.start('123456')
    for (let index = 0; index < 10_000; index += 1) {
      projection.ingest({
        displayName: '观众',
        content: '弹幕',
        localUserKey: `local-${index}`,
      })
    }
    projection.ingest({ displayName: '观众', content: '重复', localUserKey: 'local-1' })

    expect(projection.snapshot().activeSpeakers).toBeGreaterThan(9_000)
    expect(projection.snapshot().activeSpeakers).toBeLessThan(11_000)
  })

  it('连续恢复期间只记录一个缺口并保留首尾原因', () => {
    let now = 10_000
    const projection = new LiveProjection(() => now)

    projection.start('123456')
    projection.markCollecting()
    projection.markRecovering('WEBSOCKET_DISCONNECTED')
    now = 11_000
    projection.markRecovering('UPSTREAM_UNAVAILABLE')

    expect(projection.snapshot()).toMatchObject({
      status: 'recovering',
      gapCount: 1,
      currentGapSince: 10_000,
      lastGap: {
        startedAtMs: 10_000,
        endedAtMs: null,
        firstReason: 'WEBSOCKET_DISCONNECTED',
        lastReason: 'UPSTREAM_UNAVAILABLE',
        retryCount: 1,
        recovered: false,
      },
    })

    now = 12_000
    projection.markCollecting()
    expect(projection.snapshot()).toMatchObject({
      status: 'collecting',
      gapCount: 1,
      currentGapSince: null,
      lastGap: {
        endedAtMs: 12_000,
        recovered: true,
      },
    })
    expect(projection.snapshot().trend.every((bucket) => bucket.hasGap)).toBe(true)
  })
})
