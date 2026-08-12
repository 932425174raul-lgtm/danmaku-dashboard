import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

import type { DanmakuEvent } from '../src/domain/events'
import { LocalStore } from '../src/main/storage/local-store'

const profile = process.argv.find((argument) => argument.startsWith('--profile='))?.slice(10)
const eventCount = profile === 'million' ? 1_000_000 : profile === 'smoke' ? 20_000 : 0
if (eventCount === 0) throw new Error('INVALID_BENCHMARK_PROFILE')

const directory = mkdtempSync(join(tmpdir(), 'danmaku-dashboard-benchmark-'))
const store = new LocalStore(join(directory, 'benchmark.sqlite3'))

try {
  store.initialize()
  const session = store.createSession({
    platform: 'bilibili',
    roomId: '10000',
    roomTitle: '合成容量测试',
    adapterVersion: 'synthetic-v1',
    startedAtMs: 1_700_000_000_000,
  })
  const startedAt = performance.now()
  let committed = 0
  for (let offset = 0; offset < eventCount; offset += 500) {
    const batch: DanmakuEvent[] = Array.from(
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
    committed += store.appendEvents(session.id, batch).insertedCounts.danmaku
  }
  const elapsedMs = performance.now() - startedAt
  process.stdout.write(
    `${JSON.stringify({ status: 'ok', profile, committed, elapsedMs, eventsPerSecond: Math.round((committed * 1000) / elapsedMs) })}\n`,
  )
} finally {
  store.close()
  rmSync(directory, { recursive: true, force: true })
}
