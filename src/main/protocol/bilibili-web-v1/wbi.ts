import { createHash } from 'node:crypto'

export interface WbiKeys {
  imageKey: string
  subKey: string
}

const MIXIN_KEY_ORDER = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54,
  21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
] as const

const FORBIDDEN_VALUE_CHARACTERS = /[!'()*]/gu

function makeMixinKey({ imageKey, subKey }: WbiKeys): string {
  const source = `${imageKey}${subKey}`
  if (source.length < 64) throw new Error('INVALID_WBI_KEYS')
  return MIXIN_KEY_ORDER.map((index) => source[index])
    .join('')
    .slice(0, 32)
}

export function signWbiParameters(
  parameters: Readonly<Record<string, string | number>>,
  keys: WbiKeys,
  unixSeconds: number,
): string {
  if (!Number.isSafeInteger(unixSeconds) || unixSeconds < 0) {
    throw new Error('INVALID_WBI_TIMESTAMP')
  }

  const values: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(parameters).map(([key, value]) => [
        key,
        String(value).replace(FORBIDDEN_VALUE_CHARACTERS, ''),
      ]),
    ),
    wts: String(unixSeconds),
  }
  const unsignedQuery = Object.keys(values)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(values[key] ?? '')}`)
    .join('&')
  const digest = createHash('md5')
    .update(`${unsignedQuery}${makeMixinKey(keys)}`)
    .digest('hex')
  return `${unsignedQuery}&w_rid=${digest}`
}
