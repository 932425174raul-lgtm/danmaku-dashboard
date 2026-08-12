import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'

import type { SafeStorage } from 'electron'

import type { RuntimeProbeWorkerResult } from '../workers/runtime-probe-contract'
import {
  createRuntimeSummary,
  type RuntimeProbeEvidence,
  type RuntimeSummary,
} from './runtime-summary'

interface RunningWorker {
  worker: Worker
  result: RuntimeProbeWorkerResult
  waitForExit(): Promise<void>
}

async function startWorker(workerPath: string, workerData: object): Promise<RunningWorker> {
  const worker = new Worker(workerPath, { workerData })
  const messagePromise = new Promise<unknown>((resolve, reject) => {
    worker.once('message', resolve)
    worker.once('error', reject)
  })
  const exitPromise = once(worker, 'exit')

  try {
    const message = await messagePromise
    return {
      worker,
      result: message as RuntimeProbeWorkerResult,
      waitForExit: async () => {
        const [exitCode] = await exitPromise
        if (exitCode !== 0) {
          throw new Error('WORKER_PROBE_FAILED')
        }
      },
    }
  } catch (error) {
    await worker.terminate()
    throw error
  }
}

async function runWorker(
  workerPath: string,
  workerData: object,
): Promise<RuntimeProbeWorkerResult> {
  const running = await startWorker(workerPath, workerData)
  try {
    await running.waitForExit()
    return running.result
  } finally {
    await running.worker.terminate()
  }
}

function probeMainSqlite(): boolean {
  const database = new DatabaseSync(':memory:')
  try {
    const row = database.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined
    return row?.quick_check === 'ok'
  } finally {
    database.close()
  }
}

function probeSafeStorage(safeStorage: SafeStorage): boolean {
  return (
    typeof safeStorage.isEncryptionAvailable === 'function' &&
    typeof safeStorage.encryptStringAsync === 'function' &&
    typeof safeStorage.decryptStringAsync === 'function'
  )
}

export async function runRuntimeProbe(
  safeStorage: SafeStorage,
  workerPaths: { writer: string; reader: string },
): Promise<RuntimeSummary> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'danmaku-dashboard-runtime-'))
  const databasePath = join(temporaryRoot, 'runtime.sqlite3')
  const backupPath = join(temporaryRoot, 'runtime.backup.sqlite3')

  try {
    const writer = await startWorker(workerPaths.writer, {
      kind: 'runtime-probe',
      databasePath,
      backupPath,
    })
    let readerResult: RuntimeProbeWorkerResult
    try {
      readerResult = await runWorker(workerPaths.reader, {
        kind: 'runtime-probe',
        databasePath,
      })
      writer.worker.postMessage({ kind: 'close' })
      await writer.waitForExit()
    } finally {
      await writer.worker.terminate()
    }
    const writerResult = writer.result

    const evidence: RuntimeProbeEvidence = {
      mainSqlite: probeMainSqlite(),
      writerSqlite: writerResult.role === 'writer' && writerResult.ok,
      readerSqlite: readerResult.role === 'reader' && readerResult.ok,
      fts5Trigram: writerResult.role === 'writer' && writerResult.fts5Trigram,
      wal: writerResult.role === 'writer' && writerResult.wal,
      foreignKeys: writerResult.role === 'writer' && writerResult.foreignKeys,
      busyTimeout: writerResult.role === 'writer' && writerResult.busyTimeout,
      backup: writerResult.role === 'writer' && writerResult.backup,
      safeStorage: probeSafeStorage(safeStorage),
    }

    return createRuntimeSummary(evidence, {
      electron: process.versions.electron ?? 'unknown',
      node: process.versions.node,
    })
  } catch {
    return { schemaVersion: 1, status: 'error', code: 'RUNTIME_PROBE_FAILED' }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}
