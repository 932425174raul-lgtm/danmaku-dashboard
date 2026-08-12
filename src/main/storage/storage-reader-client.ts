import { Worker } from 'node:worker_threads'

import { z } from 'zod'

import type { EventPageOptions, SessionReview, SessionSummary, StoredDanmaku } from './local-store'
import type { StorageReaderQuery } from '../workers/storage-reader-protocol'

export interface StorageReader {
  listSessions(limit?: number): Promise<SessionSummary[]>
  getSessionReview(sessionId: number): Promise<SessionReview | null>
  listDanmaku(sessionId: number, options: EventPageOptions): Promise<StoredDanmaku[]>
  searchDanmaku(
    sessionId: number,
    query: string,
    options: EventPageOptions,
  ): Promise<StoredDanmaku[]>
  shutdown(): Promise<void>
}

export interface StorageReaderWorkerPort {
  postMessage(message: unknown): void
  on(event: 'message', listener: (message: unknown) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'exit', listener: (code: number) => void): this
  terminate(): Promise<number>
}

export type StorageReaderWorkerFactory = (
  filename: string,
  options: { workerData: { kind: 'storage-reader'; databasePath: string } },
) => StorageReaderWorkerPort

export class StorageReadError extends Error {
  readonly code = 'READ_UNAVAILABLE'

  constructor(options?: ErrorOptions) {
    super('READ_UNAVAILABLE', options)
    this.name = 'StorageReadError'
  }
}

interface PendingRequest {
  query: StorageReaderQuery['query']
  resolve: (value: unknown) => void
  reject: (error: StorageReadError) => void
  timer: NodeJS.Timeout
}

