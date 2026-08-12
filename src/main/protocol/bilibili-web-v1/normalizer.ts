import { createHmac } from 'node:crypto'

import { z } from 'zod'

import { parseDomainEvent, type DomainEvent } from '../../../domain/events'

const LOCAL_KEY_BYTES = 16
const HMAC_KEY_BYTES = 32
const MILLISECONDS_PER_SECOND = 1_000

const commandEnvelopeSchema = z
  .object({
    cmd: z.string(),
  })
  .passthrough()

const danmakuSchema = z
  .object({
    cmd: z.string(),
    info: z
      .tuple([z.array(z.unknown()), z.string(), z.array(z.unknown()), z.array(z.unknown())])
      .rest(z.unknown()),
  })
  .passthrough()

const giftSchema = z
  .object({
    cmd: z.string(),
    data: z
      .object({
        uid: z.unknown().optional(),
        uname: z.string(),
        giftName: z.string(),
        num: z.number(),
        price: z.number().optional(),
        coin_type: z.string().optional(),
        tid: z.unknown().optional(),
        timestamp: z.number().optional(),
      })
      .passthrough(),
  })
  .passthrough()

const superChatSchema = z
  .object({
    cmd: z.string(),
    data: z
      .object({
        id: z.unknown().optional(),
        uid: z.unknown().optional(),
        user_info: z.object({ uname: z.string() }).passthrough(),
        message: z.string(),
        price: z.number(),
        start_time: z.number().optional(),
        end_time: z.number().optional(),
      })
      .passthrough(),
  })
  .passthrough()

const knownCommands = new Set(['DANMU_MSG', 'SEND_GIFT', 'SUPER_CHAT_MESSAGE', 'LIVE', 'PREPARING'])

type KnownCommand = 'DANMU_MSG' | 'SEND_GIFT' | 'SUPER_CHAT_MESSAGE' | 'LIVE' | 'PREPARING'

export type BilibiliNormalizerResult =
  | { kind: 'event'; event: DomainEvent }
  | { kind: 'signal'; signal: 'live' | 'preparing' }
  | {
      kind: 'ignored'
      reason: 'invalid_message' | 'unsupported_command'
      command: string | null
    }

export interface BilibiliEventNormalizerOptions {
  sessionId: number
  hmacKey: Uint8Array
  now?: () => number
}

function normalizeCommand(value: string): string | null {
  const command = value.split(':', 1)[0] ?? ''
  return /^[A-Z][A-Z0-9_]{0,63}$/u.test(command) ? command : null
}

function asKnownCommand(command: string | null): KnownCommand | null {
  return command !== null && knownCommands.has(command) ? (command as KnownCommand) : null
}

function normalizeSourceIdentifier(value: unknown): string | null {
  if (typeof value === 'string') {
    const normalized = value.trim()
    if (normalized.length === 0 || normalized === '0' || normalized.length > 256) return null
    return normalized
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return String(value)
  }
  return null
}

function cleanUnicodeText(value: string, maximumCodePoints: number): string {
  let cleaned = ''

  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1)
      if (nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) {
        cleaned += value.slice(index, index + 2)
        index += 1
      } else {
        cleaned += '\ufffd'
      }
      continue
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      cleaned += '\ufffd'
      continue
    }
    if ((codeUnit >= 0 && codeUnit <= 0x1f) || (codeUnit >= 0x7f && codeUnit <= 0x9f)) {
      continue
    }
    cleaned += value[index]
  }

  return Array.from(cleaned.trim()).slice(0, maximumCodePoints).join('')
}

function safeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

function nonnegativeSafeInteger(value: unknown): number | null {
  const parsed = safeInteger(value)
  return parsed !== null && parsed >= 0 ? parsed : null
}

function positiveSafeInteger(value: unknown): number | null {
  const parsed = safeInteger(value)
  return parsed !== null && parsed > 0 ? parsed : null
}

function secondsToMilliseconds(value: unknown): number | null {
  const seconds = nonnegativeSafeInteger(value)
  if (seconds === null) return null
  const milliseconds = seconds * MILLISECONDS_PER_SECOND
  return Number.isSafeInteger(milliseconds) ? milliseconds : null
}

function millisecondTimestamp(value: unknown): number | null {
  return nonnegativeSafeInteger(value)
}

function multiplySafe(left: number, right: number): number | null {
  const product = left * right
  return Number.isSafeInteger(product) && product >= 0 ? product : null
}

export class BilibiliEventNormalizer {
  readonly #sessionId: number
  readonly #hmacKey: Buffer
  readonly #now: () => number

  constructor(options: BilibiliEventNormalizerOptions) {
    if (!Number.isSafeInteger(options.sessionId) || options.sessionId <= 0) {
      throw new TypeError('INVALID_SESSION_ID')
    }
    if (options.hmacKey.byteLength !== HMAC_KEY_BYTES) {
      throw new TypeError('INVALID_HMAC_KEY')
    }

    this.#sessionId = options.sessionId
    this.#hmacKey = Buffer.from(options.hmacKey)
    this.#now = options.now ?? Date.now
  }

  normalizeBusinessMessage(input: unknown): BilibiliNormalizerResult {
    try {
      return this.#normalizeBusinessMessage(input)
    } catch {
      return this.#ignored('invalid_message', null)
    }
  }

  #normalizeBusinessMessage(input: unknown): BilibiliNormalizerResult {
    const envelope = commandEnvelopeSchema.safeParse(input)
    if (!envelope.success) return this.#ignored('invalid_message', null)

