import type { HistoryReviewBucketView, HistoryReviewView } from '../contracts/ipc-v1/live'

export interface RankedReviewPeriod {
  rank: number
  bucket: HistoryReviewBucketView
  share: number
}

export interface ActiveSpeakerTrend {
  direction: 'rising' | 'steady' | 'falling' | 'insufficient'
  reliableBucketCount: number
  firstAverage: number | null
  secondAverage: number | null
  changePercent: number | null
}

export interface HistoryReviewAnalysis {
  topPeriods: RankedReviewPeriod[]
  activeSpeakerTrend: ActiveSpeakerTrend
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function oneDecimal(value: number): number {
  return Math.round(value * 10) / 10
}

function analyzeActiveSpeakerTrend(buckets: HistoryReviewBucketView[]): ActiveSpeakerTrend {
  const reliableBuckets = buckets.filter((bucket) => !bucket.hasGap)
  if (reliableBuckets.length < 4) {
    return {
      direction: 'insufficient',
      reliableBucketCount: reliableBuckets.length,
      firstAverage: null,
      secondAverage: null,
      changePercent: null,
    }
  }

  const comparisonSize = Math.floor(reliableBuckets.length / 2)
  const rawFirstAverage = average(
    reliableBuckets.slice(0, comparisonSize).map((bucket) => bucket.activeSpeakerCount),
  )
  const rawSecondAverage = average(
    reliableBuckets.slice(-comparisonSize).map((bucket) => bucket.activeSpeakerCount),
  )
  const difference = rawSecondAverage - rawFirstAverage
  const changePercent =
    rawFirstAverage === 0 ? null : Math.round((difference / rawFirstAverage) * 100)
  let direction: ActiveSpeakerTrend['direction'] = 'steady'
  if (difference >= 2 && (changePercent === null ? rawSecondAverage > 0 : changePercent >= 20)) {
    direction = 'rising'
  } else if (difference <= -2 && changePercent !== null && changePercent <= -20) {
    direction = 'falling'
  }

  return {
    direction,
    reliableBucketCount: reliableBuckets.length,
    firstAverage: oneDecimal(rawFirstAverage),
    secondAverage: oneDecimal(rawSecondAverage),
    changePercent,
  }
}

export function buildHistoryReviewAnalysis(review: HistoryReviewView): HistoryReviewAnalysis {
  const topPeriods = review.buckets
    .filter((bucket) => bucket.danmakuCount > 0)
    .sort(
      (left, right) =>
        right.danmakuCount - left.danmakuCount ||
        right.activeSpeakerCount - left.activeSpeakerCount ||
        left.bucketStartMs - right.bucketStartMs,
    )
    .slice(0, 5)
    .map((bucket, index) => ({
      rank: index + 1,
      bucket,
      share:
        review.totals.danmakuCount === 0 ? 0 : bucket.danmakuCount / review.totals.danmakuCount,
    }))

  return {
    topPeriods,
    activeSpeakerTrend: analyzeActiveSpeakerTrend(review.buckets),
  }
}
