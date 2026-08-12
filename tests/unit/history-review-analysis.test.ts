import { describe, expect, it } from 'vitest'

import type { HistoryReviewBucketView, HistoryReviewView } from '../../src/contracts/ipc-v1/live'
import { buildHistoryReviewAnalysis } from '../../src/domain/history-review-analysis'

function createBucket(
  index: number,
  danmakuCount: number,
  activeSpeakerCount: number,
  hasGap = false,
): HistoryReviewBucketView {
  const bucketStartMs = 1_780_000_000_000 + index * 300_000
  return {
    bucketStartMs,
    bucketEndMs: bucketStartMs + 300_000,
    danmakuCount,
    activeSpeakerCount,
    giftCount: index,
    superChatCount: index % 2,
    popularityPeak: 10_000 + index * 1_000,
    hasGap,
  }
}

function createReview(buckets: HistoryReviewBucketView[]): HistoryReviewView {
  const danmakuCount = buckets.reduce((sum, bucket) => sum + bucket.danmakuCount, 0)
  const peakDanmakuBucket = [...buckets].sort(
    (left, right) => right.danmakuCount - left.danmakuCount,
  )[0]
  const peakActiveSpeakerBucket = [...buckets].sort(
    (left, right) => right.activeSpeakerCount - left.activeSpeakerCount,
  )[0]
  return {
    sessionId: 1,
    startedAtMs: buckets[0]?.bucketStartMs ?? 1_780_000_000_000,
    endedAtMs: buckets.at(-1)?.bucketEndMs ?? 1_780_000_300_000,
    bucketMinutes: 5,
    totals: {
      danmakuCount,
      activeUserCount: 24,
      giftCount: 15,
      superChatCount: 3,
      gapCount: buckets.filter((bucket) => bucket.hasGap).length,
      gapDurationMs: 10_000,
    },
    buckets,
    repeatedDanmaku: [
      {
        text: '这个环节再讲一遍',
        count: 8,
        uniqueUserCount: 6,
        firstAtMs: 1_780_000_300_000,
        lastAtMs: 1_780_000_600_000,
      },
    ],
    mostRepeatedDanmaku: null,
    peakDanmakuBucket: peakDanmakuBucket ?? null,
    peakActiveSpeakerBucket: peakActiveSpeakerBucket ?? null,
    topThreeDanmakuShare: 0.7,
  }
}

describe('buildHistoryReviewAnalysis', () => {
  it('排出前5个高峰时段并计算全场弹幕占比', () => {
    const review = createReview([
      createBucket(0, 10, 4),
      createBucket(1, 30, 9),
      createBucket(2, 30, 12),
      createBucket(3, 20, 8, true),
      createBucket(4, 5, 3),
      createBucket(5, 2, 2),
    ])

    const analysis = buildHistoryReviewAnalysis(review)

    expect(analysis.topPeriods).toHaveLength(5)
    expect(analysis.topPeriods[0]).toMatchObject({
      bucket: { bucketStartMs: review.buckets[2]?.bucketStartMs },
      share: 30 / 97,
      rank: 1,
    })
    expect(analysis.topPeriods[2]).toMatchObject({ bucket: { hasGap: true }, rank: 3 })
  })

  it('排除缺口时间格后判断活跃发言趋势', () => {
    const review = createReview([
      createBucket(0, 6, 4),
      createBucket(1, 8, 6),
      createBucket(2, 80, 100, true),
      createBucket(3, 12, 10),
      createBucket(4, 16, 12),
    ])

    expect(buildHistoryReviewAnalysis(review).activeSpeakerTrend).toEqual({
      direction: 'rising',
      reliableBucketCount: 4,
      firstAverage: 5,
      secondAverage: 11,
      changePercent: 120,
    })
  })

  it('可靠时间格不足时不强行判断趋势', () => {
    const review = createReview([
      createBucket(0, 6, 4),
      createBucket(1, 8, 5, true),
      createBucket(2, 10, 12),
    ])

    expect(buildHistoryReviewAnalysis(review).activeSpeakerTrend).toEqual({
      direction: 'insufficient',
      reliableBucketCount: 2,
      firstAverage: null,
      secondAverage: null,
      changePercent: null,
    })
  })

  it('变化幅度或绝对差不足时判断为平稳', () => {
    const review = createReview([
      createBucket(0, 6, 5),
      createBucket(1, 8, 5),
      createBucket(2, 9, 6),
      createBucket(3, 10, 6),
    ])

    expect(buildHistoryReviewAnalysis(review).activeSpeakerTrend).toMatchObject({
      direction: 'steady',
      firstAverage: 5,
      secondAverage: 6,
      changePercent: 20,
    })
  })
})
