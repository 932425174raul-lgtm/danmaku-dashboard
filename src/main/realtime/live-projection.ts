import type {
  LiveSegmentMetric,
  LiveSegmentMonitor,
  LiveSnapshot,
  LiveTrendBucket,
} from '../../contracts/ipc-v1/live'

const MAX_RECENT_DANMAKU = 500
const RATE_WINDOW_MS = 60_000
const SPEAKER_REGISTER_BITS = 10
const SPEAKER_REGISTER_COUNT = 1 << SPEAKER_REGISTER_BITS
const TREND_BUCKET_MS = 10_000
const TREND_WINDOW_BUCKETS = 180
const SEGMENT_MAX_BUCKETS = 30
const SEGMENT_MIN_COMPARISON_BUCKETS = 6
const TOP_COUNTER_CAPACITY = 64

class FixedTopCounter {
  readonly #counts = new Map<string, { label: string; count: number; error: number }>()

  clear(): void {
    this.#counts.clear()
  }

  add(key: string, label = key): void {
    const current = this.#counts.get(key)
    if (current !== undefined) {
      current.count += 1
      current.label = label
      return
    }
    if (this.#counts.size < TOP_COUNTER_CAPACITY) {
      this.#counts.set(key, { label, count: 1, error: 0 })
      return
    }
    let minimumKey = ''
    let minimumCount = Number.POSITIVE_INFINITY
    for (const [candidateKey, candidate] of this.#counts) {
      if (candidate.count < minimumCount) {
        minimumKey = candidateKey
        minimumCount = candidate.count
      }
    }
    this.#counts.delete(minimumKey)
    this.#counts.set(key, { label, count: minimumCount + 1, error: minimumCount })
  }

  top(limit: number): Array<{ label: string; count: number }> {
    return [...this.#counts.values()]
      .sort((left, right) => right.count - right.error - (left.count - left.error))
      .slice(0, limit)
      .map((item) => ({ label: item.label, count: Math.max(1, item.count - item.error) }))
  }
}

class FixedCardinalityCounter {
  readonly #registers = new Uint8Array(SPEAKER_REGISTER_COUNT)

  clear(): void {
    this.#registers.fill(0)
  }

  add(value: string): void {
    let hash = 0x811c9dc5
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193)
    }
    hash = (hash ^ (hash >>> 16)) >>> 0
    const bucket = hash & (SPEAKER_REGISTER_COUNT - 1)
    const remainder = hash >>> SPEAKER_REGISTER_BITS
    const rank = Math.min(
      32 - SPEAKER_REGISTER_BITS + 1,
      Math.max(1, Math.clz32(remainder) - SPEAKER_REGISTER_BITS + 1),
    )
    this.#registers[bucket] = Math.max(this.#registers[bucket] ?? 0, rank)
  }

  merge(other: FixedCardinalityCounter): void {
    for (let index = 0; index < this.#registers.length; index += 1) {
      this.#registers[index] = Math.max(this.#registers[index] ?? 0, other.#registers[index] ?? 0)
    }
  }

  estimate(): number {
    let zeroRegisters = 0
    let inverseSum = 0
    for (const register of this.#registers) {
      if (register === 0) zeroRegisters += 1
      inverseSum += 2 ** -register
    }
    if (zeroRegisters > 0) {
      return Math.round(SPEAKER_REGISTER_COUNT * Math.log(SPEAKER_REGISTER_COUNT / zeroRegisters))
    }
    const alpha = 0.7213 / (1 + 1.079 / SPEAKER_REGISTER_COUNT)
    return Math.round((alpha * SPEAKER_REGISTER_COUNT * SPEAKER_REGISTER_COUNT) / inverseSum)
  }
}

export interface ProjectionDanmakuInput {
  displayName: string
  content: string
  localUserKey?: string
  receivedAtMs?: number
}

export interface ProjectionGiftInput {
  quantity: number
  totalValueMilliCny: number | null
  receivedAtMs?: number
}

