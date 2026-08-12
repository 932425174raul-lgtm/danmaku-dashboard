import { z } from 'zod'

const hasUnpairedSurrogate = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1)
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
        return true
      }

      index += 1
      continue
    }

    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true
    }
  }

  return false
}

const containsControlCharacter = (value: string): boolean =>
  /[\u0000-\u001f\u007f-\u009f]/u.test(value)

const unicodeString = (maximumCodePoints: number) =>
  z
    .string()
    .refine((value) => !hasUnpairedSurrogate(value), '字符串包含非法Unicode代理项')
    .refine((value) => !containsControlCharacter(value), '字符串包含未清理的控制字符')
    .refine(
      (value) => Array.from(value).length <= maximumCodePoints,
      `字符串不能超过${maximumCodePoints}个Unicode字符`,
    )

const safeInteger = z.number().refine(Number.isSafeInteger, '数值必须是JavaScript安全整数')

const positiveSafeInteger = safeInteger.refine((value) => value > 0, '数值必须大于0')
const nonnegativeSafeInteger = safeInteger.refine((value) => value >= 0, '数值不能小于0')
const timestamp = nonnegativeSafeInteger
const nullableTimestamp = timestamp.nullable()

const localKey = z
  .instanceof(Uint8Array)
  .refine((value) => value.byteLength === 16, '本地键必须恰好为16字节')

const nullableLocalKey = localKey.nullable()
const displayName = unicodeString(128)
const visibleText = unicodeString(2_000)

const danmakuEventSchema = z
  .object({
    type: z.literal('danmaku'),
    sessionId: positiveSafeInteger,
    sourceEventKey: nullableLocalKey,
    receivedAtMs: timestamp,
    sentAtMs: nullableTimestamp,
    localUserKey: nullableLocalKey,
    displayName,
    text: visibleText,
    medalName: unicodeString(64).nullable(),
    medalLevel: nonnegativeSafeInteger.nullable(),
  })
  .strict()

const giftEventSchema = z
  .object({
    type: z.literal('gift'),
    sessionId: positiveSafeInteger,
    sourceEventKey: nullableLocalKey,
    receivedAtMs: timestamp,
    sentAtMs: nullableTimestamp,
    localUserKey: nullableLocalKey,
    displayName,
    giftName: unicodeString(128),
    quantity: positiveSafeInteger,
    unitValueMilliCny: nonnegativeSafeInteger.nullable(),
    totalValueMilliCny: nonnegativeSafeInteger.nullable(),
  })
  .strict()

const superChatEventSchema = z
  .object({
    type: z.literal('super_chat'),
    sessionId: positiveSafeInteger,
    sourceEventKey: nullableLocalKey,
    receivedAtMs: timestamp,
    sentAtMs: nullableTimestamp,
    localUserKey: nullableLocalKey,
    displayName,
    text: visibleText,
    valueMilliCny: nonnegativeSafeInteger,
    expiresAtMs: nullableTimestamp,
  })
  .strict()

const popularitySampleSchema = z
  .object({
    type: z.literal('popularity'),
    sessionId: positiveSafeInteger,
    receivedAtMs: timestamp,
    value: nonnegativeSafeInteger,
  })
  .strict()

export const domainEventSchema = z.discriminatedUnion('type', [
  danmakuEventSchema,
  giftEventSchema,
  superChatEventSchema,
  popularitySampleSchema,
])

export const sessionTransitionSchema = z
  .object({
    sessionId: positiveSafeInteger,
    atMs: timestamp,
    fromState: z.string(),
    toState: z.string(),
    reason: z.string(),
    errorCategory: z.string().nullable(),
  })
  .strict()

export type DanmakuEvent = z.infer<typeof danmakuEventSchema>
export type GiftEvent = z.infer<typeof giftEventSchema>
export type SuperChatEvent = z.infer<typeof superChatEventSchema>
export type PopularitySample = z.infer<typeof popularitySampleSchema>
export type DomainEvent = z.infer<typeof domainEventSchema>
export type SessionTransition = z.infer<typeof sessionTransitionSchema>

export const parseDomainEvent = (input: unknown): DomainEvent => domainEventSchema.parse(input)

export const parseSessionTransition = (input: unknown): SessionTransition =>
  sessionTransitionSchema.parse(input)
