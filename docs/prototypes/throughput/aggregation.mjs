// PROTOTYPE：验证实时投影在高吞吐下保持固定内存上限。

export class FixedRing {
  #items
  #capacity
  #cursor = 0
  #size = 0

  constructor(capacity) {
    this.#capacity = capacity
    this.#items = new Array(capacity)
  }

  push(value) {
    this.#items[this.#cursor] = value
    this.#cursor = (this.#cursor + 1) % this.#capacity
    this.#size = Math.min(this.#size + 1, this.#capacity)
  }

  values() {
    const start = (this.#cursor - this.#size + this.#capacity) % this.#capacity
    return Array.from(
      { length: this.#size },
      (_, index) => this.#items[(start + index) % this.#capacity],
    )
  }

  get size() {
    return this.#size
  }
}

export class SpaceSaving {
  #capacity
  #entries = new Map()

  constructor(capacity) {
    this.#capacity = capacity
  }

  offer(term, increment = 1) {
    const current = this.#entries.get(term)
    if (current) {
      current.count += increment
      return
    }

    if (this.#entries.size < this.#capacity) {
      this.#entries.set(term, { count: increment, error: 0 })
      return
    }

    let minimumTerm
    let minimumEntry
    for (const [candidateTerm, candidateEntry] of this.#entries) {
      if (!minimumEntry || candidateEntry.count < minimumEntry.count) {
        minimumTerm = candidateTerm
        minimumEntry = candidateEntry
      }
    }

    this.#entries.delete(minimumTerm)
    this.#entries.set(term, {
      count: minimumEntry.count + increment,
      error: minimumEntry.count,
    })
  }

  top(limit) {
    return [...this.#entries.entries()]
      .map(([term, value]) => ({ term, ...value }))
      .sort((left, right) => right.count - left.count || left.term.localeCompare(right.term))
      .slice(0, limit)
  }

  get size() {
    return this.#entries.size
  }
}

export class RealtimeProjection {
  #recentDanmaku = new FixedRing(500)
  #trend = new FixedRing(180)
  #pendingRows = []
  #displaySkippedCount = 0
  #metrics = emptyMetrics()
  #keywords = []
  #activeUsers = []
  #latestBucketStartMs = null

  consume(delta) {
    for (const row of delta.newDanmaku) {
      this.#recentDanmaku.push(row)
      this.#pendingRows.push(row)
      if (this.#pendingRows.length > 200) {
        this.#pendingRows.shift()
        this.#displaySkippedCount += 1
      }
    }

    this.#metrics = delta.metrics

    for (const bucket of delta.bucketDeltas) {
      if (bucket.bucketStartMs !== this.#latestBucketStartMs) {
        this.#trend.push(bucket)
        this.#latestBucketStartMs = bucket.bucketStartMs
      } else {
        const values = this.#trend.values()
        values[values.length - 1] = bucket
        this.#trend = new FixedRing(180)
        for (const value of values) this.#trend.push(value)
      }
    }

    if (delta.keywords) this.#keywords = delta.keywords.slice(0, 10)
    if (delta.activeUsers) this.#activeUsers = delta.activeUsers.slice(0, 10)
  }

  takeIpcPayload({ runId, revision, highWatermark, includeAnalysis }) {
    const payload = {
      apiVersion: 1,
      runId,
      realtimeRevision: revision,
      highWatermark,
      newDanmaku: this.#pendingRows,
      displaySkippedCount: this.#displaySkippedCount,
      metrics: this.#metrics,
      ...(includeAnalysis
        ? {
            trend: this.#trend.values(),
            keywords: this.#keywords,
            activeUsers: this.#activeUsers,
          }
        : {}),
    }

    this.#pendingRows = []
    this.#displaySkippedCount = 0
    return payload
  }

  bounds() {
    return {
      recentDanmaku: this.#recentDanmaku.size,
      trendBuckets: this.#trend.size,
      pendingRows: this.#pendingRows.length,
      keywords: this.#keywords.length,
      activeUsers: this.#activeUsers.length,
    }
  }
}

function emptyMetrics() {
  return {
    danmakuCount: 0,
    activeUserCount: 0,
    giftCount: 0,
    superChatCount: 0,
    lastPopularity: null,
    peakPopularity: null,
  }
}

