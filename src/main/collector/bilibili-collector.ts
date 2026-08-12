import WebSocket from 'ws'

import type { DomainEvent } from '../../domain/events'
import {
  BilibiliBootstrapError,
  BilibiliBootstrapClient,
  type BilibiliTransportBootstrap,
  type ResolvedBilibiliRoom,
} from '../protocol/bilibili-web-v1/bootstrap-client'
import { BilibiliEventNormalizer } from '../protocol/bilibili-web-v1/normalizer'
import {
  decodeBilibiliPacketsAsync,
  encodeBilibiliPacket,
} from '../protocol/bilibili-web-v1/packets'

const HEARTBEAT_INTERVAL_MS = 30_000
const WAITING_POLL_INTERVAL_MS = 15_000
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const
const MAX_FRAME_BYTES = 16 * 1024 * 1024
const MAX_QUEUED_FRAME_BYTES = 16 * 1024 * 1024
const MAX_OUTBOUND_BUFFER_BYTES = 1024 * 1024
const AUTHENTICATION_TIMEOUT_MS = 10_000

export interface BilibiliWebSocket {
  readonly readyState: number
  readonly bufferedAmount: number
  on(event: 'open', listener: () => void): this
  on(event: 'message', listener: (data: unknown) => void): this
  on(event: 'close', listener: (code: number) => void): this
  on(event: 'error', listener: (error: unknown) => void): this
  send(data: Uint8Array): void
  close(code?: number): void
}

export interface BilibiliBootstrap {
  resolveRoom(input: string): Promise<ResolvedBilibiliRoom>
  discoverTransport(roomId: string): Promise<BilibiliTransportBootstrap>
}

export type BilibiliCollectorErrorCode =
  | 'INVALID_INPUT'
  | 'ROOM_NOT_FOUND'
  | 'UPSTREAM_UNAVAILABLE'
  | 'ANONYMOUS_ACCESS_LIMITED'
  | 'AUTHENTICATION_FAILED'
  | 'PROTOCOL_ERROR'
  | 'SESSION_INITIALIZATION_FAILED'
  | 'STORAGE_WRITE_FAILED'
  | 'BUFFER_LIMIT_EXCEEDED'
  | 'WEBSOCKET_DISCONNECTED'

export interface BilibiliCollectorCallbacks {
  onRoomResolved(room: ResolvedBilibiliRoom): void
  onWaiting(room: ResolvedBilibiliRoom): void
  onAuthenticated(room: {
    inputRoomId: string
    roomId: string
  }): Promise<{ sessionId: number; hmacKey: Uint8Array }>
  onConnectionAuthenticated?(): Promise<void>
  onEvents(events: DomainEvent[]): Promise<void>
  onPopularity(value: number): Promise<void>
  onSignal(signal: 'live' | 'preparing'): void
  onRecovering(code: BilibiliCollectorErrorCode): Promise<void>
  onError(code: BilibiliCollectorErrorCode): void
}

export interface BilibiliCollectorOptions {
  bootstrap?: BilibiliBootstrap
  createWebSocket?: (url: string) => BilibiliWebSocket
  now?: () => number
  random?: () => number
  setTimeout?: typeof setTimeout
  clearTimeout?: typeof clearTimeout
  setInterval?: typeof setInterval
  clearInterval?: typeof clearInterval
}

function toBuffer(data: unknown): Buffer | null {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  }
  return null
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8')) as unknown
  } catch {
    return null
  }
}

function hasSuccessfulAuthentication(body: Buffer): boolean {
  const value = parseJson(body)
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    (value as { code?: unknown }).code === 0
  )
}

export class BilibiliCollector {
  private readonly bootstrap: BilibiliBootstrap
  private readonly createWebSocket: (url: string) => BilibiliWebSocket
  private readonly now: () => number
  private readonly random: () => number
  private readonly scheduleTimeout: typeof setTimeout
  private readonly cancelTimeout: typeof clearTimeout
  private readonly scheduleInterval: typeof setInterval
  private readonly cancelInterval: typeof clearInterval
  private callbacks: BilibiliCollectorCallbacks | null = null
  private socket: BilibiliWebSocket | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private authenticationTimer: ReturnType<typeof setTimeout> | null = null
  private waitingTimer: ReturnType<typeof setTimeout> | null = null
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null
  private normalizer: BilibiliEventNormalizer | null = null
  private authenticatedSocket: BilibiliWebSocket | null = null
  private heartbeatMisses = 0
  private room: ResolvedBilibiliRoom | null = null
  private running = false
  private generation = 0
  private retryAttempt = 0