    const command = normalizeCommand(envelope.data.cmd)
    const knownCommand = asKnownCommand(command)
    if (knownCommand === null) return this.#ignored('unsupported_command', command)

    if (knownCommand === 'LIVE') return { kind: 'signal', signal: 'live' }
    if (knownCommand === 'PREPARING') return { kind: 'signal', signal: 'preparing' }

    const receivedAtMs = nonnegativeSafeInteger(this.#now())
    if (receivedAtMs === null) return this.#ignored('invalid_message', knownCommand)

    if (knownCommand === 'DANMU_MSG') {
      return this.#normalizeDanmaku(input, receivedAtMs)
    }
    if (knownCommand === 'SEND_GIFT') {
      return this.#normalizeGift(input, receivedAtMs)
    }
    return this.#normalizeSuperChat(input, receivedAtMs)
  }

  #normalizeDanmaku(input: unknown, receivedAtMs: number): BilibiliNormalizerResult {
    const parsed = danmakuSchema.safeParse(input)
    if (!parsed.success) return this.#ignored('invalid_message', 'DANMU_MSG')

    const [metadata, message, user, medal] = parsed.data.info
    const sourceUserId = normalizeSourceIdentifier(user[0])
    const sourceEventId = normalizeSourceIdentifier(metadata[5])
    const medalLevel = nonnegativeSafeInteger(medal[0])
    const medalName = typeof medal[1] === 'string' ? cleanUnicodeText(medal[1], 64) : null

    return this.#event({
      type: 'danmaku',
      sessionId: this.#sessionId,
      sourceEventKey: this.#makeKey('danmaku', sourceEventId),
      receivedAtMs,
      sentAtMs: millisecondTimestamp(metadata[4]),
      localUserKey: this.#makeKey('bilibili:user', sourceUserId),
      displayName: cleanUnicodeText(typeof user[1] === 'string' ? user[1] : '', 128),
      text: cleanUnicodeText(message, 2_000),
      medalName,
      medalLevel: medalLevel === null || medalName === null ? null : medalLevel,
    })
  }

  #normalizeGift(input: unknown, receivedAtMs: number): BilibiliNormalizerResult {
    const parsed = giftSchema.safeParse(input)
    if (!parsed.success) return this.#ignored('invalid_message', 'SEND_GIFT')

    const { data } = parsed.data
    const quantity = positiveSafeInteger(data.num)
    if (quantity === null) return this.#ignored('invalid_message', 'SEND_GIFT')

    const sourceUserId = normalizeSourceIdentifier(data.uid)
    const sourceEventId = normalizeSourceIdentifier(data.tid)
    const price = nonnegativeSafeInteger(data.price)
    const hasKnownValue = data.coin_type === 'gold' && price !== null
    const unitValueMilliCny = hasKnownValue ? price : null
    const totalValueMilliCny =
      unitValueMilliCny === null ? null : multiplySafe(unitValueMilliCny, quantity)

    return this.#event({
      type: 'gift',
      sessionId: this.#sessionId,
      sourceEventKey: this.#makeKey('gift', sourceEventId),
      receivedAtMs,
      sentAtMs: secondsToMilliseconds(data.timestamp),
      localUserKey: this.#makeKey('bilibili:user', sourceUserId),
      displayName: cleanUnicodeText(data.uname, 128),
      giftName: cleanUnicodeText(data.giftName, 128),
      quantity,
      unitValueMilliCny,
      totalValueMilliCny,
    })
  }

  #normalizeSuperChat(input: unknown, receivedAtMs: number): BilibiliNormalizerResult {
    const parsed = superChatSchema.safeParse(input)
    if (!parsed.success) return this.#ignored('invalid_message', 'SUPER_CHAT_MESSAGE')

    const { data } = parsed.data
    const priceCny = nonnegativeSafeInteger(data.price)
    if (priceCny === null) return this.#ignored('invalid_message', 'SUPER_CHAT_MESSAGE')
    const valueMilliCny = multiplySafe(priceCny, MILLISECONDS_PER_SECOND)
    if (valueMilliCny === null) return this.#ignored('invalid_message', 'SUPER_CHAT_MESSAGE')

    const sourceUserId = normalizeSourceIdentifier(data.uid)
    const sourceEventId = normalizeSourceIdentifier(data.id)
    return this.#event({
      type: 'super_chat',
      sessionId: this.#sessionId,
      sourceEventKey: this.#makeKey('super_chat', sourceEventId),
      receivedAtMs,
      sentAtMs: secondsToMilliseconds(data.start_time),
      localUserKey: this.#makeKey('bilibili:user', sourceUserId),
      displayName: cleanUnicodeText(data.user_info.uname, 128),
      text: cleanUnicodeText(data.message, 2_000),
      valueMilliCny,
      expiresAtMs: secondsToMilliseconds(data.end_time),
    })
  }

  #makeKey(namespace: string, sourceIdentifier: string | null): Uint8Array | null {
    if (sourceIdentifier === null) return null
    const digest = createHmac('sha256', this.#hmacKey)
      .update(`${namespace}:${sourceIdentifier}`)
      .digest()
    return Uint8Array.from(digest.subarray(0, LOCAL_KEY_BYTES))
  }

  #event(input: unknown): BilibiliNormalizerResult {
    return { kind: 'event', event: parseDomainEvent(input) }
  }

  #ignored(
    reason: 'invalid_message' | 'unsupported_command',
    command: string | null,
  ): BilibiliNormalizerResult {
    return { kind: 'ignored', reason, command }
  }
}
