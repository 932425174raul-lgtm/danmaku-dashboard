import { z } from 'zod'

import { parseBilibiliRoomInput } from './room-input'
import { signWbiParameters } from './wbi'

const ROOM_INIT_ENDPOINT = 'https://api.live.bilibili.com/room/v1/Room/room_init'
const NAV_ENDPOINT = 'https://api.bilibili.com/x/web-interface/nav'
const SPI_ENDPOINT = 'https://api.bilibili.com/x/frontend/finger/spi'
const DANMAKU_INFO_ENDPOINT = 'https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo'
const LIVE_ORIGIN = 'https://live.bilibili.com'
const WEB_LOCATION = '444.7'
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_RESPONSE_CHARACTERS = 1_000_000

const responseEnvelopeSchema = z.object({
  code: z.number().int(),
})

const roomResponseSchema = z.object({
  code: z.literal(0),
  data: z.object({
    room_id: z.number().int().positive().safe(),
    live_status: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  }),
})

const navResponseSchema = z.object({
  code: z.number().int(),
  data: z.object({
    wbi_img: z.object({
      img_url: z.string(),
      sub_url: z.string(),
    }),
  }),
})

const spiResponseSchema = z.object({
  code: z.literal(0),
  data: z.object({
    b_3: z.string().min(1).max(512),
  }),
})

const hostnameSchema = z
  .string()
  .min(1)
  .max(253)
  .refine((host) => {
    if (host.endsWith('.') || host.includes('..')) return false
    return host.split('.').every((label) => {
      return (
        label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu.test(label)
      )
    })
  })

const danmakuInfoResponseSchema = z.object({
  code: z.literal(0),
  data: z.object({
    token: z.string().min(1).max(16_384),
    host_list: z
      .array(
        z.object({
          host: hostnameSchema,
          wss_port: z.number().int().min(1).max(65_535),
        }),
      )
      .min(1),
  }),
})

export type BilibiliBootstrapErrorCode =
  'INVALID_INPUT' | 'ROOM_NOT_FOUND' | 'UPSTREAM_UNAVAILABLE' | 'ANONYMOUS_ACCESS_LIMITED'

export class BilibiliBootstrapError extends Error {
  readonly code: BilibiliBootstrapErrorCode

  constructor(code: BilibiliBootstrapErrorCode) {
    super(code)
    this.name = 'BilibiliBootstrapError'
    this.code = code
  }
}

export interface ResolvedBilibiliRoom {
  inputRoomId: string
  roomId: string
  liveStatus: 0 | 1 | 2
}

export interface BilibiliTransportHost {
  host: string
  wssPort: number
}

export interface BilibiliTransportBootstrap {
  token: string
  buvid: string
  hosts: BilibiliTransportHost[]
}

type BootstrapFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface BilibiliBootstrapClientOptions {
  fetcher?: BootstrapFetch
  now?: () => number
  userAgent: string
  timeoutMs?: number
}

function parseWbiKey(rawUrl: string): string {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new BilibiliBootstrapError('UPSTREAM_UNAVAILABLE')
  }

  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    !(url.hostname === 'hdslb.com' || url.hostname.endsWith('.hdslb.com'))
  ) {
    throw new BilibiliBootstrapError('UPSTREAM_UNAVAILABLE')
  }

  const filename = url.pathname.split('/').at(-1) ?? ''
  const key = filename.replace(/\.[^.]+$/u, '')
  if (!/^[a-f0-9]{32}$/iu.test(key)) {
    throw new BilibiliBootstrapError('UPSTREAM_UNAVAILABLE')
  }
  return key
}

function validateUserAgent(userAgent: string): string {
  const value = userAgent.trim()
  if (value.length === 0 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new BilibiliBootstrapError('INVALID_INPUT')
  }
  return value
}

function validateTimeout(timeoutMs: number): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
    throw new BilibiliBootstrapError('INVALID_INPUT')
  }
  return timeoutMs
}

function toUnixSeconds(now: number): number {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new BilibiliBootstrapError('UPSTREAM_UNAVAILABLE')
  }
  return Math.floor(now / 1_000)
}

export class BilibiliBootstrapClient {
  private readonly fetcher: BootstrapFetch
  private readonly now: () => number
  private readonly userAgent: string
  private readonly timeoutMs: number

  constructor(options: BilibiliBootstrapClientOptions) {
    this.fetcher = options.fetcher ?? fetch
    this.now = options.now ?? Date.now
    this.userAgent = validateUserAgent(options.userAgent)
    this.timeoutMs = validateTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  }

