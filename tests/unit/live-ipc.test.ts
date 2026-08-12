import { describe, expect, it } from 'vitest'

import type { LiveSnapshot } from '../../src/contracts/ipc-v1/live'
import { limitLiveSnapshotForIpc } from '../../src/main/ipc/live-ipc'

describe('live IPC payload', () => {
  it('只发送最新200条且序列化后不超过256KiB', () => {
    const snapshot: LiveSnapshot = {
      apiVersion: 1,
      platform: 'bilibili',
      status: 'collecting',
      roomDisplay: '123456',
      startedAtMs: 1,
      elapsedMs: 1,
      totalDanmaku: 500,
      danmakuPerMinute: 500,
      activeSpeakers: 500,
      lastMessageAtMs: 1,
      gapCount: 0,
      currentGapSince: null,
      lastGap: null,
      trend: Array.from({ length: 180 }, (_, index) => ({
        bucketStartMs: index * 10_000,
        danmakuCount: index,
        activeSpeakerEstimate: index,
        giftCount: index % 5,
        superChatCount: index % 3,
        popularityPeak: 100_000 + index,
        hasGap: index % 37 === 0,
      })),
      segment: {
        windowSeconds: 0,
        status: 'starting',
        hasGap: false,
        metrics: {
          danmaku: { current: 0, previous: null, changePercent: null },
          activeSpeakers: { current: 0, previous: null, changePercent: null },
          gifts: { current: 0, previous: null, changePercent: null },
          superChats: { current: 0, previous: null, changePercent: null },
          popularity: { current: null, previous: null, changePercent: null },
        },
      },
      keywords: [],
      activeUsers: [],
      recentDanmaku: Array.from({ length: 500 }, (_, index) => ({
        id: String(index),
        receivedAtMs: index,
        displayName: `观众${index}`,
        content: '弹'.repeat(2_000),
      })),
      metrics: {
        giftCount: 0,
        giftValueMilliCny: 0,
        superChatCount: 0,
        superChatValueMilliCny: 0,
        popularity: null,
      },
      unavailable: {
        gifts: false,
        superChats: false,
        popularity: false,
        viewerCount: true,
        history: false,
      },
      errorCode: null,
    }

    const limited = limitLiveSnapshotForIpc(snapshot)
    expect(limited.recentDanmaku.length).toBeLessThanOrEqual(200)
    expect(limited.recentDanmaku.at(-1)?.id).toBe('499')
    expect(Buffer.byteLength(JSON.stringify(limited), 'utf8')).toBeLessThanOrEqual(256 * 1_024)
  })
})
