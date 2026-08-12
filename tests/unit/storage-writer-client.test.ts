import { EventEmitter } from 'node:events'

import { describe, expect, it } from 'vitest'

import type { DanmakuEvent } from '../../src/domain/events'
import {
  StorageWriterClient,
  type StorageWorkerPort,
} from '../../src/main/storage/storage-writer-client'

class FakeWorker extends EventEmitter implements StorageWorkerPort {
  readonly commands: unknown[] = []
  deletionPass = 0

  postMessage(command: unknown): void {
    this.commands.push(command)
    const request = command as { id: number; command: string; payload?: unknown }
    queueMicrotask(() => {
      if (request.command === 'appendBatch') {
        const payload = request.payload as { sessionId: number; events: DanmakuEvent[] }
        this.emit('message', {
          kind: 'storage-response',
          id: request.id,
          ok: true,
          result: {
            sessionId: payload.sessionId,
            activeUserCount: 0,
            insertedCounts: { danmaku: 1, gift: 0, superChat: 0, popularity: 0 },
            highWatermark: { receivedAtMs: payload.events[0]?.receivedAtMs, eventId: 9 },
            committedEvents: payload.events.slice(0, 1),
          },
        })
        return
      }
      if (request.command === 'prepareDeletion') {
        this.emit('message', {
          kind: 'storage-response',
          id: request.id,
          ok: true,
          result: { sessionId: 7, accepted: true },
        })
        return
      }
      if (request.command === 'confirmDeletion') {
        this.deletionPass += 1
        this.emit('message', {
          kind: 'storage-response',
          id: request.id,
          ok: true,
          result: {
            sessionId: 7,
            done: this.deletionPass === 2,
            deletedRows: this.deletionPass === 1 ? 5_000 : 0,
          },
        })
        return
      }
      this.emit('message', {
        kind: 'storage-response',
        id: request.id,
        ok: true,
        result: null,
      })
    })
  }

  async terminate(): Promise<number> {
    return 0
  }
}

const event: DanmakuEvent = {
  type: 'danmaku',
  sessionId: 1,
  sourceEventKey: Uint8Array.from({ length: 16 }, (_, index) => index),
  receivedAtMs: 1_780_000_000_000,
  sentAtMs: null,
  localUserKey: null,
  displayName: '观众',
  text: '弹幕',
  medalName: null,
  medalLevel: null,
}

describe('StorageWriterClient', () => {
  it('删除会话先逻辑标记，再通过多个有界worker命令清理', async () => {
    const worker = new FakeWorker()
    const client = new StorageWriterClient('/bundle/writer.js', '/data/library.sqlite3', {
      workerFactory: () => worker,
    })

    await client.deleteSession(7, 1_780_000_000_000)

    expect(worker.commands).toMatchObject([
      { command: 'prepareDeletion', payload: { sessionId: 7, deletedAtMs: 1_780_000_000_000 } },
      { command: 'confirmDeletion', payload: { sessionId: 7, batchSize: 5_000 } },
      { command: 'confirmDeletion', payload: { sessionId: 7, batchSize: 5_000 } },
    ])
    await client.shutdown()
  })

  it('数据库路径只在worker启动配置中传入，写入命令只携带规范化事件', async () => {
    const worker = new FakeWorker()
    let workerData: unknown
    const client = new StorageWriterClient('/bundle/writer.js', '/data/library.sqlite3', {
      workerFactory: (_filename, options) => {
        workerData = options.workerData
        return worker
      },
      requestTimeoutMs: 1_000,
    })

    await client.initialize()
    const result = await client.appendBatch(1, [event, event])

    expect(workerData).toEqual({ kind: 'storage-writer', databasePath: '/data/library.sqlite3' })
    expect(worker.commands).toHaveLength(2)
    expect(worker.commands[1]).not.toHaveProperty('databasePath')
    expect(result.committedEvents).toEqual([event])
    await client.shutdown()
  })
})