export interface ProjectionSuperChatInput {
  valueMilliCny: number
  receivedAtMs?: number
}

interface TrendBucketState {
  danmakuCount: number
  activeSpeakers: FixedCardinalityCounter
  giftCount: number
  superChatCount: number
  popularityPeak: number | null
  hasGap: boolean
}

export class LiveProjection {
  private platform: LiveSnapshot['platform'] = 'bilibili'
  private status: LiveSnapshot['status'] = 'idle'
  private roomDisplay: string | null = null
  private startedAtMs: number | null = null
  private endedAtMs: number | null = null
  private totalDanmaku = 0
  private giftCount = 0
  private giftValueMilliCny = 0
  private superChatCount = 0
  private superChatValueMilliCny = 0
  private popularity: number | null = null
  private lastMessageAtMs: number | null = null
  private readonly recentDanmaku: LiveSnapshot['recentDanmaku'] = []
  private readonly recentMessageTimes: number[] = []
  private readonly activeSpeakers = new FixedCardinalityCounter()
  private activeSpeakerCount: number | null = null
  private readonly speakerRanking = new FixedTopCounter()
  private readonly keywordRanking = new FixedTopCounter()
  private readonly trendBuckets = new Map<number, TrendBucketState>()
  private nextMessageId = 1
  private errorCode: string | null = null
  private gapCount = 0
  private currentGapSince: number | null = null
  private lastGap: LiveSnapshot['lastGap'] = null

  constructor(private readonly clock: () => number = Date.now) {}

  start(roomDisplay: string, platform: LiveSnapshot['platform'] = 'bilibili'): void {
    this.platform = platform
    this.status = 'connecting'
    this.roomDisplay = roomDisplay
    this.startedAtMs = this.clock()
    this.endedAtMs = null
    this.totalDanmaku = 0
    this.giftCount = 0
    this.giftValueMilliCny = 0
    this.superChatCount = 0
    this.superChatValueMilliCny = 0
    this.popularity = null
    this.lastMessageAtMs = null
    this.recentDanmaku.length = 0
    this.recentMessageTimes.length = 0
    this.activeSpeakers.clear()
    this.activeSpeakerCount = null
    this.speakerRanking.clear()
    this.keywordRanking.clear()
    this.trendBuckets.clear()
    this.nextMessageId = 1
    this.errorCode = null
    this.gapCount = 0
    this.currentGapSince = null
    this.lastGap = null
  }

  markCollecting(): void {
    if (this.currentGapSince !== null && this.lastGap !== null) {
      const endedAtMs = this.clock()
      this.markGapRange(this.currentGapSince, endedAtMs)
      this.lastGap = {
        ...this.lastGap,
        endedAtMs,
        recovered: true,
      }
      this.currentGapSince = null
    }
    this.status = 'collecting'
    this.errorCode = null
  }

  markWaiting(): void {
    this.status = 'waiting'
  }

  markRecovering(code: string): void {
    this.markGapBucket(this.clock())
    if (this.currentGapSince === null) {
      const startedAtMs = this.clock()
      this.currentGapSince = startedAtMs
      this.gapCount += 1
      this.lastGap = {
        startedAtMs,
        endedAtMs: null,
        firstReason: code,
        lastReason: code,
        retryCount: 0,
        recovered: false,
      }
    } else if (this.lastGap !== null) {
      this.lastGap = {
        ...this.lastGap,
        lastReason: code,
        retryCount: this.lastGap.retryCount + 1,
      }
    }
    this.status = 'recovering'
    this.errorCode = code
  }

  markStopping(): void {
    this.status = 'stopping'
  }

  markStopped(): void {
    this.status = 'stopped'
    this.endedAtMs = this.clock()
  }

  markError(code: string): void {
    this.status = 'error'
    this.errorCode = code
    this.endedAtMs = this.clock()
  }

