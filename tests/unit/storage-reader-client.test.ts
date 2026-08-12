import { EventEmitter } from 'node:events'

import { describe, expect, it } from 'vitest'

import {
  StorageReaderClient,
  type StorageReaderWorkerPort,
} from '../../src/main/storage/storage-reader-client'

class FakeReaderWorker extends EventEmitter implements StorageReaderWorkerPort {
  readonly commands: unknown[] = []

  postMessage(command: unknown): void {
    this.commands.push(command)
    const request = command as { id: number; query: string }
    queueMicrotask(() => {
      this.emit('message', {
        kind: 'reader-response',
        id: request.id,
        ok: true,
        result:
          request.query === 'listDanmaku'
            ? [
                {
                  id: 8,
                  sessionId: 3,
                  receivedAtMs: 1_780_000_000_000,
                  sentAtMs: null,
                  displayName: '观众',
                  text: '合成弹幕',
                  medalName: null,
                  medalLevel: null,
                },
              ]
            : request.query === 'getSessionReview'
              ? {
                  sessionId: 3,
                  startedAtMs: 1_780_000_000_000,
                  endedAtMs: 1_780_000_600_000,
                  bucketMinutes: 5,
                  totals: {
                    danmakuCount: 2,
                    activeUserCount: 1,
                    giftCount: 0,
                    superChatCount: 0,
                    gapCount: 0,
                    gapDurationMs: 0,
                  },
                  buckets: [
                    {
                      bucketStartMs: 1_780_000_000_000,
                      bucketEndMs: 1_780_000_300_000,
                      danmakuCount: 2,
                      activeSpeakerCount: 1,
                      giftCount: 0,
                      superChatCount: 0,
                      popularityPeak: null,
                      hasGap: false,
                    },
                  ],
                  repeatedDanmaku: [],
                  mostRepeatedDanmaku: null,
                  peakDanmakuBucket: null,
                  peakActiveSpeakerBucket: null,
                  topThreeDanmakuShare: 0,
                }
              : null,
      })
    })
  }

  async terminate(): Promise<number> {
    return 0
  }
}

describe('StorageReaderClient', () => {
  it('只向读worker发送固定查询名和键集分页参数', async () => {
    const worker = new FakeReaderWorker()
    let workerData: unknown
    const client = new StorageReaderClient('/bundle/reader.js', '/data/library.sqlite3', {
      workerFactory: (_filename, options) => {
        workerData = options.workerData
        return worker
      },
    })

    const rows = await client.listDanmaku(3, {
      limit: 50,
      before: { receivedAtMs: 1_780_000_000_500, id: 9 },
    })

    expect(workerData).toEqual({ kind: 'storage-reader', databasePath: '/data/library.sqlite3' })
    expect(worker.commands[0]).toEqual({
      kind: 'reader-query',
      id: 1,
      query: 'listDanmaku',
      payload: {
        sessionId: 3,
        options: { limit: 50, before: { receivedAtMs: 1_780_000_000_500, id: 9 } },
      },
    })
    expect(rows).toMatchObject([{ id: 8, text: '合成弹幕' }])
    expect(await client.getSessionReview(3)).toMatchObject({ sessionId: 3, bucketMinutes: 5 })
    expect(worker.commands[1]).toMatchObject({
      query: 'getSessionReview',
      payload: { sessionId: 3 },
    })
    await client.shutdown()
  })
})
