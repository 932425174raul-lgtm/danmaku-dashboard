import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

import type { DanmakuEvent } from '../../domain/events'
import type { BenchmarkProfile } from '../environment'
import { getWorkerPath } from '../paths'
import { StorageWriterClient } from '../storage/storage-writer-client'

const PROFILE_EVENT_COUNTS: Record<BenchmarkProfile, number> = {
  smoke: 20_000,
  million: 1_000_000,
  sustained: 12_000,
  soak: 100_000,
}

export async function runPackagedBenchmark(
  profile: BenchmarkProfile,
  bundleDirectory: string,
  userDataPath: string,
): Promise<number> {
  const writer = new StorageWriterClient(
    getWorkerPath(bundleDirectory, 'writer'),
    join(userDataPath, 'benchmark.sqlite3'),
    { requestTimeoutMs: 120_000 },
  )
  try {
    await writer.initialize()
    const session = await writer.createSession({
      platform: 'bilibili',
      roomId: '10000',
      roomTitle: '合成容量测试',
      adapterVersion: 'synthetic-v1',
      startedAtMs: 1_700_000_000_000,
    })
    const eventCount = PROFILE_EVENT_COUNTS[profile]
    const startedAt = performance.now()
    let committed = 0
    for (let offset = 0; offset < eventCount; offset += 500) {
      const events: DanmakuEvent[] = Array.from(
        { length: Math.min(500, eventCount - offset) },
        (_, index) => ({
          type: 'danmaku',
          sessionId: session.id,
          sourceEventKey: null,
          receivedAtMs: 1_700_000_000_000 + offset + index,
          sentAtMs: null,
          localUserKey: null,
          displayName: '合成用户',
          text: `合成弹幕${offset + index}`,
          medalName: null,
          medalLevel: null,
        }),
      )
      committed += (await writer.appendBatch(session.id, events)).insertedCounts.danmaku
    }
    const elapsedMs = performance.now() - startedAt
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, status: 'ok', profile, committed, elapsedMs, eventsPerSecond: Math.round((committed * 1_000) / elapsedMs) })}\n`,
    )
    return committed === eventCount ? 0 : 1
  } catch {
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, status: 'error', code: 'BENCHMARK_FAILED' })}\n`,
    )
    return 1
  } finally {
    await writer.shutdown().catch(() => undefined)
  }
}