  ingest(input: ProjectionDanmakuInput): void {
    const receivedAtMs = input.receivedAtMs ?? this.clock()
    this.totalDanmaku += 1
    this.lastMessageAtMs = receivedAtMs
    this.recentMessageTimes.push(receivedAtMs)
    if (input.localUserKey !== undefined) {
      this.activeSpeakers.add(input.localUserKey)
      this.speakerRanking.add(input.localUserKey, input.displayName)
    }
    for (const term of this.extractTerms(input.content)) this.keywordRanking.add(term)
    const trendBucket = this.getTrendBucket(receivedAtMs)
    trendBucket.danmakuCount += 1
    if (input.localUserKey !== undefined) trendBucket.activeSpeakers.add(input.localUserKey)

    this.recentDanmaku.push({
      id: String(this.nextMessageId),
      receivedAtMs,
      displayName: input.displayName,
      content: input.content,
    })
    this.nextMessageId += 1
    if (this.recentDanmaku.length > MAX_RECENT_DANMAKU) {
      this.recentDanmaku.splice(0, this.recentDanmaku.length - MAX_RECENT_DANMAKU)
    }
    this.pruneRateWindow(receivedAtMs)
  }

  ingestGift(input: ProjectionGiftInput): void {
    this.giftCount += input.quantity
    this.giftValueMilliCny += input.totalValueMilliCny ?? 0
    this.getTrendBucket(input.receivedAtMs ?? this.clock()).giftCount += input.quantity
  }

  ingestSuperChat(input: ProjectionSuperChatInput): void {
    this.superChatCount += 1
    this.superChatValueMilliCny += input.valueMilliCny
    this.getTrendBucket(input.receivedAtMs ?? this.clock()).superChatCount += 1
  }

  updatePopularity(value: number, receivedAtMs = this.clock()): void {
    this.popularity = value
    const bucket = this.getTrendBucket(receivedAtMs)
    bucket.popularityPeak = Math.max(bucket.popularityPeak ?? 0, value)
  }

  updateActiveSpeakerCount(value: number): void {
    this.activeSpeakerCount = value
  }

  snapshot(): LiveSnapshot {
    const now = this.clock()
    this.pruneRateWindow(now)
    const trend = this.createTrendSnapshot(this.endedAtMs ?? now)
    return {
      apiVersion: 1,
      platform: this.platform,
      status: this.status,
      roomDisplay: this.roomDisplay,
      startedAtMs: this.startedAtMs,
      elapsedMs:
        this.startedAtMs === null ? 0 : Math.max(0, (this.endedAtMs ?? now) - this.startedAtMs),
      totalDanmaku: this.totalDanmaku,
      danmakuPerMinute: this.recentMessageTimes.length,
      activeSpeakers: this.activeSpeakerCount ?? this.activeSpeakers.estimate(),
      lastMessageAtMs: this.lastMessageAtMs,
      gapCount: this.gapCount,
      currentGapSince: this.currentGapSince,
      lastGap: this.lastGap === null ? null : { ...this.lastGap },
      trend,
      segment: this.createSegmentSnapshot(trend),
      keywords: this.keywordRanking
        .top(10)
        .map((item) => ({ term: item.label, estimatedCount: item.count })),
      activeUsers: this.speakerRanking
        .top(10)
        .map((item) => ({ displayName: item.label, danmakuCount: item.count })),
      recentDanmaku: this.recentDanmaku.map((item) => ({ ...item })),
      metrics: {
        giftCount: this.giftCount,
        giftValueMilliCny: this.giftValueMilliCny,
        superChatCount: this.superChatCount,
        superChatValueMilliCny: this.superChatValueMilliCny,
        popularity: this.popularity,
      },
      unavailable: {
        gifts: this.platform === 'douyin',
        superChats: this.platform === 'douyin',
        popularity: this.platform === 'douyin',
        viewerCount: true,
        history: false,
      },
      errorCode: this.errorCode,
    }
  }

