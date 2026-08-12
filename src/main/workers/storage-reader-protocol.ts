import { z } from 'zod'

import type { EventPageOptions } from '../storage/local-store'

const positiveSafeInteger = z.number().refine((value) => Number.isSafeInteger(value) && value > 0)
const nonnegativeSafeInteger = z
  .number()
  .refine((value) => Number.isSafeInteger(value) && value >= 0)
const pageOptionsSchema = z
  .object({
    limit: z.number().int().min(1).max(100),
    before: z
      .object({ receivedAtMs: nonnegativeSafeInteger, id: positiveSafeInteger })
      .strict()
      .optional(),
  })
  .strict()

const envelope = {
  kind: z.literal('reader-query'),
  id: positiveSafeInteger,
}

const listSessionsSchema = z
  .object({
    ...envelope,
    query: z.literal('listSessions'),
    payload: z.object({ limit: z.number().int().min(1).max(50) }).strict(),
  })
  .strict()
const listDanmakuSchema = z
  .object({
    ...envelope,
    query: z.literal('listDanmaku'),
    payload: z.object({ sessionId: positiveSafeInteger, options: pageOptionsSchema }).strict(),
  })
  .strict()
const getSessionReviewSchema = z
  .object({
    ...envelope,
    query: z.literal('getSessionReview'),
    payload: z.object({ sessionId: positiveSafeInteger }).strict(),
  })
  .strict()
const searchDanmakuSchema = z
  .object({
    ...envelope,
    query: z.literal('searchDanmaku'),
    payload: z
      .object({
        sessionId: positiveSafeInteger,
        query: z.string().max(200),
        options: pageOptionsSchema,
      })
      .strict(),
  })
  .strict()
const shutdownSchema = z
  .object({
    ...envelope,
    query: z.literal('shutdown'),
    payload: z.null(),
  })
  .strict()

const readerQuerySchema = z.discriminatedUnion('query', [
  listSessionsSchema,
  getSessionReviewSchema,
  listDanmakuSchema,
  searchDanmakuSchema,
  shutdownSchema,
])

export type StorageReaderQuery =
  | { kind: 'reader-query'; id: number; query: 'listSessions'; payload: { limit: number } }
  | {
      kind: 'reader-query'
      id: number
      query: 'getSessionReview'
      payload: { sessionId: number }
    }
  | {
      kind: 'reader-query'
      id: number
      query: 'listDanmaku'
      payload: { sessionId: number; options: EventPageOptions }
    }
  | {
      kind: 'reader-query'
      id: number
      query: 'searchDanmaku'
      payload: { sessionId: number; query: string; options: EventPageOptions }
    }
  | { kind: 'reader-query'; id: number; query: 'shutdown'; payload: null }

export interface StorageReaderResponse {
  kind: 'reader-response'
  id: number
  ok: boolean
  result?: unknown
  errorCode?: 'READ_UNAVAILABLE' | 'READER_PROTOCOL_ERROR'
}

export function parseStorageReaderQuery(input: unknown): StorageReaderQuery {
  return readerQuerySchema.parse(input) as StorageReaderQuery
}
