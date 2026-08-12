import type { DomainEvent } from '../../domain/events'
import type { CommittedEvents } from './local-store'

export interface StorageWriter {
  appendBatch(sessionId: number, events: readonly DomainEvent[]): Promise<CommittedEvents>
  shutdown?(): Promise<void>
}

export type StorageErrorCode =
  | 'STORAGE_QUEUE_LIMIT'
  | 'STORAGE_QUEUE_EXPIRED'
  | 'STORAGE_WRITE_FAILED'
  | 'STORAGE_WORKER_EXITED'
  | 'STORAGE_WORKER_TIMEOUT'
  | 'STORAGE_PROTOCOL_ERROR'
  | 'STORAGE_CLOSED'

export class StorageError extends Error {
  readonly code: StorageErrorCode

  constructor(code: StorageErrorCode, options?: ErrorOptions) {
    super(code, options)
    this.name = 'StorageError'
    this.code = code
  }
}

export function toStorageError(error: unknown, fallback: StorageErrorCode): StorageError {
  return error instanceof StorageError ? error : new StorageError(fallback, { cause: error })
}
