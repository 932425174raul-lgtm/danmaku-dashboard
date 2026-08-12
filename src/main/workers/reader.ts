import { DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'

import { LocalStore } from '../storage/local-store'
import type { ReaderRuntimeProbeRequest, ReaderRuntimeProbeResult } from './runtime-probe-contract'
import { parseStorageReaderQuery, type StorageReaderResponse } from './storage-reader-protocol'

function runProbe(request: ReaderRuntimeProbeRequest): ReaderRuntimeProbeResult {
  const database = new DatabaseSync(request.databasePath, { readOnly: true })

  try {
    const row = database.prepare('SELECT body FROM probe_messages WHERE id = 1').get() as
      { body?: string } | undefined
    return {
      role: 'reader',
      ok: row?.body === '合成弹幕测试',
    }
  } finally {
    database.close()
  }
}

interface StorageReaderData {
  kind: 'storage-reader'
  databasePath: string
}

function runStorageReader(data: StorageReaderData): void {
  if (parentPort === null) return
  const port = parentPort
  const store = new LocalStore(data.databasePath, { readOnly: true })
  try {
    store.initialize()
  } catch {
    port.close()
    return
  }

  port.on('message', (input) => {
    let request
    try {
      request = parseStorageReaderQuery(input)
    } catch {
      const id =
        typeof input === 'object' &&
        input !== null &&
        Number.isSafeInteger(Reflect.get(input, 'id'))
          ? Number(Reflect.get(input, 'id'))
          : 0
      port.postMessage({
        kind: 'reader-response',
        id,
        ok: false,
        errorCode: 'READER_PROTOCOL_ERROR',
      } satisfies StorageReaderResponse)
      return
    }

    try {
      let result: unknown = null
      if (request.query === 'listSessions') {
        result = store.listSessions(request.payload.limit)
      } else if (request.query === 'getSessionReview') {
        result = store.getSessionReview(request.payload.sessionId)
      } else if (request.query === 'listDanmaku') {
        result = store.listDanmaku(request.payload.sessionId, request.payload.options)
      } else if (request.query === 'searchDanmaku') {
        result = store.searchDanmaku(
          request.payload.sessionId,
          request.payload.query,
          request.payload.options,
        )
      } else {
        store.close()
      }
      port.postMessage({
        kind: 'reader-response',
        id: request.id,
        ok: true,
        result,
      } satisfies StorageReaderResponse)
      if (request.query === 'shutdown') port.close()
    } catch {
      port.postMessage({
        kind: 'reader-response',
        id: request.id,
        ok: false,
        errorCode: 'READ_UNAVAILABLE',
      } satisfies StorageReaderResponse)
    }
  })
  process.once('exit', () => store.close())
}

function main(): void {
  if (parentPort === null || typeof workerData !== 'object' || workerData === null) return
  const data = workerData as ReaderRuntimeProbeRequest | StorageReaderData
  if (data.kind === 'runtime-probe') {
    try {
      parentPort.postMessage(runProbe(data))
    } catch {
      parentPort.postMessage({ role: 'reader', ok: false } satisfies ReaderRuntimeProbeResult)
    }
    return
  }
  if (data.kind === 'storage-reader' && typeof data.databasePath === 'string') {
    runStorageReader(data)
  }
}

main()
