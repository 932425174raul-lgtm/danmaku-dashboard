import { z } from 'zod'

import { domainEventSchema } from '../../domain/events'
import type { StorageWriterCommand } from '../storage/storage-writer-client'

const positiveSafeInteger = z.number().refine((value) => Number.isSafeInteger(value) && value > 0)
const nonnegativeSafeInteger = z
  .number()
  .refine((value) => Number.isSafeInteger(value) && value >= 0)
const boundedText = (maximum: number) =>
  z.string().refine((value) => value.trim().length > 0 && Array.from(value).length <= maximum)

const envelope = {
  kind: z.literal('storage-command'),
  id: positiveSafeInteger,
}

const initializeCommandSchema = z
  .object({
    ...envelope,
    command: z.literal('initialize'),
    payload: z.null(),
  })
  .strict()

const createSessionCommandSchema = z
  .object({
    ...envelope,
    command: z.literal('createSession'),
    payload: z
      .object({
        platform: z.enum(['bilibili', 'douyin']),
        roomId: boundedText(128),
        inputRoomId: boundedText(512).nullable().optional(),
        roomTitle: boundedText(512),
        anchorDisplayName: boundedText(128).nullable().optional(),
        adapterVersion: boundedText(128),
        startedAtMs: nonnegativeSafeInteger,
      })
      .strict(),
  })
  .strict()

const appendBatchCommandSchema = z
  .object({
    ...envelope,
    command: z.literal('appendBatch'),
    payload: z
      .object({
        sessionId: positiveSafeInteger,
        events: z.array(domainEventSchema).max(500),
      })
      .strict(),
  })
  .strict()

const finalizeSessionCommandSchema = z
  .object({
    ...envelope,
    command: z.literal('finalizeSession'),
    payload: z
      .object({
        sessionId: positiveSafeInteger,
        reason: z.enum(['user_stop', 'live_ended', 'app_quit', 'process_interrupted']),
        endedAtMs: nonnegativeSafeInteger,
      })
      .strict(),
  })
  .strict()

const openGapCommandSchema = z
  .object({
    ...envelope,
    command: z.literal('openGap'),
    payload: z
      .object({
        sessionId: positiveSafeInteger,
        reason: boundedText(128),
        startedAtMs: nonnegativeSafeInteger,
      })
      .strict(),
  })
  .strict()

const closeGapCommandSchema = z
  .object({
    ...envelope,
    command: z.literal('closeGap'),
    payload: z
      .object({
        sessionId: positiveSafeInteger,
        endedAtMs: nonnegativeSafeInteger,
        recovered: z.boolean(),
      })
      .strict(),
  })
  .strict()

const prepareDeletionCommandSchema = z
  .object({
    ...envelope,
    command: z.literal('prepareDeletion'),
    payload: z
      .object({ sessionId: positiveSafeInteger, deletedAtMs: nonnegativeSafeInteger })
      .strict(),
  })
  .strict()

const confirmDeletionCommandSchema = z
  .object({
    ...envelope,
    command: z.literal('confirmDeletion'),
    payload: z.object({ sessionId: positiveSafeInteger, batchSize: z.literal(5_000) }).strict(),
  })
  .strict()

const shutdownCommandSchema = z
  .object({
    ...envelope,
    command: z.literal('shutdown'),
    payload: z.null(),
  })
  .strict()

const storageWriterCommandSchema = z.discriminatedUnion('command', [
  initializeCommandSchema,
  createSessionCommandSchema,
  appendBatchCommandSchema,
  finalizeSessionCommandSchema,
  openGapCommandSchema,
  closeGapCommandSchema,
  prepareDeletionCommandSchema,
  confirmDeletionCommandSchema,
  shutdownCommandSchema,
])

export interface StorageWriterResponse {
  kind: 'storage-response'
  id: number
  ok: boolean
  result?: unknown
  errorCode?: 'STORAGE_COMMAND_FAILED' | 'STORAGE_PROTOCOL_ERROR'
}

export function parseStorageWriterCommand(input: unknown): StorageWriterCommand {
  return storageWriterCommandSchema.parse(input) as StorageWriterCommand
}