  private pruneRateWindow(now: number): void {
    const threshold = now - RATE_WINDOW_MS
    let removeCount = 0
    while (
      removeCount < this.recentMessageTimes.length &&
      (this.recentMessageTimes[removeCount] ?? Number.POSITIVE_INFINITY) < threshold
    ) {
      removeCount += 1
    }
    if (removeCount > 0) {
      this.recentMessageTimes.splice(0, removeCount)
    }
  }

  private getTrendBucket(timestamp: number): TrendBucketState {
    const bucketStartMs = Math.floor(timestamp / TREND_BUCKET_MS) * TREND_BUCKET_MS
    const bucket = this.trendBuckets.get(bucketStartMs) ?? {
      danmakuCount: 0,
      activeSpeakers: new FixedCardinalityCounter(),
      giftCount: 0,
      superChatCount: 0,
      popularityPeak: null,
      hasGap: false,
    }
    this.trendBuckets.set(bucketStartMs, bucket)
    const threshold = bucketStartMs - (TREND_WINDOW_BUCKETS - 1) * TREND_BUCKET_MS
    for (const key of this.trendBuckets.keys()) {
      if (key < threshold) this.trendBuckets.delete(key)
    }
    while (this.trendBuckets.size > TREND_WINDOW_BUCKETS) {
      const oldestKey = Math.min(...this.trendBuckets.keys())
      this.trendBuckets.delete(oldestKey)
    }
    return bucket
  }

  private markGapBucket(timestamp: number): void {
    this.getTrendBucket(timestamp).hasGap = true
  }

  private markGapRange(startedAtMs: number, endedAtMs: number): void {
    const windowStart = Math.max(startedAtMs, endedAtMs - 30 * 60_000)
    let bucketStartMs = Math.floor(windowStart / TREND_BUCKET_MS) * TREND_BUCKET_MS
    const finalBucketMs = Math.floor(endedAtMs / TREND_BUCKET_MS) * TREND_BUCKET_MS
    while (bucketStartMs <= finalBucketMs) {
      this.markGapBucket(bucketStartMs)
      bucketStartMs += TREND_BUCKET_MS
    }
  }

  private createTrendSnapshot(now: number): LiveSnapshot['trend'] {
    if (this.startedAtMs === null) return []
    const finalBucketMs = Math.floor(now / TREND_BUCKET_MS) * TREND_BUCKET_MS
    const firstBucketMs = Math.max(
      Math.floor(this.startedAtMs / TREND_BUCKET_MS) * TREND_BUCKET_MS,
      finalBucketMs - (TREND_WINDOW_BUCKETS - 1) * TREND_BUCKET_MS,
    )
    const trend: LiveSnapshot['trend'] = []
    for (
      let bucketStartMs = firstBucketMs;
      bucketStartMs <= finalBucketMs;
      bucketStartMs += TREND_BUCKET_MS
    ) {
      const bucket = this.trendBuckets.get(bucketStartMs)
      trend.push({
        bucketStartMs,
        danmakuCount: bucket?.danmakuCount ?? 0,
        activeSpeakerEstimate: bucket?.activeSpeakers.estimate() ?? 0,
        giftCount: bucket?.giftCount ?? 0,
        superChatCount: bucket?.superChatCount ?? 0,
        popularityPeak: bucket?.popularityPeak ?? null,
        hasGap:
          (bucket?.hasGap ?? false) ||
          (this.currentGapSince !== null && bucketStartMs >= this.currentGapSince),
      })
    }
    return trend
  }

