import { once } from 'node:events'
import { backup, DatabaseSync } from 'node:sqlite'
import { parentPort, workerData } from 'node:worker_threads'

import { LocalStore } from '../storage/local-store'
import type { WriterRuntimeProbeRequest, WriterRuntimeProbeResult } from './runtime-probe-contract'
import { parseStorageWriterCommand, type StorageWriterResponse } from './storage-writer-protocol'

async function runProbe(
  request: WriterRuntimeProbeRequest,
): Promise<{ database: DatabaseSync; result: WriterRuntimeProbeResult }> {
  const database = new DatabaseSync(request.databasePath)

  try {
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    const foreignKeysRow = database.prepare('PRAGMA foreign_keys').get() as
      { foreign_keys?: number } | undefined
    const busyTimeoutRow = database.prepare('PRAGMA busy_timeout').get() as
      { timeout?: number } | undefined
    const journalRow = database.prepare('PRAGMA journal_mode = WAL').get() as
      { journal_mode?: string } | undefined

    database.exec(`
      CREATE TABLE probe_messages (
        id INTEGER PRIMARY KEY,
        body TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE probe_messages_fts USING fts5(body, tokenize='trigram');
      INSERT INTO probe_messages(id, body) VALUES (1, '合成弹幕测试');
      INSERT INTO probe_messages_fts(rowid, body) VALUES (1, '合成弹幕测试');
    `)

    const match = database
      .prepare("SELECT rowid FROM probe_messages_fts WHERE body MATCH '弹幕测试'")
      .get()
    database.exec('DELETE FROM probe_messages_fts;')
    const deleted = database.prepare('SELECT count(*) AS count FROM probe_messages_fts').get() as
      { count?: number } | undefined

    await backup(database, request.backupPath)
    const backupDatabase = new DatabaseSync(request.backupPath, { readOnly: true })
    let quickCheck: { quick_check?: string } | undefined
    try {
      quickCheck = backupDatabase.prepare('PRAGMA quick_check').get() as
        { quick_check?: string } | undefined
    } finally {
      backupDatabase.close()
    }

    const result = {
      role: 'writer' as const,
      ok: Boolean(match),
      fts5Trigram: Boolean(match) && deleted?.count === 0,
      wal: journalRow?.journal_mode?.toLowerCase() === 'wal',
      foreignKeys: foreignKeysRow?.foreign_keys === 1,
      busyTimeout: busyTimeoutRow?.timeout === 5000,
      backup: quickCheck?.quick_check === 'ok',
    }

    result.ok = result.ok && result.foreignKeys && result.busyTimeout
    return { database, result }
  } catch (error) {
    database.close()
    throw error
  }
}

interface StorageWriterData {
  kind: 'storage-writer'
  databasePath: string
}

async function runRuntimeProbe(request: WriterRuntimeProbeRequest): Promise<void> {
  if (parentPort === null) return

  let database: DatabaseSync | undefined
  try {
    const probe = await runProbe(request)
    database = probe.database
    parentPort.postMessage(probe.result)
    await once(parentPort, 'message')
  } catch {
    parentPort.postMessage({
      role: 'writer',
      ok: false,
      fts5Trigram: false,
      wal: false,
      foreignKeys: false,
      busyTimeout: false,
      backup: false,
    } satisfies WriterRuntimeProbeResult)
  } finally {
    database?.close()
  }
}

function runStorageWriter(data: StorageWriterData): void {
  if (parentPort === null) return
  const port = parentPort
  const store = new LocalStore(data.databasePath)
  let closed = false
  let chain = Promise.resolve()

  const respond = (response: StorageWriterResponse): void => port.postMessage(response)
  const processCommand = (input: unknown): void => {
    let command
    try {
      command = parseStorageWriterCommand(input)
    } catch {
      const id =
        typeof input === 'object' &&
        input !== null &&
        Number.isSafeInteger(Reflect.get(input, 'id'))
          ? Number(Reflect.get(input, 'id'))
          : 0
      respond({
        kind: 'storage-response',
        id,
        ok: false,
        errorCode: 'STORAGE_PROTOCOL_ERROR',
      })
      return
    }

    try {
      let result: unknown = null
      if (command.command === 'initialize') {
        store.initialize()
      } else if (command.command === 'createSession') {
        result = store.createSession(command.payload)
      } else if (command.command === 'appendBatch') {
        result = store.appendEvents(command.payload.sessionId, command.payload.events)
      } else if (command.command === 'finalizeSession') {
        result = store.finalizeSession(
          command.payload.sessionId,
          command.payload.reason,
          command.payload.endedAtMs,
        )
      } else if (command.command === 'openGap') {
        result = store.openGap(
          command.payload.sessionId,
          command.payload.reason,
          command.payload.startedAtMs,
        )
      } else if (command.command === 'closeGap') {
        result = store.closeGap(
          command.payload.sessionId,
          command.payload.endedAtMs,
          command.payload.recovered,
        )
      } else if (command.command === 'prepareDeletion') {
        result = store.prepareDeletion(command.payload.sessionId, command.payload.deletedAtMs)
      } else if (command.command === 'confirmDeletion') {
        result = store.confirmDeletion(command.payload.sessionId, command.payload.batchSize)
      } else {
        store.close()
        closed = true
      }
      respond({ kind: 'storage-response', id: command.id, ok: true, result })
      if (closed) port.close()
    } catch {
      respond({
        kind: 'storage-response',
        id: command.id,
        ok: false,
        errorCode: 'STORAGE_COMMAND_FAILED',
      })
    }
  }

  port.on('message', (input) => {
    if (closed) return
    chain = chain.then(() => processCommand(input))
  })
  process.once('exit', () => store.close())
}

async function main(): Promise<void> {
  if (parentPort === null || typeof workerData !== 'object' || workerData === null) return
  const data = workerData as WriterRuntimeProbeRequest | StorageWriterData
  if (data.kind === 'runtime-probe') {
    await runRuntimeProbe(data)
    return
  }
  if (data.kind === 'storage-writer' && typeof data.databasePath === 'string') {
    runStorageWriter(data)
  }
}

void main()
