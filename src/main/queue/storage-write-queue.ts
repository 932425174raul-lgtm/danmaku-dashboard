import type { DomainEvent } from '../../domain/events'
import type { CommittedEvents } from '../storage/local-store'
import { StorageError, type StorageWriter, toStorageError } from '../storage/storage-writer'

interface QueuedEvent {
  sessionId: number
  event: DomainEvent
  enqueuedAtMs: number
  acknowledgementId: number | null
}

interface PendingAcknowledgement {
  remaining: number
  resolve: () => void
  reject: (error: StorageError) => void
}

export interface StorageWriteQueueOptions {
  onCommitted: (result: CommittedEvents) => void
  onError?: (error: StorageError) => void
  maxEvents?: number
  maxAgeMs?: number
  maxBatchSize?: number
  flushAfterMs?: number
  now?: () => number
}

export interface StorageWriteQueueMetrics {
  size: number
  oldestAgeMs: number
  peakSize: number
  rejectedEvents: number
}

export class StorageWriteQueue {
  readonly #writer: StorageWriter
  readonly #options: Required<
    Pick<
      StorageWriteQueueOptions,
      'maxEvents' | 'maxAgeMs' | 'maxBatchSize' | 'flushAfterMs' | 'now'
    >
  > &
    Pick<StorageWriteQueueOptions, 'onCommitted' | 'onError'>
  #items: QueuedEvent[] = []
  #head = 0
  #timer: NodeJS.Timeout | null = null
  #pumpPromise: Promise<void> | null = null
  #forceDrain = false
  #closed = false
  #fatalError: StorageError | null = null
  #peakSize = 0
  #rejectedEvents = 0
  #nextAcknowledgementId = 1
  readonly #acknowledgements = new Map<number, PendingAcknowledgement>()