  constructor(optionsOrBootstrap: BilibiliCollectorOptions | BilibiliBootstrap = {}) {
    const options =
      'resolveRoom' in optionsOrBootstrap ? { bootstrap: optionsOrBootstrap } : optionsOrBootstrap
    this.bootstrap =
      options.bootstrap ??
      new BilibiliBootstrapClient({
        userAgent:
          'Mozilla/5.0 (Macintosh; Apple Silicon Mac OS X 13_0) AppleWebKit/537.36 Chrome/149.0.0.0 Safari/537.36',
      })
    this.createWebSocket =
      options.createWebSocket ??
      ((url) =>
        new WebSocket(url, {
          followRedirects: false,
          maxPayload: 16 * 1024 * 1024,
          perMessageDeflate: false,
          headers: { Origin: 'https://live.bilibili.com' },
        }))
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
    this.scheduleTimeout = options.setTimeout ?? setTimeout
    this.cancelTimeout = options.clearTimeout ?? clearTimeout
    this.scheduleInterval = options.setInterval ?? setInterval
    this.cancelInterval = options.clearInterval ?? clearInterval
  }

  async start(roomInput: string, callbacks: BilibiliCollectorCallbacks): Promise<void> {
    if (this.running) throw new Error('COLLECTOR_ALREADY_STARTED')
    this.running = true
    this.callbacks = callbacks
    const generation = ++this.generation
    await this.resolveAndStart(roomInput, generation)
  }

  async stop(): Promise<void> {
    this.running = false
    this.generation += 1
    this.callbacks = null
    this.normalizer = null
    this.authenticatedSocket = null
    this.heartbeatMisses = 0
    this.room = null
    this.retryAttempt = 0
    this.clearHeartbeat()
    this.clearAuthenticationTimer()
    this.clearWaitingTimer()
    this.clearRecoveryTimer()
    const socket = this.socket
    this.socket = null
    if (socket !== null) socket.close(1000)
  }

  private async resolveAndStart(roomInput: string, generation: number): Promise<void> {
    try {
      const room = await this.bootstrap.resolveRoom(roomInput)
      if (!this.isCurrent(generation)) return
      this.room = room
      this.callbacks?.onRoomResolved(room)
      if (room.liveStatus !== 1) {
        this.callbacks?.onWaiting(room)
        this.clearWaitingTimer()
        this.waitingTimer = this.scheduleTimeout(() => {
          this.waitingTimer = null
          if (this.isCurrent(generation)) void this.resolveAndStart(roomInput, generation)
        }, WAITING_POLL_INTERVAL_MS)
        return
      }

      this.clearWaitingTimer()
      const transport = await this.bootstrap.discoverTransport(room.roomId)
      if (!this.isCurrent(generation)) return
      this.connect(room, transport, 0, generation)
    } catch (error) {
      if (this.isCurrent(generation)) this.callbacks?.onError(this.toErrorCode(error))
    }
  }

