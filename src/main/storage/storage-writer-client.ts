import { Worker } from 'node:worker_threads'

import { z } from 'zod'

import { domainEventSchema, type DomainEvent } from '../../domain/events'
import type {
  CommittedEvents,
  CreateSessionInput,
  SessionEndReason,
  StoredGap,
  StoredSession,
} from './local-store'
import { StorageError, type StorageWriter } from './storage-writer'

export interface StorageWorkerPort {
  postMessage(message: unknown): void
  on(event: 'message', listener: (message: unknown) => void): this
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'exit', listener: (code: number) => void): this
  terminate(): Promise<number>
}

export interface StorageWorkerFactoryOptions {
  workerData: { kind: 'storage-writer'; databasePath: string }
}

export type StorageWorkerFactory = (
  filename: string,
  options: StorageWorkerFactoryOptions,
) => StorageWorkerPort

export type StorageWriterCommand =
  | { kind: 'storage-command'; id: number; command: 'initialize'; payload: null }
  | {
      kind: 'storage-command'
      id: number
      command: 'createSession'
      payload: CreateSessionInput
    }
  | {
      kind: 'storage-command'
      id: number
      command: 'appendBatch'
      payload: { sessionId: number; events: readonly DomainEvent[] }
    }
  | {
      kind: 'storage-command'
      id: number
      command: 'finalizeSession'
      payload: { sessionId: number; reason: SessionEndReason; endedAtMs: number }
    }
  | {
      kind: 'storage-command'
      id: number
      command: 'openGap'
      payload: { sessionId: number; reason: string; startedAtMs: number }
    }
  | {
      kind: 'storage-command'
      id: number
      command: 'closeGap'
      payload: { sessionId: number; endedAtMs: number; recovered: boolean }
    }
  | {
      kind: 'storage-command'
      id: number
      command: 'prepareDeletion'
      payload: { sessionId: number; deletedAtMs: number }
    }
  | {
      kind: 'storage-command'
      id: number
      command: 'confirmDeletion'
      payload: { sessionId: number; batchSize: number }
    }
  | { kind: 'storage-command'; id: number; command: 'shutdown'; payload: null }

export type StorageWriterCommandName = StorageWriterCommand['command']

interface PendingRequest {
  command: StorageWriterCommandName
  resolve: (value: unknown) => void
  reject: (error: StorageError) => void
  timer: NodeJS.Timeout
}

