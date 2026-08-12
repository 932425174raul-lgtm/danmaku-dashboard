import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

import { parseDomainEvent, type DomainEvent } from '../../domain/events'

export type LivePlatform = 'bilibili' | 'douyin'
export type SessionStatus = 'active' | 'completed' | 'interrupted'
export type SessionEndReason = 'user_stop' | 'live_ended' | 'app_quit' | 'process_interrupted'

export interface CreateSessionInput {
  platform: LivePlatform
  roomId: string
  inputRoomId?: string | null
  roomTitle: string
  anchorDisplayName?: string | null
  adapterVersion: string
  startedAtMs: number
}

export interface StoredSession extends CreateSessionInput {
  id: number
  inputRoomId: string | null
  anchorDisplayName: string | null
  status: SessionStatus
  endReason: SessionEndReason | null
  endedAtMs: number | null
}

export interface StoredGap {
  id: number
  sessionId: number
  startedAtMs: number
  endedAtMs: number | null
  firstReason: string
  lastReason: string
  retryCount: number
  recovered: boolean
}

export interface SessionSummary extends StoredSession {
  danmakuCount: number
  activeUserCount: number
  giftCount: number
  giftEventCount: number
  giftKnownValueMilliCny: number
  giftUnknownValueCount: number
  superChatCount: number
  superChatValueMilliCny: number
  lastPopularity: number | null
  peakPopularity: number | null
  gapCount: number
  gapDurationMs: number
}

export interface EventInsertCounts {
  danmaku: number
  gift: number
  superChat: number
  popularity: number
}

export interface CommittedEvents {
  sessionId: number
  activeUserCount: number
  insertedCounts: EventInsertCounts
  highWatermark: { receivedAtMs: number; eventId: number } | null
  committedEvents: DomainEvent[]
}

export interface EventPageOptions {
  limit: number
  before?: { receivedAtMs: number; id: number }
}

export interface StoredDanmaku {
  id: number
  sessionId: number
  receivedAtMs: number
  sentAtMs: number | null
  displayName: string
  text: string
  medalName: string | null
  medalLevel: number | null
}

export interface PrepareDeletionResult {
  sessionId: number
  accepted: boolean
}

export interface ConfirmDeletionResult {
  sessionId: number
  done: boolean
  deletedRows: number
}

type SqlRow = Record<string, string | number | bigint | Uint8Array | null>

const MIGRATION_VERSION = 3

const DATABASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform TEXT NOT NULL CHECK (platform IN ('bilibili', 'douyin')),
  room_id TEXT NOT NULL,
  input_room_id TEXT,
  room_title TEXT NOT NULL,
  anchor_display_name TEXT,
  adapter_version TEXT NOT NULL,
  event_schema_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'interrupted')),
  end_reason TEXT CHECK (
    end_reason IS NULL OR end_reason IN (
      'user_stop', 'live_ended', 'app_quit', 'process_interrupted'
    )
  ),
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  last_checkpoint_at_ms INTEGER NOT NULL,
  interruption_detected_at_ms INTEGER,
  deleted_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK (
    (status = 'active' AND ended_at_ms IS NULL AND end_reason IS NULL)
    OR
    (status <> 'active' AND ended_at_ms IS NOT NULL AND end_reason IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS one_active_session
ON sessions(status)
WHERE status = 'active' AND deleted_at_ms IS NULL;

CREATE INDEX IF NOT EXISTS sessions_history
ON sessions(deleted_at_ms, started_at_ms DESC, id DESC);

CREATE TABLE IF NOT EXISTS session_metrics (
  session_id INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  danmaku_count INTEGER NOT NULL DEFAULT 0,
  active_user_count INTEGER NOT NULL DEFAULT 0,
  gift_count INTEGER NOT NULL DEFAULT 0,
  gift_event_count INTEGER NOT NULL DEFAULT 0,
  gift_known_value_milli_cny INTEGER NOT NULL DEFAULT 0,
  gift_unknown_value_count INTEGER NOT NULL DEFAULT 0,
  super_chat_count INTEGER NOT NULL DEFAULT 0,
  super_chat_value_milli_cny INTEGER NOT NULL DEFAULT 0,
  last_popularity INTEGER,
  peak_popularity INTEGER,
  gap_count INTEGER NOT NULL DEFAULT 0,
  gap_duration_ms INTEGER NOT NULL DEFAULT 0,
  first_danmaku_event_id INTEGER,
  last_danmaku_event_id INTEGER,
  last_message_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_transitions (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  at_ms INTEGER NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  reason TEXT NOT NULL,
  error_category TEXT
);

CREATE TABLE IF NOT EXISTS data_gaps (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  first_reason TEXT NOT NULL,
  last_reason TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  recovered INTEGER NOT NULL DEFAULT 0 CHECK (recovered IN (0, 1)),
  CHECK (ended_at_ms IS NULL OR ended_at_ms >= started_at_ms)
);

CREATE UNIQUE INDEX IF NOT EXISTS one_open_gap_per_session
ON data_gaps(session_id)
WHERE ended_at_ms IS NULL;

CREATE TABLE IF NOT EXISTS danmaku_events (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source_event_key BLOB,
  received_at_ms INTEGER NOT NULL,
  sent_at_ms INTEGER,
  local_user_key BLOB,
  display_name TEXT NOT NULL,
  text TEXT NOT NULL,
  medal_name TEXT,
  medal_level INTEGER,
  CHECK (length(source_event_key) = 16 OR source_event_key IS NULL),
  CHECK (length(local_user_key) = 16 OR local_user_key IS NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS danmaku_dedup
ON danmaku_events(session_id, source_event_key)
WHERE source_event_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS danmaku_timeline
ON danmaku_events(session_id, received_at_ms, id);

CREATE TABLE IF NOT EXISTS gift_events (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source_event_key BLOB,
  received_at_ms INTEGER NOT NULL,
  sent_at_ms INTEGER,
  local_user_key BLOB,
  display_name TEXT NOT NULL,
  gift_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_value_milli_cny INTEGER,
  total_value_milli_cny INTEGER,
  CHECK (length(source_event_key) = 16 OR source_event_key IS NULL),
  CHECK (length(local_user_key) = 16 OR local_user_key IS NULL),
  CHECK (unit_value_milli_cny IS NULL OR unit_value_milli_cny >= 0),
  CHECK (total_value_milli_cny IS NULL OR total_value_milli_cny >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS gift_dedup
ON gift_events(session_id, source_event_key)
WHERE source_event_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS super_chat_events (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source_event_key BLOB,
  received_at_ms INTEGER NOT NULL,
  sent_at_ms INTEGER,
  local_user_key BLOB,
  display_name TEXT NOT NULL,
  text TEXT NOT NULL,
  value_milli_cny INTEGER NOT NULL CHECK (value_milli_cny >= 0),
  expires_at_ms INTEGER,
  CHECK (length(source_event_key) = 16 OR source_event_key IS NULL),
  CHECK (length(local_user_key) = 16 OR local_user_key IS NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS super_chat_dedup
ON super_chat_events(session_id, source_event_key)
WHERE source_event_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS popularity_samples (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  received_at_ms INTEGER NOT NULL,
  value INTEGER NOT NULL CHECK (value >= 0)
);

CREATE TABLE IF NOT EXISTS metric_buckets (
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  bucket_start_ms INTEGER NOT NULL,
  bucket_seconds INTEGER NOT NULL DEFAULT 10 CHECK (bucket_seconds = 10),
  danmaku_count INTEGER NOT NULL DEFAULT 0,
  gift_count INTEGER NOT NULL DEFAULT 0,
  gift_known_value_milli_cny INTEGER NOT NULL DEFAULT 0,
  super_chat_count INTEGER NOT NULL DEFAULT 0,
  super_chat_value_milli_cny INTEGER NOT NULL DEFAULT 0,
  popularity_last INTEGER,
  popularity_peak INTEGER,
  PRIMARY KEY (session_id, bucket_start_ms)
);

CREATE TABLE IF NOT EXISTS session_users (
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  local_user_key BLOB NOT NULL,
  last_display_name TEXT NOT NULL,
  danmaku_count INTEGER NOT NULL DEFAULT 0,
  first_danmaku_at_ms INTEGER NOT NULL,
  last_danmaku_at_ms INTEGER NOT NULL,
  PRIMARY KEY (session_id, local_user_key),
  CHECK (length(local_user_key) = 16)
);

CREATE TABLE IF NOT EXISTS session_keywords (
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  term TEXT NOT NULL,
  estimated_count INTEGER NOT NULL CHECK (estimated_count > 0),
  error_upper_bound INTEGER NOT NULL DEFAULT 0,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (session_id, term)
) WITHOUT ROWID;

CREATE VIRTUAL TABLE IF NOT EXISTS danmaku_fts USING fts5(
  session_id UNINDEXED,
  text,
  display_name,
  content = 'danmaku_events',
  content_rowid = 'id',
  tokenize = 'trigram'
);

CREATE TRIGGER IF NOT EXISTS danmaku_fts_insert AFTER INSERT ON danmaku_events BEGIN
  INSERT INTO danmaku_fts(rowid, session_id, text, display_name)
  VALUES (new.id, new.session_id, new.text, new.display_name);
END;

CREATE TRIGGER IF NOT EXISTS danmaku_fts_delete AFTER DELETE ON danmaku_events BEGIN
  INSERT INTO danmaku_fts(danmaku_fts, rowid, session_id, text, display_name)
  VALUES ('delete', old.id, old.session_id, old.text, old.display_name);
END;
`

const toNumber = (value: string | number | bigint | Uint8Array | null | undefined): number => {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  throw new Error('数据库整数字段缺失')
}

const nullableNumber = (
  value: string | number | bigint | Uint8Array | null | undefined,
): number | null => (value === null || value === undefined ? null : toNumber(value))

const toText = (value: string | number | bigint | Uint8Array | null | undefined): string => {
  if (typeof value === 'string') return value
  throw new Error('数据库文本字段缺失')
}

const nullableText = (
  value: string | number | bigint | Uint8Array | null | undefined,
): string | null => (value === null || value === undefined ? null : toText(value))

const requireSafeNonnegativeInteger = (value: number, field: string): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field}必须是非负JavaScript安全整数`)
  }
}

const requireNonemptyText = (value: string, field: string): void => {
  if (value.trim().length === 0) throw new RangeError(`${field}不能为空`)
}

export class LocalStore {
  readonly #databasePath: string
  readonly #readOnly: boolean
  #database: DatabaseSync | null = null

  constructor(databasePath: string, options: { readOnly?: boolean } = {}) {
    this.#databasePath = databasePath
    this.#readOnly = options.readOnly ?? false
  }

  initialize(): void {
    if (this.#database !== null) return

    const database = new DatabaseSync(this.#databasePath, {
      open: true,
      readOnly: this.#readOnly,
      allowExtension: false,
    })

    try {
      database.exec('PRAGMA foreign_keys = ON')
      database.exec('PRAGMA busy_timeout = 5000')
      if (this.#readOnly) {
        database.exec('PRAGMA query_only = ON')
        const version = database.prepare('PRAGMA user_version').get() as SqlRow
        if (toNumber(version.user_version) !== MIGRATION_VERSION) {
          throw new Error('读连接数据库版本不匹配')
        }
        this.#database = database
        return
      }
      database.exec('PRAGMA journal_mode = WAL')
      database.exec('PRAGMA synchronous = NORMAL')
      database.exec('PRAGMA temp_store = MEMORY')
      database.exec('PRAGMA auto_vacuum = INCREMENTAL')
      this.#migrate(database)
      this.#recoverInterruptedSessions(database, Date.now())
      this.#database = database
    } catch (error) {
      database.close()
      throw error
    }
  }

  close(): void {
    if (this.#database === null) return
    this.#database.close()
    this.#database = null
  }

  createSession(input: CreateSessionInput): StoredSession {
    const database = this.#getDatabase()
    requireNonemptyText(input.roomId, 'roomId')
    requireNonemptyText(input.roomTitle, 'roomTitle')
    requireNonemptyText(input.adapterVersion, 'adapterVersion')
    requireSafeNonnegativeInteger(input.startedAtMs, 'startedAtMs')
    if (input.platform !== 'bilibili' && input.platform !== 'douyin') {
      throw new RangeError('platform不受支持')
    }

    database.exec('BEGIN IMMEDIATE')
    try {
      const result = database
        .prepare(
          `INSERT INTO sessions (
            platform, room_id, input_room_id, room_title, anchor_display_name,
            adapter_version, event_schema_version, status, started_at_ms,
            last_checkpoint_at_ms, created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, 1, 'active', ?, ?, ?, ?)`,
        )
        .run(
          input.platform,
          input.roomId,
          input.inputRoomId ?? null,
          input.roomTitle,
          input.anchorDisplayName ?? null,
          input.adapterVersion,
          input.startedAtMs,
          input.startedAtMs,
          input.startedAtMs,
          input.startedAtMs,
        )
      const sessionId = Number(result.lastInsertRowid)
      database
        .prepare('INSERT INTO session_metrics (session_id, updated_at_ms) VALUES (?, ?)')
        .run(sessionId, input.startedAtMs)
      database.exec('COMMIT')

      return {
        ...input,
        id: sessionId,
        inputRoomId: input.inputRoomId ?? null,
        anchorDisplayName: input.anchorDisplayName ?? null,
        status: 'active',
        endReason: null,
        endedAtMs: null,
      }
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  appendEvents(sessionId: number, inputs: readonly DomainEvent[]): CommittedEvents {
    requireSafeNonnegativeInteger(sessionId, 'sessionId')
    if (sessionId === 0) throw new RangeError('sessionId必须大于0')
    const database = this.#getDatabase()
    const events = inputs.map((input) => parseDomainEvent(input))
    for (const event of events) {
      if (event.sessionId !== sessionId) throw new RangeError('事件与目标会话不匹配')
    }

    const session = database
      .prepare('SELECT status FROM sessions WHERE id = ? AND deleted_at_ms IS NULL')
      .get(sessionId) as SqlRow | undefined
    if (session === undefined) throw new Error('会话不存在')
    if (session.status !== 'active') throw new Error('只能向活动会话写入事件')

    const insertedCounts: EventInsertCounts = {
      danmaku: 0,
      gift: 0,
      superChat: 0,
      popularity: 0,
    }
    const committedEvents: DomainEvent[] = []
    let highWatermark: CommittedEvents['highWatermark'] = null

    database.exec('BEGIN IMMEDIATE')
    try {
      for (const event of events) {
        const insertedId = this.#insertEvent(database, event)
        if (insertedId === null) continue
        committedEvents.push(event)

        if (event.type === 'danmaku') insertedCounts.danmaku += 1
        if (event.type === 'gift') insertedCounts.gift += 1
        if (event.type === 'super_chat') insertedCounts.superChat += 1
        if (event.type === 'popularity') insertedCounts.popularity += 1

        this.#updateProjection(database, event, insertedId)
        if (
          highWatermark === null ||
          event.receivedAtMs > highWatermark.receivedAtMs ||
          (event.receivedAtMs === highWatermark.receivedAtMs && insertedId > highWatermark.eventId)
        ) {
          highWatermark = { receivedAtMs: event.receivedAtMs, eventId: insertedId }
        }
      }

      const latestReceivedAt = events.reduce(
        (latest, event) => Math.max(latest, event.receivedAtMs),
        0,
      )
      if (latestReceivedAt > 0) {
        database
          .prepare(
            `UPDATE sessions
             SET last_checkpoint_at_ms = MAX(last_checkpoint_at_ms, ?),
                 updated_at_ms = MAX(updated_at_ms, ?)
             WHERE id = ?`,
          )
          .run(latestReceivedAt, latestReceivedAt, sessionId)
      }
      const metric = database
        .prepare('SELECT active_user_count FROM session_metrics WHERE session_id = ?')
        .get(sessionId) as SqlRow
      const activeUserCount = toNumber(metric.active_user_count)
      database.exec('COMMIT')
      return { sessionId, activeUserCount, insertedCounts, highWatermark, committedEvents }
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  openGap(sessionId: number, reason: string, startedAtMs: number): StoredGap {
    requireSafeNonnegativeInteger(sessionId, 'sessionId')
    requireSafeNonnegativeInteger(startedAtMs, 'startedAtMs')
    requireNonemptyText(reason, 'reason')
    const database = this.#getDatabase()
    const session = database
      .prepare('SELECT status FROM sessions WHERE id = ? AND deleted_at_ms IS NULL')
      .get(sessionId) as SqlRow | undefined
    if (session?.status !== 'active') throw new Error('只能为活动会话记录数据缺口')

    database.exec('BEGIN IMMEDIATE')
    try {
      const existing = database
        .prepare(
          `SELECT * FROM data_gaps
           WHERE session_id = ? AND ended_at_ms IS NULL
           ORDER BY id DESC LIMIT 1`,
        )
        .get(sessionId) as SqlRow | undefined
      let row: SqlRow
      if (existing === undefined) {
        const result = database
          .prepare(
            `INSERT INTO data_gaps (
               session_id, started_at_ms, first_reason, last_reason, retry_count, recovered
             ) VALUES (?, ?, ?, ?, 0, 0)`,
          )
          .run(sessionId, startedAtMs, reason, reason)
        row = {
          id: Number(result.lastInsertRowid),
          session_id: sessionId,
          started_at_ms: startedAtMs,
          ended_at_ms: null,
          first_reason: reason,
          last_reason: reason,
          retry_count: 0,
          recovered: 0,
        }
      } else {
        database
          .prepare(
            `UPDATE data_gaps
             SET last_reason = ?, retry_count = retry_count + 1
             WHERE id = ?`,
          )
          .run(reason, toNumber(existing.id))
        row = {
          ...existing,
          last_reason: reason,
          retry_count: toNumber(existing.retry_count) + 1,
        }
      }
      database
        .prepare(
          `UPDATE sessions SET
             last_checkpoint_at_ms = MAX(last_checkpoint_at_ms, ?),
             updated_at_ms = MAX(updated_at_ms, ?)
           WHERE id = ? AND status = 'active'`,
        )
        .run(startedAtMs, startedAtMs, sessionId)
      database.exec('COMMIT')
      return this.#mapStoredGap(row)
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  closeGap(sessionId: number, endedAtMs: number, recovered: boolean): StoredGap | null {
    requireSafeNonnegativeInteger(sessionId, 'sessionId')
    requireSafeNonnegativeInteger(endedAtMs, 'endedAtMs')
    const database = this.#getDatabase()
    database.exec('BEGIN IMMEDIATE')
    try {
      const existing = database
        .prepare(
          `SELECT * FROM data_gaps
           WHERE session_id = ? AND ended_at_ms IS NULL
           ORDER BY id DESC LIMIT 1`,
        )
        .get(sessionId) as SqlRow | undefined
      if (existing === undefined) {
        database.exec('COMMIT')
        return null
      }
      const startedAtMs = toNumber(existing.started_at_ms)
      if (endedAtMs < startedAtMs) throw new RangeError('缺口结束时间不能早于开始时间')
      database
        .prepare('UPDATE data_gaps SET ended_at_ms = ?, recovered = ? WHERE id = ?')
        .run(endedAtMs, recovered ? 1 : 0, toNumber(existing.id))
      database
        .prepare(
          `UPDATE session_metrics SET
             gap_count = gap_count + 1,
             gap_duration_ms = gap_duration_ms + ?,
             updated_at_ms = MAX(updated_at_ms, ?)
           WHERE session_id = ?`,
        )
        .run(endedAtMs - startedAtMs, endedAtMs, sessionId)
      database.exec('COMMIT')
      return this.#mapStoredGap({
        ...existing,
        ended_at_ms: endedAtMs,
        recovered: recovered ? 1 : 0,
      })
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  finalizeSession(sessionId: number, reason: SessionEndReason, endedAtMs: number): StoredSession {
    requireSafeNonnegativeInteger(endedAtMs, 'endedAtMs')
    const database = this.#getDatabase()
    const existing = database
      .prepare('SELECT * FROM sessions WHERE id = ? AND deleted_at_ms IS NULL')
      .get(sessionId) as SqlRow | undefined
    if (existing === undefined) throw new Error('会话不存在')
    if (existing.status !== 'active') throw new Error('会话已经结束')
    if (endedAtMs < toNumber(existing.started_at_ms))
      throw new RangeError('结束时间不能早于开始时间')

    const status: SessionStatus = reason === 'process_interrupted' ? 'interrupted' : 'completed'
    database.exec('BEGIN IMMEDIATE')
    try {
      const openGap = database
        .prepare(
          `SELECT id, started_at_ms FROM data_gaps
           WHERE session_id = ? AND ended_at_ms IS NULL
           ORDER BY id DESC LIMIT 1`,
        )
        .get(sessionId) as SqlRow | undefined
      if (openGap !== undefined) {
        const gapStartedAtMs = toNumber(openGap.started_at_ms)
        if (endedAtMs < gapStartedAtMs) {
          throw new RangeError('会话结束时间不能早于数据缺口开始时间')
        }
        database
          .prepare('UPDATE data_gaps SET ended_at_ms = ?, recovered = 0 WHERE id = ?')
          .run(endedAtMs, toNumber(openGap.id))
        database
          .prepare(
            `UPDATE session_metrics SET
               gap_count = gap_count + 1,
               gap_duration_ms = gap_duration_ms + ?,
               updated_at_ms = MAX(updated_at_ms, ?)
             WHERE session_id = ?`,
          )
          .run(endedAtMs - gapStartedAtMs, endedAtMs, sessionId)
      }
      database
        .prepare(
          `UPDATE sessions
           SET status = ?, end_reason = ?, ended_at_ms = ?,
               last_checkpoint_at_ms = ?, updated_at_ms = ?
           WHERE id = ? AND status = 'active'`,
        )
        .run(status, reason, endedAtMs, endedAtMs, endedAtMs, sessionId)
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
    database.exec('PRAGMA wal_checkpoint(PASSIVE)')

    return this.#mapStoredSession({
      ...existing,
      status,
      end_reason: reason,
      ended_at_ms: endedAtMs,
    })
  }

  listSessions(limit = 50): SessionSummary[] {
    const pageSize = Math.max(1, Math.min(50, Math.trunc(limit)))
    const rows = this.#getDatabase()
      .prepare(
        `SELECT s.*, m.*
         FROM sessions s
         JOIN session_metrics m ON m.session_id = s.id
         WHERE s.deleted_at_ms IS NULL AND s.status <> 'active'
         ORDER BY s.started_at_ms DESC, s.id DESC
         LIMIT ?`,
      )
      .all(pageSize) as SqlRow[]

    return rows.map((row) => ({
      ...this.#mapStoredSession(row),
      danmakuCount: toNumber(row.danmaku_count),
      activeUserCount: toNumber(row.active_user_count),
      giftCount: toNumber(row.gift_count),
      giftEventCount: toNumber(row.gift_event_count),
      giftKnownValueMilliCny: toNumber(row.gift_known_value_milli_cny),
      giftUnknownValueCount: toNumber(row.gift_unknown_value_count),
      superChatCount: toNumber(row.super_chat_count),
      superChatValueMilliCny: toNumber(row.super_chat_value_milli_cny),
      lastPopularity: nullableNumber(row.last_popularity),
      peakPopularity: nullableNumber(row.peak_popularity),
      gapCount: toNumber(row.gap_count),
      gapDurationMs: toNumber(row.gap_duration_ms),
    }))
  }

  listDanmaku(sessionId: number, options: EventPageOptions): StoredDanmaku[] {
    return this.#queryDanmaku(sessionId, '', options)
  }

  searchDanmaku(sessionId: number, query: string, options: EventPageOptions): StoredDanmaku[] {
    const normalizedQuery = query.trim()
    if (Array.from(normalizedQuery).length > 200) throw new RangeError('搜索文本不能超过200个字符')
    return this.#queryDanmaku(sessionId, normalizedQuery, options)
  }

  deleteSession(sessionId: number): void {
    this.prepareDeletion(sessionId, Date.now())
    while (!this.confirmDeletion(sessionId).done) {
      // 仅保留给存储worker内部测试的同步兼容入口。
    }
  }

  prepareDeletion(sessionId: number, deletedAtMs: number): PrepareDeletionResult {
    requireSafeNonnegativeInteger(sessionId, 'sessionId')
    requireSafeNonnegativeInteger(deletedAtMs, 'deletedAtMs')
    const database = this.#getDatabase()
    const session = database.prepare('SELECT status FROM sessions WHERE id = ?').get(sessionId) as
      SqlRow | undefined
    if (session === undefined) return { sessionId, accepted: false }
    if (session.status === 'active') throw new Error('活动会话不能删除')
    database
      .prepare(
        `UPDATE sessions
         SET deleted_at_ms = COALESCE(deleted_at_ms, ?), updated_at_ms = MAX(updated_at_ms, ?)
         WHERE id = ? AND status <> 'active'`,
      )
      .run(deletedAtMs, deletedAtMs, sessionId)
    return { sessionId, accepted: true }
  }

  confirmDeletion(sessionId: number, batchSize = 5_000): ConfirmDeletionResult {
    requireSafeNonnegativeInteger(sessionId, 'sessionId')
    const limit = Math.max(1, Math.min(5_000, Math.trunc(batchSize)))
    const database = this.#getDatabase()
    const session = database
      .prepare('SELECT deleted_at_ms FROM sessions WHERE id = ?')
      .get(sessionId) as SqlRow | undefined
    if (session === undefined) return { sessionId, done: true, deletedRows: 0 }
    if (session.deleted_at_ms === null) throw new Error('会话尚未进入删除流程')

    const rowIdTables = [
      'danmaku_events',
      'gift_events',
      'super_chat_events',
      'popularity_samples',
      'metric_buckets',
      'session_users',
      'data_gaps',
      'session_transitions',
      'session_metrics',
    ] as const
    database.exec('BEGIN IMMEDIATE')
    try {
      for (const table of rowIdTables) {
        const result = database
          .prepare(
            `DELETE FROM ${table}
             WHERE rowid IN (
               SELECT rowid FROM ${table} WHERE session_id = ? LIMIT ?
             )`,
          )
          .run(sessionId, limit)
        if (result.changes > 0) {
          database.exec('COMMIT')
          return { sessionId, done: false, deletedRows: Number(result.changes) }
        }
      }

      const keywordResult = database
        .prepare(
          `DELETE FROM session_keywords
           WHERE session_id = ? AND term IN (
             SELECT term FROM session_keywords WHERE session_id = ? LIMIT ?
           )`,
        )
        .run(sessionId, sessionId, limit)
      if (keywordResult.changes > 0) {
        database.exec('COMMIT')
        return { sessionId, done: false, deletedRows: Number(keywordResult.changes) }
      }

      database
        .prepare('DELETE FROM sessions WHERE id = ? AND deleted_at_ms IS NOT NULL')
        .run(sessionId)
      database.exec('COMMIT')
      return { sessionId, done: true, deletedRows: 0 }
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  #migrate(database: DatabaseSync): void {
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at_ms INTEGER NOT NULL
      )
    `)
    const userVersionRow = database.prepare('PRAGMA user_version').get() as SqlRow
    const currentVersion = toNumber(userVersionRow.user_version)
    if (currentVersion > MIGRATION_VERSION) throw new Error('数据库版本高于当前应用支持版本')
    const checksum = createHash('sha256').update(DATABASE_SCHEMA).digest('hex')
    if (currentVersion === MIGRATION_VERSION) {
      const migration = database
        .prepare('SELECT checksum FROM schema_migrations WHERE version = ?')
        .get(MIGRATION_VERSION) as SqlRow | undefined
      if (migration === undefined || migration.checksum !== checksum) {
        throw new Error('数据库迁移账本校验失败')
      }
      return
    }

    database.exec('BEGIN IMMEDIATE')
    try {
      database.exec(DATABASE_SCHEMA)
      database
        .prepare(
          `INSERT OR REPLACE INTO schema_migrations
           (version, name, checksum, applied_at_ms) VALUES (?, ?, ?, ?)`,
        )
        .run(MIGRATION_VERSION, 'storage-worker-and-deletion-index', checksum, Date.now())
      database.exec(`PRAGMA user_version = ${MIGRATION_VERSION}`)
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  #recoverInterruptedSessions(database: DatabaseSync, detectedAtMs: number): void {
    const sessions = database
      .prepare(
        `SELECT id, started_at_ms, last_checkpoint_at_ms
         FROM sessions
         WHERE status = 'active' AND deleted_at_ms IS NULL`,
      )
      .all() as SqlRow[]
    if (sessions.length === 0) return

    database.exec('BEGIN IMMEDIATE')
    try {
      for (const session of sessions) {
        const sessionId = toNumber(session.id)
        const endedAtMs = Math.max(
          toNumber(session.started_at_ms),
          toNumber(session.last_checkpoint_at_ms),
        )
        const openGap = database
          .prepare(
            `SELECT id, started_at_ms FROM data_gaps
             WHERE session_id = ? AND ended_at_ms IS NULL
             ORDER BY id DESC LIMIT 1`,
          )
          .get(sessionId) as SqlRow | undefined
        if (openGap !== undefined) {
          const gapStartedAtMs = toNumber(openGap.started_at_ms)
          const gapEndedAtMs = Math.max(gapStartedAtMs, endedAtMs)
          database
            .prepare('UPDATE data_gaps SET ended_at_ms = ?, recovered = 0 WHERE id = ?')
            .run(gapEndedAtMs, toNumber(openGap.id))
          database
            .prepare(
              `UPDATE session_metrics SET
                 gap_count = gap_count + 1,
                 gap_duration_ms = gap_duration_ms + ?,
                 updated_at_ms = MAX(updated_at_ms, ?)
               WHERE session_id = ?`,
            )
            .run(gapEndedAtMs - gapStartedAtMs, gapEndedAtMs, sessionId)
        }
        database
          .prepare(
            `UPDATE sessions
             SET status = 'interrupted',
                 end_reason = 'process_interrupted',
                 ended_at_ms = ?,
                 interruption_detected_at_ms = ?,
                 updated_at_ms = MAX(updated_at_ms, ?)
             WHERE id = ? AND status = 'active'`,
          )
          .run(endedAtMs, detectedAtMs, detectedAtMs, sessionId)
      }
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  #insertEvent(database: DatabaseSync, event: DomainEvent): number | null {
    if (event.type === 'danmaku') {
      const result = database
        .prepare(
          `INSERT INTO danmaku_events (
             session_id, source_event_key, received_at_ms, sent_at_ms,
             local_user_key, display_name, text, medal_name, medal_level
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT DO NOTHING`,
        )
        .run(
          event.sessionId,
          event.sourceEventKey,
          event.receivedAtMs,
          event.sentAtMs,
          event.localUserKey,
          event.displayName,
          event.text,
          event.medalName,
          event.medalLevel,
        )
      return result.changes === 0 ? null : Number(result.lastInsertRowid)
    }

    if (event.type === 'gift') {
      const result = database
        .prepare(
          `INSERT INTO gift_events (
             session_id, source_event_key, received_at_ms, sent_at_ms,
             local_user_key, display_name, gift_name, quantity,
             unit_value_milli_cny, total_value_milli_cny
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT DO NOTHING`,
        )
        .run(
          event.sessionId,
          event.sourceEventKey,
          event.receivedAtMs,
          event.sentAtMs,
          event.localUserKey,
          event.displayName,
          event.giftName,
          event.quantity,
          event.unitValueMilliCny,
          event.totalValueMilliCny,
        )
      return result.changes === 0 ? null : Number(result.lastInsertRowid)
    }

    if (event.type === 'super_chat') {
      const result = database
        .prepare(
          `INSERT INTO super_chat_events (
             session_id, source_event_key, received_at_ms, sent_at_ms,
             local_user_key, display_name, text, value_milli_cny, expires_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT DO NOTHING`,
        )
        .run(
          event.sessionId,
          event.sourceEventKey,
          event.receivedAtMs,
          event.sentAtMs,
          event.localUserKey,
          event.displayName,
          event.text,
          event.valueMilliCny,
          event.expiresAtMs,
        )
      return result.changes === 0 ? null : Number(result.lastInsertRowid)
    }

    const result = database
      .prepare(
        'INSERT INTO popularity_samples (session_id, received_at_ms, value) VALUES (?, ?, ?)',
      )
      .run(event.sessionId, event.receivedAtMs, event.value)
    return Number(result.lastInsertRowid)
  }

  #updateProjection(database: DatabaseSync, event: DomainEvent, eventId: number): void {
    const bucketStartMs = Math.floor(event.receivedAtMs / 10_000) * 10_000

    if (event.type === 'danmaku') {
      database
        .prepare(
          `UPDATE session_metrics SET
             danmaku_count = danmaku_count + 1,
             first_danmaku_event_id = COALESCE(first_danmaku_event_id, ?),
             last_danmaku_event_id = ?,
             last_message_at_ms = MAX(COALESCE(last_message_at_ms, 0), ?),
             updated_at_ms = MAX(updated_at_ms, ?)
           WHERE session_id = ?`,
        )
        .run(eventId, eventId, event.receivedAtMs, event.receivedAtMs, event.sessionId)
      database
        .prepare(
          `INSERT INTO metric_buckets (session_id, bucket_start_ms, danmaku_count)
           VALUES (?, ?, 1)
           ON CONFLICT(session_id, bucket_start_ms) DO UPDATE SET
             danmaku_count = danmaku_count + 1`,
        )
        .run(event.sessionId, bucketStartMs)

      if (event.localUserKey !== null) {
        database
          .prepare(
            `INSERT INTO session_users (
               session_id, local_user_key, last_display_name, danmaku_count,
               first_danmaku_at_ms, last_danmaku_at_ms
             ) VALUES (?, ?, ?, 1, ?, ?)
             ON CONFLICT(session_id, local_user_key) DO UPDATE SET
               last_display_name = excluded.last_display_name,
               danmaku_count = danmaku_count + 1,
               last_danmaku_at_ms = MAX(last_danmaku_at_ms, excluded.last_danmaku_at_ms)`,
          )
          .run(
            event.sessionId,
            event.localUserKey,
            event.displayName,
            event.receivedAtMs,
            event.receivedAtMs,
          )
        database
          .prepare(
            `UPDATE session_metrics SET active_user_count = (
               SELECT COUNT(*) FROM session_users WHERE session_id = ?
             ) WHERE session_id = ?`,
          )
          .run(event.sessionId, event.sessionId)
      }
      return
    }

    if (event.type === 'gift') {
      const knownValue = event.totalValueMilliCny ?? 0
      const unknownValueCount = event.totalValueMilliCny === null ? event.quantity : 0
      database
        .prepare(
          `UPDATE session_metrics SET
             gift_count = gift_count + ?, gift_event_count = gift_event_count + 1,
             gift_known_value_milli_cny = gift_known_value_milli_cny + ?,
             gift_unknown_value_count = gift_unknown_value_count + ?,
             last_message_at_ms = MAX(COALESCE(last_message_at_ms, 0), ?),
             updated_at_ms = MAX(updated_at_ms, ?)
           WHERE session_id = ?`,
        )
        .run(
          event.quantity,
          knownValue,
          unknownValueCount,
          event.receivedAtMs,
          event.receivedAtMs,
          event.sessionId,
        )
      database
        .prepare(
          `INSERT INTO metric_buckets (
             session_id, bucket_start_ms, gift_count, gift_known_value_milli_cny
           ) VALUES (?, ?, ?, ?)
           ON CONFLICT(session_id, bucket_start_ms) DO UPDATE SET
             gift_count = gift_count + excluded.gift_count,
             gift_known_value_milli_cny =
               gift_known_value_milli_cny + excluded.gift_known_value_milli_cny`,
        )
        .run(event.sessionId, bucketStartMs, event.quantity, knownValue)
      return
    }

    if (event.type === 'super_chat') {
      database
        .prepare(
          `UPDATE session_metrics SET
             super_chat_count = super_chat_count + 1,
             super_chat_value_milli_cny = super_chat_value_milli_cny + ?,
             last_message_at_ms = MAX(COALESCE(last_message_at_ms, 0), ?),
             updated_at_ms = MAX(updated_at_ms, ?)
           WHERE session_id = ?`,
        )
        .run(event.valueMilliCny, event.receivedAtMs, event.receivedAtMs, event.sessionId)
      database
        .prepare(
          `INSERT INTO metric_buckets (
             session_id, bucket_start_ms, super_chat_count, super_chat_value_milli_cny
           ) VALUES (?, ?, 1, ?)
           ON CONFLICT(session_id, bucket_start_ms) DO UPDATE SET
             super_chat_count = super_chat_count + 1,
             super_chat_value_milli_cny =
               super_chat_value_milli_cny + excluded.super_chat_value_milli_cny`,
        )
        .run(event.sessionId, bucketStartMs, event.valueMilliCny)
      return
    }

    database
      .prepare(
        `UPDATE session_metrics SET
           last_popularity = ?,
           peak_popularity = MAX(COALESCE(peak_popularity, 0), ?),
           updated_at_ms = MAX(updated_at_ms, ?)
         WHERE session_id = ?`,
      )
      .run(event.value, event.value, event.receivedAtMs, event.sessionId)
    database
      .prepare(
        `INSERT INTO metric_buckets (
           session_id, bucket_start_ms, popularity_last, popularity_peak
         ) VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id, bucket_start_ms) DO UPDATE SET
           popularity_last = excluded.popularity_last,
           popularity_peak = MAX(COALESCE(popularity_peak, 0), excluded.popularity_peak)`,
      )
      .run(event.sessionId, bucketStartMs, event.value, event.value)
  }

  #queryDanmaku(sessionId: number, query: string, options: EventPageOptions): StoredDanmaku[] {
    const limit = Math.max(1, Math.min(100, Math.trunc(options.limit)))
    const cursor = options.before
    const useFts = Array.from(query).length >= 3
    const cursorClause =
      cursor === undefined
        ? ''
        : 'AND (d.received_at_ms < ? OR (d.received_at_ms = ? AND d.id < ?))'
    const parameters: Array<string | number> = []
    const source = useFts
      ? `danmaku_fts
         JOIN danmaku_events d ON d.id = danmaku_fts.rowid`
      : 'danmaku_events d'
    const queryClause =
      query.length === 0
        ? ''
        : useFts
          ? 'AND danmaku_fts MATCH ?'
          : 'AND (instr(d.text, ?) > 0 OR instr(d.display_name, ?) > 0)'
    parameters.push(sessionId)
    if (query.length > 0) {
      if (useFts) parameters.push(`"${query.replaceAll('"', '""')}"`)
      else parameters.push(query, query)
    }
    if (cursor !== undefined) {
      parameters.push(cursor.receivedAtMs, cursor.receivedAtMs, cursor.id)
    }
    parameters.push(limit)

    const rows = this.#getDatabase()
      .prepare(
        `SELECT d.id, d.session_id, d.received_at_ms, d.sent_at_ms,
                d.display_name, d.text, d.medal_name, d.medal_level
         FROM ${source}
         WHERE d.session_id = ?
           AND EXISTS (
             SELECT 1 FROM sessions
             WHERE sessions.id = d.session_id
               AND sessions.deleted_at_ms IS NULL
           )
           ${queryClause} ${cursorClause}
         ORDER BY d.received_at_ms DESC, d.id DESC
         LIMIT ?`,
      )
      .all(...parameters) as SqlRow[]

    return rows.map((row) => ({
      id: toNumber(row.id),
      sessionId: toNumber(row.session_id),
      receivedAtMs: toNumber(row.received_at_ms),
      sentAtMs: nullableNumber(row.sent_at_ms),
      displayName: toText(row.display_name),
      text: toText(row.text),
      medalName: nullableText(row.medal_name),
      medalLevel: nullableNumber(row.medal_level),
    }))
  }

  #mapStoredSession(row: SqlRow): StoredSession {
    return {
      id: toNumber(row.id),
      platform: toText(row.platform) as LivePlatform,
      roomId: toText(row.room_id),
      inputRoomId: nullableText(row.input_room_id),
      roomTitle: toText(row.room_title),
      anchorDisplayName: nullableText(row.anchor_display_name),
      adapterVersion: toText(row.adapter_version),
      startedAtMs: toNumber(row.started_at_ms),
      status: toText(row.status) as SessionStatus,
      endReason: nullableText(row.end_reason) as SessionEndReason | null,
      endedAtMs: nullableNumber(row.ended_at_ms),
    }
  }

  #getDatabase(): DatabaseSync {
    if (this.#database === null) throw new Error('本地资料库尚未初始化')
    return this.#database
  }

  #mapStoredGap(row: SqlRow): StoredGap {
    return {
      id: toNumber(row.id),
      sessionId: toNumber(row.session_id),
      startedAtMs: toNumber(row.started_at_ms),
      endedAtMs: nullableNumber(row.ended_at_ms),
      firstReason: String(row.first_reason),
      lastReason: String(row.last_reason),
      retryCount: toNumber(row.retry_count),
      recovered: toNumber(row.recovered) === 1,
    }
  }
}
