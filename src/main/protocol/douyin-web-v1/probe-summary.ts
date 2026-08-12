const KNOWN_MESSAGE_METHODS = [
  'WebcastChatMessage',
  'WebcastControlMessage',
  'WebcastGiftMessage',
  'WebcastLikeMessage',
  'WebcastMemberMessage',
  'WebcastRoomStatsMessage',
  'WebcastRoomUserSeqMessage',
  'WebcastSocialMessage',
] as const

const knownMessageMethods = new Set<string>(KNOWN_MESSAGE_METHODS)
const knownDecodeErrors = new Set([
  'FRAME_TOO_LARGE',
  'INFLATED_PAYLOAD_TOO_LARGE',
  'MALFORMED_PROTOBUF',
  'MISSING_PAYLOAD',
  'TOO_MANY_MESSAGES',
  'UNSUPPORTED_COMPRESSION',
  'UNSUPPORTED_PAYLOAD_TYPE',
])

export interface DouyinProbeEvidence {
  homePageReached: boolean
  roomPageReached: boolean
  websocketOpened: number
  websocketClosed: number
  receivedFrames: number
  sentFrames: number
  sentAckFrames: number
  sentHeartbeatFrames: number
  sentUnknownFrames: number
  decodedFrames: number
  gzipFrames: number
  plainFrames: number
  ackRequiredFrames: number
  decodedChatPayloads: number
  methodCounts: Record<string, number>
  decodeErrorCounts: Record<string, number>
  durationMs: number
}

export interface DouyinProbeSummary {
  schemaVersion: 1
  status: 'ok'
  checks: {
    homePageReached: boolean
    roomPageReached: boolean
    websocketOpened: number
    websocketClosed: number
  }
  frames: {
    received: number
    sent: number
    outbound: {
      ack: number
      heartbeat: number
      unknown: number
    }
    decoded: number
    failed: number
    compression: {
      gzip: number
      none: number
    }
    ackRequired: number
  }
  messages: Record<string, number>
  decodedChatPayloads: number
  decodeErrors: Record<string, number>
  durationMs: number
}

function safeCount(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

export function createDouyinProbeSummary(evidence: DouyinProbeEvidence): DouyinProbeSummary {
  const received = safeCount(evidence.receivedFrames)
  const decoded = Math.min(received, safeCount(evidence.decodedFrames))
  const messages: Record<string, number> = {}
  let unknown = 0
  const decodeErrors: Record<string, number> = {}
  let unknownDecodeErrors = 0

  for (const [method, rawCount] of Object.entries(evidence.methodCounts)) {
    const count = safeCount(rawCount)
    if (count === 0) {
      continue
    }

    if (knownMessageMethods.has(method)) {
      messages[method] = (messages[method] ?? 0) + count
    } else {
      unknown += count
    }
  }

  if (unknown > 0) {
    messages.unknown = unknown
  }

  for (const [code, rawCount] of Object.entries(evidence.decodeErrorCounts)) {
    const count = safeCount(rawCount)
    if (count === 0) {
      continue
    }

    if (knownDecodeErrors.has(code)) {
      decodeErrors[code] = (decodeErrors[code] ?? 0) + count
    } else {
      unknownDecodeErrors += count
    }
  }

  if (unknownDecodeErrors > 0) {
    decodeErrors.unknown = unknownDecodeErrors
  }

  return {
    schemaVersion: 1,
    status: 'ok',
    checks: {
      homePageReached: evidence.homePageReached,
      roomPageReached: evidence.roomPageReached,
      websocketOpened: safeCount(evidence.websocketOpened),
      websocketClosed: safeCount(evidence.websocketClosed),
    },
    frames: {
      received,
      sent: safeCount(evidence.sentFrames),
      outbound: {
        ack: safeCount(evidence.sentAckFrames),
        heartbeat: safeCount(evidence.sentHeartbeatFrames),
        unknown: safeCount(evidence.sentUnknownFrames),
      },
      decoded,
      failed: received - decoded,
      compression: {
        gzip: safeCount(evidence.gzipFrames),
        none: safeCount(evidence.plainFrames),
      },
      ackRequired: safeCount(evidence.ackRequiredFrames),
    },
    messages,
    decodedChatPayloads: safeCount(evidence.decodedChatPayloads),
    decodeErrors,
    durationMs: safeCount(evidence.durationMs),
  }
}
