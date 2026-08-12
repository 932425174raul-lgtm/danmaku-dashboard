export type LiveStatus =
  'idle' | 'waiting' | 'connecting' | 'collecting' | 'recovering' | 'stopping' | 'stopped' | 'error'

export interface LiveDanmakuItem {
  id: string
  receivedAtMs: number
  displayName: string
  content: string
}

export interface LiveDataGap {
  startedAtMs: number
  endedAtMs: number | null
  firstReason: string
  lastReason: string
  retryCount: number
  recovered: boolean
}

export interface LiveSnapshot {
  apiVersion: 1
  platform: 'bilibili' | 'douyin'
  status: LiveStatus
  roomDisplay: string | null
  startedAtMs: number | null
  elapsedMs: number
  totalDanmaku: number
  danmakuPerMinute: number
  activeSpeakers: number
  lastMessageAtMs: number | null
  gapCount: number
  currentGapSince: number | null
  lastGap: LiveDataGap | null
  trend: Array<{ bucketStartMs: number; danmakuCount: number; hasGap: boolean }>
  keywords: Array<{ term: string; estimatedCount: number }>
  activeUsers: Array<{ displayName: string; danmakuCount: number }>
  recentDanmaku: LiveDanmakuItem[]
  metrics: {
    giftCount: number
    giftValueMilliCny: number
    superChatCount: number
    superChatValueMilliCny: number
    popularity: number | null
  }
  unavailable: {
    gifts: boolean
    superChats: boolean
    popularity: boolean
    viewerCount: true
    history: false
  }
  errorCode: string | null
}

export type LiveCommandResult =
  | { ok: true }
  | {
      ok: false
      code:
        | 'INVALID_ROOM_INPUT'
        | 'SESSION_ALREADY_ACTIVE'
        | 'COLLECTOR_START_FAILED'
        | 'COLLECTOR_STOP_FAILED'
    }

export interface StartLiveInput {
  platform: 'bilibili' | 'douyin'
  roomInput: string
}

export interface HistorySummaryView {
  id: number
  platform: 'bilibili' | 'douyin'
  roomId: string
  roomTitle: string
  anchorDisplayName: string | null
  startedAtMs: number
  endedAtMs: number | null
  status: 'active' | 'completed' | 'interrupted'
  danmakuCount: number
  activeUserCount: number
  giftCount: number
  superChatCount: number
}

export interface HistoryDanmakuView {
  id: number
  sessionId: number
  receivedAtMs: number
  displayName: string
  text: string
  medalName: string | null
  medalLevel: number | null
}

export interface HistoryPageCursor {
  receivedAtMs: number
  id: number
}

export interface HistoryReviewBucketView {
  bucketStartMs: number
  bucketEndMs: number
  danmakuCount: number
  activeSpeakerCount: number
  giftCount: number
  superChatCount: number
  popularityPeak: number | null
  hasGap: boolean
}

export interface HistoryRepeatedDanmakuView {
  text: string
  count: number
  uniqueUserCount: number
  firstAtMs: number
  lastAtMs: number
}

export interface HistoryReviewView {
  sessionId: number
  startedAtMs: number
  endedAtMs: number
  bucketMinutes: number
  totals: {
    danmakuCount: number
    activeUserCount: number
    giftCount: number
    superChatCount: number
    gapCount: number
    gapDurationMs: number
  }
  buckets: HistoryReviewBucketView[]
  repeatedDanmaku: HistoryRepeatedDanmakuView[]
  mostRepeatedDanmaku: HistoryRepeatedDanmakuView | null
  peakDanmakuBucket: HistoryReviewBucketView | null
  peakActiveSpeakerBucket: HistoryReviewBucketView | null
  topThreeDanmakuShare: number
}

export interface HistoryApi {
  list(): Promise<HistorySummaryView[]>
  getReview(sessionId: number): Promise<HistoryReviewView | null>
  listDanmaku(sessionId: number, before?: HistoryPageCursor): Promise<HistoryDanmakuView[]>
  searchDanmaku(
    sessionId: number,
    query: string,
    before?: HistoryPageCursor,
  ): Promise<HistoryDanmakuView[]>
  deleteSession(sessionId: number): Promise<LiveCommandResult>
}

export interface DanmakuAppApi {
  apiVersion: 1
  live: {
    getSnapshot(): Promise<LiveSnapshot>
    start(input: StartLiveInput): Promise<LiveCommandResult>
    stop(): Promise<LiveCommandResult>
    subscribe(listener: (snapshot: LiveSnapshot) => void): () => void
  }
  history: HistoryApi
}