const responseSchema = z
  .object({
    kind: z.literal('reader-response'),
    id: z.number().int().positive(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    errorCode: z.string().optional(),
  })
  .strict()
const danmakuSchema = z
  .object({
    id: z.number().int().positive(),
    sessionId: z.number().int().positive(),
    receivedAtMs: z.number().int().nonnegative(),
    sentAtMs: z.number().int().nonnegative().nullable(),
    displayName: z.string().max(128),
    text: z.string().max(2_000),
    medalName: z.string().max(64).nullable(),
    medalLevel: z.number().int().nonnegative().nullable(),
  })
  .strict()
const sessionSummarySchema = z
  .object({
    id: z.number().int().positive(),
    platform: z.enum(['bilibili', 'douyin']),
    roomId: z.string(),
    inputRoomId: z.string().nullable(),
    roomTitle: z.string(),
    anchorDisplayName: z.string().nullable(),
    adapterVersion: z.string(),
    startedAtMs: z.number().int().nonnegative(),
    status: z.enum(['active', 'completed', 'interrupted']),
    endReason: z.enum(['user_stop', 'live_ended', 'app_quit', 'process_interrupted']).nullable(),
    endedAtMs: z.number().int().nonnegative().nullable(),
    danmakuCount: z.number().int().nonnegative(),
    activeUserCount: z.number().int().nonnegative(),
    giftCount: z.number().int().nonnegative(),
    giftEventCount: z.number().int().nonnegative(),
    giftKnownValueMilliCny: z.number().int().nonnegative(),
    giftUnknownValueCount: z.number().int().nonnegative(),
    superChatCount: z.number().int().nonnegative(),
    superChatValueMilliCny: z.number().int().nonnegative(),
    lastPopularity: z.number().int().nonnegative().nullable(),
    peakPopularity: z.number().int().nonnegative().nullable(),
    gapCount: z.number().int().nonnegative(),
    gapDurationMs: z.number().int().nonnegative(),
  })
  .strict()
const reviewBucketSchema = z
  .object({
    bucketStartMs: z.number().int().nonnegative(),
    bucketEndMs: z.number().int().nonnegative(),
    danmakuCount: z.number().int().nonnegative(),
    activeSpeakerCount: z.number().int().nonnegative(),
    giftCount: z.number().int().nonnegative(),
    superChatCount: z.number().int().nonnegative(),
    popularityPeak: z.number().int().nonnegative().nullable(),
    hasGap: z.boolean(),
  })
  .strict()
const repeatedDanmakuSchema = z
  .object({
    text: z.string().max(2_000),
    count: z.number().int().min(2),
    uniqueUserCount: z.number().int().nonnegative(),
    firstAtMs: z.number().int().nonnegative(),
    lastAtMs: z.number().int().nonnegative(),
  })
  .strict()
const sessionReviewSchema = z
  .object({
    sessionId: z.number().int().positive(),
    startedAtMs: z.number().int().nonnegative(),
    endedAtMs: z.number().int().nonnegative(),
    bucketMinutes: z.number().int().min(5),
    totals: z
      .object({
        danmakuCount: z.number().int().nonnegative(),
        activeUserCount: z.number().int().nonnegative(),
        giftCount: z.number().int().nonnegative(),
        superChatCount: z.number().int().nonnegative(),
        gapCount: z.number().int().nonnegative(),
        gapDurationMs: z.number().int().nonnegative(),
      })
      .strict(),
    buckets: z.array(reviewBucketSchema).min(1).max(144),
    repeatedDanmaku: z.array(repeatedDanmakuSchema).max(5),
    mostRepeatedDanmaku: repeatedDanmakuSchema.nullable(),
    peakDanmakuBucket: reviewBucketSchema.nullable(),
    peakActiveSpeakerBucket: reviewBucketSchema.nullable(),
    topThreeDanmakuShare: z.number().min(0).max(1),
  })
  .strict()

const defaultWorkerFactory: StorageReaderWorkerFactory = (filename, options) =>
  new Worker(filename, options)

export class StorageReaderClient implements StorageReader {
  readonly #worker: StorageReaderWorkerPort
  readonly #timeoutMs: number
  readonly #pending = new Map<number, PendingRequest>()
  #nextId = 1
  #closed = false

  constructor(
    workerPath: string,
    databasePath: string,
    options: { workerFactory?: StorageReaderWorkerFactory; requestTimeoutMs?: number } = {},
  ) {
    this.#timeoutMs = options.requestTimeoutMs ?? 10_000
    this.#worker = (options.workerFactory ?? defaultWorkerFactory)(workerPath, {
      workerData: { kind: 'storage-reader', databasePath },
    })
    this.#worker.on('message', (message) => this.#handleMessage(message))
    this.#worker.on('error', (error) => this.#failAll(new StorageReadError({ cause: error })))
    this.#worker.on('exit', (code) => {
      if (!this.#closed || code !== 0) this.#failAll(new StorageReadError())
    })
  }

  async listSessions(limit = 50): Promise<SessionSummary[]> {
    return (await this.#request({
      kind: 'reader-query',
      id: this.#takeId(),
      query: 'listSessions',
      payload: { limit },
    })) as SessionSummary[]
  }

  async listDanmaku(sessionId: number, options: EventPageOptions): Promise<StoredDanmaku[]> {
    return (await this.#request({
      kind: 'reader-query',
      id: this.#takeId(),
      query: 'listDanmaku',
      payload: { sessionId, options },
    })) as StoredDanmaku[]
  }

  async getSessionReview(sessionId: number): Promise<SessionReview | null> {
    return (await this.#request(
      {
        kind: 'reader-query',
        id: this.#takeId(),
        query: 'getSessionReview',
        payload: { sessionId },
      },
      Math.max(this.#timeoutMs, 30_000),
    )) as SessionReview | null
  }

  async searchDanmaku(
    sessionId: number,
    query: string,
    options: EventPageOptions,
  ): Promise<StoredDanmaku[]> {
    return (await this.#request({
      kind: 'reader-query',
      id: this.#takeId(),
      query: 'searchDanmaku',
      payload: { sessionId, query, options },
    })) as StoredDanmaku[]
  }

  async shutdown(): Promise<void> {
    if (this.#closed) return
    try {
      await this.#request({
        kind: 'reader-query',
        id: this.#takeId(),
        query: 'shutdown',
        payload: null,
      })
    } finally {
      this.#closed = true
      await this.#worker.terminate()
    }
  }

  #takeId(): number {
    const id = this.#nextId
    this.#nextId += 1
    return id
  }

  #request(query: StorageReaderQuery, timeoutMs = this.#timeoutMs): Promise<unknown> {
    if (this.#closed) return Promise.reject(new StorageReadError())
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(query.id)
        reject(new StorageReadError())
      }, timeoutMs)
      this.#pending.set(query.id, { query: query.query, resolve, reject, timer })
      this.#worker.postMessage(query)
    })
  }

  #handleMessage(input: unknown): void {
    const response = responseSchema.safeParse(input)
    if (!response.success) {
      this.#failAll(new StorageReadError())
      return
    }
    const pending = this.#pending.get(response.data.id)
    if (pending === undefined) return
    this.#pending.delete(response.data.id)
    clearTimeout(pending.timer)
    if (!response.data.ok) {
      pending.reject(new StorageReadError())
      return
    }

    const result =
      pending.query === 'listSessions'
        ? z.array(sessionSummarySchema).safeParse(response.data.result)
        : pending.query === 'getSessionReview'
          ? sessionReviewSchema.nullable().safeParse(response.data.result)
          : pending.query === 'listDanmaku' || pending.query === 'searchDanmaku'
            ? z.array(danmakuSchema).safeParse(response.data.result)
            : z.null().safeParse(response.data.result)
    if (!result.success) {
      pending.reject(new StorageReadError())
      return
    }
    pending.resolve(result.data)
  }

  #failAll(error: StorageReadError): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }
}