  constructor(writer: StorageWriter, options: StorageWriteQueueOptions) {
    this.#writer = writer
    this.#options = {
      ...options,
      maxEvents: options.maxEvents ?? 20_000,
      maxAgeMs: options.maxAgeMs ?? 5_000,
      maxBatchSize: options.maxBatchSize ?? 500,
      flushAfterMs: options.flushAfterMs ?? 100,
      now: options.now ?? Date.now,
    }
  }

  enqueue(sessionId: number, events: readonly DomainEvent[]): void {
    this.#enqueue(sessionId, events, null)
  }

  enqueueAndWait(sessionId: number, events: readonly DomainEvent[]): Promise<void> {
    if (events.length === 0) return Promise.resolve()
    const acknowledgementId = this.#nextAcknowledgementId
    this.#nextAcknowledgementId += 1
    return new Promise((resolve, reject) => {
      this.#acknowledgements.set(acknowledgementId, {
        remaining: events.length,
        resolve,
        reject,
      })
      try {
        this.#enqueue(sessionId, events, acknowledgementId)
      } catch (error) {
        this.#acknowledgements.delete(acknowledgementId)
        reject(toStorageError(error, 'STORAGE_WRITE_FAILED'))
      }
    })
  }

  #enqueue(
    sessionId: number,
    events: readonly DomainEvent[],
    acknowledgementId: number | null,
  ): void {
    if (this.#closed) throw new StorageError('STORAGE_CLOSED')
    if (this.#fatalError !== null) throw this.#fatalError
    if (events.length === 0) return

    const now = this.#options.now()
    const oldest = this.#items[this.#head]
    if (oldest !== undefined && now - oldest.enqueuedAtMs >= this.#options.maxAgeMs) {
      this.#rejectedEvents += events.length
      throw this.#fail(new StorageError('STORAGE_QUEUE_EXPIRED'))
    }
    if (this.size + events.length > this.#options.maxEvents) {
      this.#rejectedEvents += events.length
      throw this.#fail(new StorageError('STORAGE_QUEUE_LIMIT'))
    }

    for (const event of events) {
      this.#items.push({ sessionId, event, enqueuedAtMs: now, acknowledgementId })
    }
    this.#peakSize = Math.max(this.#peakSize, this.size)
    if (this.size >= this.#options.maxBatchSize) this.#requestPump(false)
    else this.#armTimer()
  }

  get size(): number {
    return this.#items.length - this.#head
  }

  metrics(): StorageWriteQueueMetrics {
    const oldest = this.#items[this.#head]
    return {
      size: this.size,
      oldestAgeMs:
        oldest === undefined ? 0 : Math.max(0, this.#options.now() - oldest.enqueuedAtMs),
      peakSize: this.#peakSize,
      rejectedEvents: this.#rejectedEvents,
    }
  }

  async flush(): Promise<void> {
    if (this.#fatalError !== null) throw this.#fatalError
    if (this.size === 0 && this.#pumpPromise === null) return
    this.#forceDrain = true
    this.#clearTimer()
    this.#requestPump(true)
    await this.#waitUntilIdle()
  }

  async shutdown(): Promise<void> {
    if (this.#closed) return
    await this.flush()
    this.#closed = true
    await this.#writer.shutdown?.()
  }

  #requestPump(force: boolean): void {
    if (force) this.#forceDrain = true
    if (this.#pumpPromise !== null || this.#fatalError !== null) return
    this.#clearTimer()
    this.#pumpPromise = this.#pump().finally(() => {
      this.#pumpPromise = null
      if (this.#fatalError !== null || this.size === 0) return
      if (this.#forceDrain || this.size >= this.#options.maxBatchSize) this.#requestPump(false)
      else this.#armTimer()
    })
  }

  async #pump(): Promise<void> {
    while (this.size > 0) {
      if (!this.#forceDrain && this.size < this.#options.maxBatchSize) return
      const first = this.#items[this.#head]
      if (first === undefined) return
      const batch: DomainEvent[] = []
      let count = 0
      while (count < this.#options.maxBatchSize) {
        const item = this.#items[this.#head + count]
        if (item === undefined || item.sessionId !== first.sessionId) break
        batch.push(item.event)
        count += 1
      }

      try {
        const committed = await this.#writer.appendBatch(first.sessionId, batch)
        const committedItems = this.#items.slice(this.#head, this.#head + count)
        this.#head += count
        this.#compact()
        this.#options.onCommitted(committed)
        this.#acknowledge(committedItems)
      } catch (error) {
        throw this.#fail(toStorageError(error, 'STORAGE_WRITE_FAILED'))
      }
    }
    this.#forceDrain = false
  }

  async #waitUntilIdle(): Promise<void> {
    while (this.#pumpPromise !== null) {
      await this.#pumpPromise
      if (this.#fatalError !== null) throw this.#fatalError
      if (this.size > 0) {
        this.#requestPump(true)
      }
    }
    if (this.#fatalError !== null) throw this.#fatalError
  }

  #armTimer(): void {
    if (this.#timer !== null || this.size === 0 || this.#fatalError !== null) return
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.#requestPump(true)
    }, this.#options.flushAfterMs)
  }

  #clearTimer(): void {
    if (this.#timer !== null) clearTimeout(this.#timer)
    this.#timer = null
  }

  #compact(): void {
    if (this.#head === this.#items.length) {
      this.#items = []
      this.#head = 0
    } else if (this.#head >= 4_096) {
      this.#items = this.#items.slice(this.#head)
      this.#head = 0
    }
  }

  #fail(error: StorageError): StorageError {
    if (this.#fatalError === null) {
      this.#fatalError = error
      this.#clearTimer()
      this.#options.onError?.(error)
      for (const acknowledgement of this.#acknowledgements.values()) {
        acknowledgement.reject(error)
      }
      this.#acknowledgements.clear()
    }
    return this.#fatalError
  }

  #acknowledge(items: readonly QueuedEvent[]): void {
    const counts = new Map<number, number>()
    for (const item of items) {
      if (item.acknowledgementId === null) continue
      counts.set(item.acknowledgementId, (counts.get(item.acknowledgementId) ?? 0) + 1)
    }
    for (const [id, count] of counts) {
      const acknowledgement = this.#acknowledgements.get(id)
      if (acknowledgement === undefined) continue
      acknowledgement.remaining -= count
      if (acknowledgement.remaining > 0) continue
      this.#acknowledgements.delete(id)
      acknowledgement.resolve()
    }
  }
}