  private createSegmentSnapshot(trend: LiveTrendBucket[]): LiveSegmentMonitor {
    const isWaitingForCollection = this.status === 'waiting' || this.status === 'connecting'
    if (isWaitingForCollection || trend.length < SEGMENT_MIN_COMPARISON_BUCKETS * 2) {
      const current = trend.slice(-SEGMENT_MAX_BUCKETS)
      return {
        windowSeconds: current.length * (TREND_BUCKET_MS / 1_000),
        status:
          !isWaitingForCollection && current.some((bucket) => bucket.hasGap) ? 'gap' : 'starting',
        hasGap: current.some((bucket) => bucket.hasGap),
        metrics: this.createSegmentMetrics(current, []),
      }
    }

    const comparisonBucketCount = Math.min(SEGMENT_MAX_BUCKETS, Math.floor(trend.length / 2))
    const current = trend.slice(-comparisonBucketCount)
    const previous = trend.slice(-comparisonBucketCount * 2, -comparisonBucketCount)
    const hasGap = [...previous, ...current].some((bucket) => bucket.hasGap)
    const metrics = this.createSegmentMetrics(current, previous)
    const currentDanmaku = metrics.danmaku.current ?? 0
    const previousDanmaku = metrics.danmaku.previous ?? 0
    let status: LiveSegmentMonitor['status'] = 'steady'
    if (hasGap) status = 'gap'
    else if (currentDanmaku === 0) status = 'quiet'
    else if (previousDanmaku === 0) status = 'warming'
    else if (Math.abs(currentDanmaku - previousDanmaku) <= 3) status = 'steady'
    else if (currentDanmaku / previousDanmaku >= 1.25) status = 'warming'
    else if (currentDanmaku / previousDanmaku <= 0.75) status = 'cooling'

    return {
      windowSeconds: comparisonBucketCount * (TREND_BUCKET_MS / 1_000),
      status,
      hasGap,
      metrics,
    }
  }

  private createSegmentMetrics(
    currentBuckets: LiveTrendBucket[],
    previousBuckets: LiveTrendBucket[],
  ): LiveSegmentMonitor['metrics'] {
    const current = this.aggregateSegment(currentBuckets)
    const previous = previousBuckets.length === 0 ? null : this.aggregateSegment(previousBuckets)
    return {
      danmaku: this.createSegmentMetric(current.danmaku, previous?.danmaku ?? null),
      activeSpeakers: this.createSegmentMetric(
        current.activeSpeakers,
        previous?.activeSpeakers ?? null,
      ),
      gifts: this.createSegmentMetric(current.gifts, previous?.gifts ?? null),
      superChats: this.createSegmentMetric(current.superChats, previous?.superChats ?? null),
      popularity: this.createSegmentMetric(current.popularity, previous?.popularity ?? null),
    }
  }

  private aggregateSegment(buckets: LiveTrendBucket[]): {
    danmaku: number
    activeSpeakers: number
    gifts: number
    superChats: number
    popularity: number | null
  } {
    const speakers = new FixedCardinalityCounter()
    let danmaku = 0
    let gifts = 0
    let superChats = 0
    let popularity: number | null = null
    for (const bucket of buckets) {
      danmaku += bucket.danmakuCount
      gifts += bucket.giftCount
      superChats += bucket.superChatCount
      if (bucket.popularityPeak !== null) {
        popularity = Math.max(popularity ?? 0, bucket.popularityPeak)
      }
      const state = this.trendBuckets.get(bucket.bucketStartMs)
      if (state !== undefined) speakers.merge(state.activeSpeakers)
    }
    return { danmaku, activeSpeakers: speakers.estimate(), gifts, superChats, popularity }
  }

  private createSegmentMetric(current: number | null, previous: number | null): LiveSegmentMetric {
    if (current === null || previous === null) {
      return { current, previous, changePercent: null }
    }
    if (previous === 0) {
      return { current, previous, changePercent: current === 0 ? 0 : null }
    }
    return {
      current,
      previous,
      changePercent: Math.round(((current - previous) / previous) * 100),
    }
  }

  private extractTerms(content: string): string[] {
    return (content.toLocaleLowerCase('zh-CN').match(/[\p{L}\p{N}]{2,12}/gu) ?? []).slice(0, 20)
  }
}