const responseEnvelopeSchema = z
  .object({
    kind: z.literal('storage-response'),
    id: z.number().int().positive(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    errorCode: z.string().optional(),
  })
  .strict()

const committedEventsSchema = z
  .object({
    sessionId: z.number().int().positive(),
    activeUserCount: z.number().int().nonnegative(),
    insertedCounts: z
      .object({
        danmaku: z.number().int().nonnegative(),
        gift: z.number().int().nonnegative(),
        superChat: z.number().int().nonnegative(),
        popularity: z.number().int().nonnegative(),
      })
      .strict(),
    highWatermark: z
      .object({
        receivedAtMs: z.number().int().nonnegative(),
        eventId: z.number().int().positive(),
      })
      .strict()
      .nullable(),
    committedEvents: z.array(domainEventSchema),
  })
  .strict()

const prepareDeletionSchema = z
  .object({ sessionId: z.number().int().positive(), accepted: z.boolean() })
  .strict()

const confirmDeletionSchema = z
  .object({
    sessionId: z.number().int().positive(),
    done: z.boolean(),
    deletedRows: z.number().int().nonnegative().max(5_000),
  })
  .strict()

const defaultWorkerFactory: StorageWorkerFactory = (filename, options) =>
  new Worker(filename, options)

export class StorageWriterClient implements StorageWriter {
  readonly #worker: StorageWorkerPort
  readonly #requestTimeoutMs: number
  readonly #pending = new Map<number, PendingRequest>()
  #nextRequestId = 1
  #closed = false

  constructor(
    workerPath: string,
    databasePath: string,
    options: {
      workerFactory?: StorageWorkerFactory
      requestTimeoutMs?: number
    } = {},
  ) {
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 10_000
    this.#worker = (options.workerFactory ?? defaultWorkerFactory)(workerPath, {
      workerData: { kind: 'storage-writer', databasePath },
    })
    this.#worker.on('message', (message) => this.#handleMessage(message))
    this.#worker.on('error', (error) => {
      this.#failAll(new StorageError('STORAGE_WORKER_EXITED', { cause: error }))
    })
    this.#worker.on('exit', (code) => {
      if (!this.#closed || code !== 0) this.#failAll(new StorageError('STORAGE_WORKER_EXITED'))
    })
  }

  async initialize(): Promise<void> {
    await this.#request({
      kind: 'storage-command',
      id: this.#takeRequestId(),
      command: 'initialize',
      payload: null,
    })
  }

  async createSession(input: CreateSessionInput): Promise<StoredSession> {
    return (await this.#request({
      kind: 'storage-command',
      id: this.#takeRequestId(),
      command: 'createSession',
      payload: input,
    })) as StoredSession
  }

  async appendBatch(sessionId: number, events: readonly DomainEvent[]): Promise<CommittedEvents> {
    return (await this.#request({
      kind: 'storage-command',
      id: this.#takeRequestId(),
      command: 'appendBatch',
      payload: { sessionId, events },
    })) as CommittedEvents
  }

  async finalizeSession(
    sessionId: number,
    reason: SessionEndReason,
    endedAtMs: number,
  ): Promise<StoredSession> {
    return (await this.#request({
      kind: 'storage-command',
      id: this.#takeRequestId(),
      command: 'finalizeSession',
      payload: { sessionId, reason, endedAtMs },
    })) as StoredSession
  }

  async openGap(sessionId: number, reason: string, startedAtMs: number): Promise<StoredGap> {
    return (await this.#request({
      kind: 'storage-command',
      id: this.#takeRequestId(),
      command: 'openGap',
      payload: { sessionId, reason, startedAtMs },
    })) as StoredGap
  }

  async closeGap(
    sessionId: number,
    endedAtMs: number,
    recovered: boolean,
  ): Promise<StoredGap | null> {
    return (await this.#request({
      kind: 'storage-command',
      id: this.#takeRequestId(),
      command: 'closeGap',
      payload: { sessionId, endedAtMs, recovered },
    })) as StoredGap | null
  }

  async deleteSession(sessionId: number, deletedAtMs: number): Promise<void> {
    const prepared = prepareDeletionSchema.parse(
      await this.#request({
        kind: 'storage-command',
        id: this.#takeRequestId(),
        command: 'prepareDeletion',
        payload: { sessionId, deletedAtMs },
      }),
    )
    if (!prepared.accepted) return

    while (true) {
      const confirmed = confirmDeletionSchema.parse(
        await this.#request({
          kind: 'storage-command',
          id: this.#takeRequestId(),
          command: 'confirmDeletion',
          payload: { sessionId, batchSize: 5_000 },
        }),
      )
      if (confirmed.done) return
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }

  async shutdown(): Promise<void> {
    if (this.#closed) return
    try {
      await this.#request({
        kind: 'storage-command',
        id: this.#takeRequestId(),
        command: 'shutdown',
        payload: null,
      })
    } finally {
      this.#closed = true
      await this.#worker.terminate()
    }
  }

  #takeRequestId(): number {
    const id = this.#nextRequestId
    this.#nextRequestId += 1
    return id
  }

  #request(command: StorageWriterCommand): Promise<unknown> {
    if (this.#closed) return Promise.reject(new StorageError('STORAGE_CLOSED'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(command.id)
        reject(new StorageError('STORAGE_WORKER_TIMEOUT'))
      }, this.#requestTimeoutMs)
      this.#pending.set(command.id, { command: command.command, resolve, reject, timer })
      this.#worker.postMessage(command)
    })
  }

  #handleMessage(message: unknown): void {
    const parsed = responseEnvelopeSchema.safeParse(message)
    if (!parsed.success) {
      this.#failAll(new StorageError('STORAGE_PROTOCOL_ERROR'))
      return
    }
    const pending = this.#pending.get(parsed.data.id)
    if (pending === undefined) return
    this.#pending.delete(parsed.data.id)
    clearTimeout(pending.timer)

    if (!parsed.data.ok) {
      pending.reject(new StorageError('STORAGE_WRITE_FAILED'))
      return
    }
    if (pending.command === 'appendBatch') {
      const result = committedEventsSchema.safeParse(parsed.data.result)
      if (!result.success) {
        pending.reject(new StorageError('STORAGE_PROTOCOL_ERROR'))
        return
      }
      pending.resolve(result.data)
      return
    }
    pending.resolve(parsed.data.result)
  }

  #failAll(error: StorageError): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }
}
