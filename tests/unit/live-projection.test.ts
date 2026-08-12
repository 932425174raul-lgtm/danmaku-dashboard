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

  it('等待开播期间不把没有弹幕判断为互动安静', () => {
    let now = 0
    const projection = new LiveProjection(() => now)
    projection.start('123456')
    projection.markWaiting()
    now = 10 * 60_000

    expect(projection.snapshot().segment.status).toBe('starting')
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

  it('按10秒固定容量记录五项趋势并估算短时活跃发言人数', () => {
    let now = 10_000
    const projection = new LiveProjection(() => now)

    projection.start('123456')
    projection.markCollecting()
    projection.ingest({
      displayName: '观众甲',
      content: '第一条',
      localUserKey: 'local-a',
      receivedAtMs: now,
    })
    projection.ingest({
      displayName: '观众乙',
      content: '第二条',
      localUserKey: 'local-b',
      receivedAtMs: now,
    })
    projection.ingestGift({ quantity: 3, totalValueMilliCny: 12_000, receivedAtMs: now })
    projection.ingestSuperChat({ valueMilliCny: 30_000, receivedAtMs: now })
    projection.updatePopularity(88_000, now)
    projection.updatePopularity(96_000, now)

    expect(projection.snapshot().trend.at(-1)).toMatchObject({
      bucketStartMs: 10_000,
      danmakuCount: 2,
      activeSpeakerEstimate: 2,
      giftCount: 3,
      superChatCount: 1,
      popularityPeak: 96_000,
      hasGap: false,
    })

    now += 31 * 60_000
    expect(projection.snapshot().trend).toHaveLength(180)
  })

  it('用前后等长时间段判断升温、回落与数据缺口', () => {
    let now = 0
    const projection = new LiveProjection(() => now)

    projection.start('123456')
    projection.markCollecting()
    for (let bucket = 0; bucket < 12; bucket += 1) {
      now = bucket * 10_000
      const count = bucket < 6 ? 1 : 3
      for (let index = 0; index < count; index += 1) {
        projection.ingest({
          displayName: `观众${index}`,
          content: '互动',
          localUserKey: `local-${bucket}-${index}`,
          receivedAtMs: now,
        })
      }
    }

    expect(projection.snapshot().segment).toMatchObject({
      windowSeconds: 60,
      status: 'warming',
      hasGap: false,
      metrics: {
        danmaku: { current: 18, previous: 6, changePercent: 200 },
        activeSpeakers: { current: 18, previous: 6, changePercent: 200 },
      },
    })

    now = 120_000
    projection.markRecovering('WEBSOCKET_DISCONNECTED')
    expect(projection.snapshot().segment.status).toBe('gap')
    expect(projection.snapshot().segment.hasGap).toBe(true)
  })

  it('数据不足、互动回落和当前安静使用不同状态', () => {
    let coolingNow = 0
    const cooling = new LiveProjection(() => coolingNow)
    cooling.start('123456')
    expect(cooling.snapshot().segment.status).toBe('starting')
    cooling.markCollecting()
    for (let bucket = 0; bucket < 12; bucket += 1) {
      coolingNow = bucket * 10_000
      const count = bucket < 6 ? 4 : 1
      for (let index = 0; index < count; index += 1) {
        cooling.ingest({ displayName: '观众', content: '互动', receivedAtMs: coolingNow })
      }
    }
    expect(cooling.snapshot().segment.status).toBe('cooling')

    let quietNow = 0
    const quiet = new LiveProjection(() => quietNow)
    quiet.start('123456')
    quiet.markCollecting()
    for (let bucket = 0; bucket < 6; bucket += 1) {
      quietNow = bucket * 10_000
      quiet.ingest({ displayName: '观众', content: '互动', receivedAtMs: quietNow })
    }
    quietNow = 110_000
    expect(quiet.snapshot().segment.status).toBe('quiet')
  })
})