  async resolveRoom(input: string): Promise<ResolvedBilibiliRoom> {
    const roomInput = parseBilibiliRoomInput(input)
    if (roomInput === null) {
      throw new BilibiliBootstrapError('INVALID_INPUT')
    }

    const url = new URL(ROOM_INIT_ENDPOINT)
    url.searchParams.set('id', roomInput.roomId)
    const body = await this.requestJson(url, this.commonHeaders())
    const envelope = responseEnvelopeSchema.safeParse(body)
    if (!envelope.success) {
      throw new BilibiliBootstrapError('UPSTREAM_UNAVAILABLE')
    }
    if (envelope.data.code !== 0) {
      throw new BilibiliBootstrapError('ROOM_NOT_FOUND')
    }

    const response = roomResponseSchema.safeParse(body)
    if (!response.success) {
      throw new BilibiliBootstrapError('UPSTREAM_UNAVAILABLE')
    }

    return {
      inputRoomId: roomInput.roomId,
      roomId: String(response.data.data.room_id),
      liveStatus: response.data.data.live_status,
    }
  }

  async discoverTransport(roomId: string): Promise<BilibiliTransportBootstrap> {
    const roomInput = parseBilibiliRoomInput(roomId)
    if (roomInput === null || roomInput.roomId !== roomId) {
      throw new BilibiliBootstrapError('INVALID_INPUT')
    }

    const keys = await this.loadWbiKeys()
    const buvid = await this.loadBuvid()
    let query: string
    try {
      query = signWbiParameters(
        { id: roomId, type: 0, web_location: WEB_LOCATION },
        keys,
        toUnixSeconds(this.now()),
      )
    } catch (error) {
      if (error instanceof BilibiliBootstrapError) throw error
      throw new BilibiliBootstrapError('UPSTREAM_UNAVAILABLE')
    }

    const url = new URL(DANMAKU_INFO_ENDPOINT)
    url.search = query
    const body = await this.requestJson(url, {
      ...this.commonHeaders(),
      Origin: LIVE_ORIGIN,
      Referer: `${LIVE_ORIGIN}/${roomId}`,
    })
    const envelope = responseEnvelopeSchema.safeParse(body)
    if (!envelope.success) {
      throw new BilibiliBootstrapError('UPSTREAM_UNAVAILABLE')
    }
    if (envelope.data.code === -352) {
      throw new BilibiliBootstrapError('ANONYMOUS_ACCESS_LIMITED')
    }
    if (envelope.data.code !== 0) {
      throw new BilibiliBootstrapError('UPSTREAM_UNAVAILABLE')
    }

    const response = danmakuInfoResponseSchema.safeParse(body)
    if (!response.success) {
      throw new BilibiliBootstrapError('UPSTREAM_UNAVAILABLE')
    }

    return {
      token: response.data.data.token,
      buvid,
      hosts: response.data.data.host_list.map((host) => ({
        host: host.host,
        wssPort: host.wss_port,
      })),
    }
  }

  private async loadWbiKeys(): Promise<{ imageKey: string; subKey: string }> {
    const body = await this.requestJson(NAV_ENDPOINT, this.commonHeaders())
    const response = navResponseSchema.safeParse(body)
    if (!response.success) {
      throw new BilibiliBootstrapError('UPSTREAM_UNAVAILABLE')
    }
    return {
      imageKey: parseWbiKey(response.data.data.wbi_img.img_url),
      subKey: parseWbiKey(response.data.data.wbi_img.sub_url),
    }
  }

  private async loadBuvid(): Promise<string> {
    try {
      const body = await this.requestJson(SPI_ENDPOINT, this.commonHeaders())
      const response = spiResponseSchema.safeParse(body)
      return response.success ? response.data.data.b_3 : ''
    } catch {
      return ''
    }
  }

  private commonHeaders(): Record<string, string> {
    return {
      Accept: 'application/json',
      'User-Agent': this.userAgent,
    }
  }

  private async requestJson(
    endpoint: string | URL,
    headers: Record<string, string>,
  ): Promise<unknown> {
    const controller = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort()
        reject(new BilibiliBootstrapError('UPSTREAM_UNAVAILABLE'))
      }, this.timeoutMs)
    })

    try {
      const response = await Promise.race([
        this.fetcher(endpoint, {
          method: 'GET',
          headers,
          signal: controller.signal,
          redirect: 'error',
        }),
        timeoutPromise,
      ])
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
        throw new BilibiliBootstrapError('UPSTREAM_UNAVAILABLE')
      }

      const text = await response.text()
      if (text.length > MAX_RESPONSE_CHARACTERS) {
        throw new BilibiliBootstrapError('UPSTREAM_UNAVAILABLE')
      }
      try {
        return JSON.parse(text) as unknown
      } catch {
        throw new BilibiliBootstrapError('UPSTREAM_UNAVAILABLE')
      }
    } catch (error) {
      if (error instanceof BilibiliBootstrapError) throw error
      throw new BilibiliBootstrapError('UPSTREAM_UNAVAILABLE')
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }
}
