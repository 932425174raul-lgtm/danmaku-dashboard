import { randomBytes } from 'node:crypto'

import { BilibiliCollector } from '../src/main/collector/bilibili-collector.ts'

const roomInput = process.argv[2]
if (roomInput === undefined || !/^\d{1,20}$/u.test(roomInput)) {
  process.stderr.write(`${JSON.stringify({ status: 'error', code: 'ROOM_ID_REQUIRED' })}\n`)
  process.exit(2)
}

const durationMs = Math.max(
  5_000,
  Math.min(60_000, Number.parseInt(process.env.BILIBILI_PROBE_DURATION_MS ?? '20000', 10)),
)
const evidence = {
  roomResolved: false,
  authenticated: false,
  popularitySamples: 0,
  danmaku: 0,
  gift: 0,
  superChat: 0,
  liveSignals: 0,
  preparingSignals: 0,
  recoveries: 0,
}

const collector = new BilibiliCollector()
let completed = false
let timeout: ReturnType<typeof setTimeout> | null = null
let settle: (() => void) | null = null

const finish = async (code?: string): Promise<void> => {
  if (completed) return
  completed = true
  if (timeout !== null) clearTimeout(timeout)
  await collector.stop()
  if (code !== undefined) {
    process.stderr.write(`${JSON.stringify({ status: 'error', code, evidence })}\n`)
    process.exitCode = 1
    settle?.()
    return
  }
  process.stdout.write(
    `${JSON.stringify({ status: 'ok', adapter: 'bilibili-web-v1', durationMs, evidence })}\n`,
  )
  settle?.()
}

await collector.start(roomInput, {
  onRoomResolved: () => {
    evidence.roomResolved = true
  },
  onWaiting: () => void finish('ROOM_NOT_LIVE'),
  onAuthenticated: async () => {
    evidence.authenticated = true
    timeout = setTimeout(() => void finish(), durationMs)
    return { sessionId: 1, hmacKey: randomBytes(32) }
  },
  onEvents: async (events) => {
    for (const event of events) {
      if (event.type === 'danmaku') evidence.danmaku += 1
      if (event.type === 'gift') evidence.gift += event.quantity
      if (event.type === 'super_chat') evidence.superChat += 1
    }
  },
  onPopularity: async () => {
    evidence.popularitySamples += 1
  },
  onSignal: (signal) => {
    if (signal === 'live') evidence.liveSignals += 1
    else evidence.preparingSignals += 1
  },
  onRecovering: async () => {
    evidence.recoveries += 1
  },
  onError: (code) => void finish(code),
})

await new Promise<void>((resolve) => {
  settle = resolve
  if (completed) resolve()
})