  private connect(
    room: ResolvedBilibiliRoom,
    transport: BilibiliTransportBootstrap,
    hostIndex: number,
    generation: number,
  ): void {
    const host = transport.hosts[hostIndex]
    if (host === undefined) {
      this.callbacks?.onError('UPSTREAM_UNAVAILABLE')
      return
    }

    let socket: BilibiliWebSocket
    try {
      socket = this.createWebSocket(`wss://${host.host}:${host.wssPort}/sub`)
    } catch {
      this.scheduleRecovery(room, transport, hostIndex + 1, generation, 'UPSTREAM_UNAVAILABLE')
      return
    }
    this.socket = socket
    let recoveryScheduled = false
    let queuedFrameBytes = 0
    let frameChain: Promise<void> = Promise.resolve()
    const recover = (code: BilibiliCollectorErrorCode, refreshTransport = false): void => {
      if (recoveryScheduled || !this.isCurrent(generation) || this.socket !== socket) return
      recoveryScheduled = true
      this.socket = null
      if (this.authenticatedSocket === socket) this.authenticatedSocket = null
      this.clearAuthenticationTimer()
      this.scheduleRecovery(
        room,
        transport,
        refreshTransport ? transport.hosts.length : hostIndex + 1,
        generation,
        code,
      )
    }
    socket.on('open', () => {
      if (!this.isCurrent(generation) || this.socket !== socket) return
      const authBody = Buffer.from(
        JSON.stringify({
          uid: 0,
          roomid: Number(room.roomId),
          protover: 3,
          buvid: transport.buvid,
          platform: 'web',
          type: 2,
          key: transport.token,
        }),
        'utf8',
      )
      if (
        !this.sendPacket(socket, encodeBilibiliPacket({ operation: 7, version: 1, body: authBody }))
      ) {
        recover('BUFFER_LIMIT_EXCEEDED')
        socket.close(1009)
        return
      }
      this.clearAuthenticationTimer()
      this.authenticationTimer = this.scheduleTimeout(() => {
        this.authenticationTimer = null
        recover('AUTHENTICATION_FAILED', true)
        socket.close(1008)
      }, AUTHENTICATION_TIMEOUT_MS)
    })
    socket.on('message', (data) => {
      const frame = toBuffer(data)
      if (frame === null || !this.isCurrent(generation) || this.socket !== socket) return
      if (
        frame.byteLength > MAX_FRAME_BYTES ||
        queuedFrameBytes + frame.byteLength > MAX_QUEUED_FRAME_BYTES
      ) {
        recover('BUFFER_LIMIT_EXCEEDED')
        socket.close(1009)
        return
      }
      queuedFrameBytes += frame.byteLength
      frameChain = frameChain
        .then(() => this.processFrame(frame, socket, generation, recover))
        .catch(() => {
          recover('PROTOCOL_ERROR')
          socket.close(1002)
        })
        .finally(() => {
          queuedFrameBytes -= frame.byteLength
        })
    })
    socket.on('close', () => {
      recover('WEBSOCKET_DISCONNECTED')
    })
    socket.on('error', () => {
      recover('WEBSOCKET_DISCONNECTED')
      socket.close(1011)
    })
  }

  private scheduleRecovery(
    room: ResolvedBilibiliRoom,
    transport: BilibiliTransportBootstrap,
    nextHostIndex: number,
    generation: number,
    code: BilibiliCollectorErrorCode,
  ): void {
    this.clearHeartbeat()
    this.clearRecoveryTimer()
    const onRecovering = this.callbacks?.onRecovering(code)
    if (onRecovering !== undefined) {
      void onRecovering.catch(() => this.callbacks?.onError('STORAGE_WRITE_FAILED'))
    }

    const baseDelay = RETRY_DELAYS_MS[Math.min(this.retryAttempt, RETRY_DELAYS_MS.length - 1)]
    this.retryAttempt += 1
    const random = this.random()
    const boundedRandom = Number.isFinite(random) ? Math.min(1, Math.max(0, random)) : 0.5
    const delay = Math.round((baseDelay ?? 30_000) * (0.8 + boundedRandom * 0.4))
    this.recoveryTimer = this.scheduleTimeout(() => {
      this.recoveryTimer = null
      if (!this.isCurrent(generation)) return
      if (nextHostIndex < transport.hosts.length) {
        this.connect(room, transport, nextHostIndex, generation)
        return
      }
      void this.refreshTransport(room, transport, generation)
    }, delay)
  }

  private async refreshTransport(
    room: ResolvedBilibiliRoom,
    previousTransport: BilibiliTransportBootstrap,
    generation: number,
  ): Promise<void> {
    try {
      const transport = await this.bootstrap.discoverTransport(room.roomId)
      if (!this.isCurrent(generation)) return
      this.connect(room, transport, 0, generation)
    } catch {
      if (!this.isCurrent(generation)) return
      this.scheduleRecovery(
        room,
        previousTransport,
        previousTransport.hosts.length,
        generation,
        'UPSTREAM_UNAVAILABLE',
      )
    }
  }

