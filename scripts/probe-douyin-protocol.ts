import { chromium } from '@playwright/test'

import {
  classifyDouyinOutboundFrame,
  decodeDouyinChatFrame,
  decodeDouyinPushFrame,
  DouyinProtocolError,
} from '../src/main/protocol/douyin-web-v1/push-frame.ts'
import {
  createDouyinProbeSummary,
  type DouyinProbeEvidence,
} from '../src/main/protocol/douyin-web-v1/probe-summary.ts'

const HOME_URL = 'https://live.douyin.com/'
const DEFAULT_DURATION_MS = 60_000
const MIN_DURATION_MS = 10_000
const MAX_DURATION_MS = 120_000

type ProbeErrorCode =
  | 'BROWSER_START_FAILED'
  | 'HOME_PAGE_UNAVAILABLE'
  | 'NO_PUBLIC_LIVE_ROOM'
  | 'ROOM_PAGE_UNAVAILABLE'
  | 'NO_WEBSOCKET_CONNECTION'
  | 'NO_DECODABLE_FRAME'
  | 'NO_BUSINESS_MESSAGE'
  | 'NO_ACK_FRAME'
  | 'NO_HEARTBEAT_FRAME'

class ProbeFailure extends Error {
  readonly code: ProbeErrorCode

  constructor(code: ProbeErrorCode) {
    super(code)
    this.name = 'ProbeFailure'
    this.code = code
  }
}

function probeDuration(): number {
  const parsed = Number.parseInt(process.env.DOUYIN_PROBE_DURATION_MS ?? '', 10)
  if (!Number.isSafeInteger(parsed)) {
    return DEFAULT_DURATION_MS
  }
  return Math.min(MAX_DURATION_MS, Math.max(MIN_DURATION_MS, parsed))
}

function emptyEvidence(durationMs: number): DouyinProbeEvidence {
  return {
    homePageReached: false,
    roomPageReached: false,
    websocketOpened: 0,
    websocketClosed: 0,
    receivedFrames: 0,
    sentFrames: 0,
    sentAckFrames: 0,
    sentHeartbeatFrames: 0,
    sentUnknownFrames: 0,
    decodedFrames: 0,
    gzipFrames: 0,
    plainFrames: 0,
    ackRequiredFrames: 0,
    decodedChatPayloads: 0,
    methodCounts: {},
    decodeErrorCounts: {},
    durationMs,
  }
}

function writeError(code: ProbeErrorCode): void {
  process.stderr.write(`${JSON.stringify({ schemaVersion: 1, status: 'error', code })}\n`)
}

async function main(): Promise<void> {
  const durationMs = probeDuration()
  const evidence = emptyEvidence(durationMs)
  let browser

  try {
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      serviceWorkers: 'block',
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    })
    const homePage = await context.newPage()
    const homeResponse = await homePage.goto(HOME_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    })
    evidence.homePageReached = homeResponse?.ok() === true
    if (!evidence.homePageReached) {
      throw new ProbeFailure('HOME_PAGE_UNAVAILABLE')
    }

    await homePage.waitForTimeout(3_000)
    const roomUrl = await homePage.locator('a[href]').evaluateAll((anchors) => {
      for (const anchor of anchors) {
        const href = anchor.getAttribute('href')
        if (href === null) {
          continue
        }

        try {
          const candidate = new URL(href, window.location.href)
          if (
            candidate.origin === window.location.origin &&
            /^\/\d+\/?$/.test(candidate.pathname)
          ) {
            return candidate.href
          }
        } catch {
          continue
        }
      }
      return null
    })
    if (roomUrl === null) {
      throw new ProbeFailure('NO_PUBLIC_LIVE_ROOM')
    }

    const roomPage = await context.newPage()
    roomPage.on('websocket', (socket) => {
      let isLivePushSocket = false
      try {
        isLivePushSocket = new URL(socket.url()).pathname === '/webcast/im/push/v2/'
      } catch {
        return
      }
      if (!isLivePushSocket) {
        return
      }

      evidence.websocketOpened += 1
      socket.on('close', () => {
        evidence.websocketClosed += 1
      })
      socket.on('framesent', (event) => {
        evidence.sentFrames += 1
        if (!Buffer.isBuffer(event.payload)) {
          evidence.sentUnknownFrames += 1
          return
        }

        try {
          const kind = classifyDouyinOutboundFrame(event.payload)
          if (kind === 'ack') {
            evidence.sentAckFrames += 1
          } else if (kind === 'heartbeat') {
            evidence.sentHeartbeatFrames += 1
          } else {
            evidence.sentUnknownFrames += 1
          }
        } catch {
          evidence.sentUnknownFrames += 1
        }
      })
      socket.on('framereceived', (event) => {
        if (!Buffer.isBuffer(event.payload)) {
          return
        }

        evidence.receivedFrames += 1
        try {
          const frame = decodeDouyinPushFrame(event.payload)
          evidence.decodedFrames += 1
          if (frame.compression === 'gzip') {
            evidence.gzipFrames += 1
          } else {
            evidence.plainFrames += 1
          }
          if (frame.needsAck) {
            evidence.ackRequiredFrames += 1
          }
          evidence.decodedChatPayloads += decodeDouyinChatFrame(event.payload).length
          for (const method of frame.messageMethods) {
            evidence.methodCounts[method] = (evidence.methodCounts[method] ?? 0) + 1
          }
        } catch (error) {
          const code = error instanceof DouyinProtocolError ? error.code : 'unknown'
          evidence.decodeErrorCounts[code] = (evidence.decodeErrorCounts[code] ?? 0) + 1
          return
        }
      })
    })

    const roomResponse = await roomPage.goto(roomUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    })
    evidence.roomPageReached = roomResponse?.ok() === true
    if (!evidence.roomPageReached) {
      throw new ProbeFailure('ROOM_PAGE_UNAVAILABLE')
    }

    await roomPage.waitForTimeout(durationMs)
    if (evidence.websocketOpened === 0) {
      throw new ProbeFailure('NO_WEBSOCKET_CONNECTION')
    }
    if (evidence.decodedFrames === 0) {
      throw new ProbeFailure('NO_DECODABLE_FRAME')
    }
    if (!Object.values(evidence.methodCounts).some((count) => count > 0)) {
      throw new ProbeFailure('NO_BUSINESS_MESSAGE')
    }
    if (evidence.sentAckFrames === 0) {
      throw new ProbeFailure('NO_ACK_FRAME')
    }
    if (evidence.sentHeartbeatFrames === 0) {
      throw new ProbeFailure('NO_HEARTBEAT_FRAME')
    }

    process.stdout.write(`${JSON.stringify(createDouyinProbeSummary(evidence))}\n`)
    await context.close()
  } catch (error) {
    const code = error instanceof ProbeFailure ? error.code : 'BROWSER_START_FAILED'
    writeError(code)
    process.exitCode = 1
  } finally {
    await browser?.close()
  }
}

await main()