  private async processFrame(
    frame: Buffer,
    socket: BilibiliWebSocket,
    generation: number,
    recover: (code: BilibiliCollectorErrorCode, refreshTransport?: boolean) => void,
  ): Promise<void> {
    const packets = await decodeBilibiliPacketsAsync(frame)
    if (packets.length > 0) this.heartbeatMisses = 0
    const events: DomainEvent[] = []
    const signals: Array<'live' | 'preparing'> = []

    for (const packet of packets) {
      if (!this.isCurrent(generation) || this.socket !== socket) return
      if (packet.operation === 8) {
        this.clearAuthenticationTimer()
        if (!hasSuccessfulAuthentication(packet.body)) {
          recover('AUTHENTICATION_FAILED', true)
          socket.close(1008)
          return
        }
        this.authenticatedSocket = socket
        this.retryAttempt = 0
        if (!this.sendHeartbeat(socket)) {
          recover('BUFFER_LIMIT_EXCEEDED')
          socket.close(1009)
          return
        }
        this.startHeartbeat(socket, generation, recover)
        if (this.normalizer === null) {
          const onAuthenticated = this.callbacks?.onAuthenticated
          if (onAuthenticated === undefined) return
          let session: { sessionId: number; hmacKey: Uint8Array }
          try {
            const room = this.room
            if (room === null) return
            session = await onAuthenticated({
              inputRoomId: room.inputRoomId,
              roomId: room.roomId,
            })
          } catch {
            this.authenticatedSocket = null
            this.clearHeartbeat()
            this.callbacks?.onError('SESSION_INITIALIZATION_FAILED')
            await this.stop()
            return
          }
          if (!this.isCurrent(generation) || this.socket !== socket) return
          this.normalizer = new BilibiliEventNormalizer({
            sessionId: session.sessionId,
            hmacKey: session.hmacKey,
            now: this.now,
          })
        }
        try {
          await this.callbacks?.onConnectionAuthenticated?.()
        } catch {
          recover('STORAGE_WRITE_FAILED')
          socket.close(1011)
          return
        }
        continue
      }

      if (
        packet.operation === 3 &&
        this.authenticatedSocket === socket &&
        packet.body.byteLength >= 4
      ) {
        try {
          await this.callbacks?.onPopularity(packet.body.readUInt32BE(0))
        } catch {
          recover('STORAGE_WRITE_FAILED')
          socket.close(1011)
          return
        }
        continue
      }
      if (
        packet.operation !== 5 ||
        this.normalizer === null ||
        this.authenticatedSocket !== socket
      ) {
        continue
      }

      const result = this.normalizer.normalizeBusinessMessage(parseJson(packet.body))
      if (result.kind === 'event') events.push(result.event)
      else if (result.kind === 'signal') signals.push(result.signal)
    }

    if (events.length > 0) {
      try {
        await this.callbacks?.onEvents(events)
      } catch {
        recover('STORAGE_WRITE_FAILED')
        socket.close(1011)
        return
      }
    }
    for (const signal of signals) this.callbacks?.onSignal(signal)
  }

  private sendHeartbeat(socket: BilibiliWebSocket): boolean {
    return this.sendPacket(socket, encodeBilibiliPacket({ operation: 2, version: 1 }))
  }

  private startHeartbeat(
    socket: BilibiliWebSocket,
    generation: number,
    recover: (code: BilibiliCollectorErrorCode) => void,
  ): void {
    this.clearHeartbeat()
    this.heartbeatMisses = 0
    this.heartbeatTimer = this.scheduleInterval(() => {
      if (!this.isCurrent(generation) || this.socket !== socket) return
      this.heartbeatMisses += 1
      if (this.heartbeatMisses >= 2) {
        recover('WEBSOCKET_DISCONNECTED')
        socket.close(1001)
        return
      }
      if (!this.sendHeartbeat(socket)) {
        recover('BUFFER_LIMIT_EXCEEDED')
        socket.close(1009)
      }
    }, HEARTBEAT_INTERVAL_MS)
  }

  private sendPacket(socket: BilibiliWebSocket, packet: Uint8Array): boolean {
    if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > MAX_OUTBOUND_BUFFER_BYTES) {
      return false
    }
    socket.send(packet)
    return true
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      this.cancelInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  private clearAuthenticationTimer(): void {
    if (this.authenticationTimer !== null) {
      this.cancelTimeout(this.authenticationTimer)
      this.authenticationTimer = null
    }
  }

  private clearWaitingTimer(): void {
    if (this.waitingTimer !== null) {
      this.cancelTimeout(this.waitingTimer)
      this.waitingTimer = null
    }
  }

  private clearRecoveryTimer(): void {
    if (this.recoveryTimer !== null) {
      this.cancelTimeout(this.recoveryTimer)
      this.recoveryTimer = null
    }
  }

  private isCurrent(generation: number): boolean {
    return this.running && this.generation === generation
  }

  private toErrorCode(error: unknown): BilibiliCollectorErrorCode {
    return error instanceof BilibiliBootstrapError ? error.code : 'UPSTREAM_UNAVAILABLE'
  }
}
