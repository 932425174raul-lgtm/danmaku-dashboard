import { EventEmitter } from 'node:events'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  BilibiliCollector,
  type BilibiliCollectorCallbacks,
  type BilibiliWebSocket,
} from '../../src/main/collector/bilibili-collector'
import type {
  BilibiliTransportBootstrap,
  ResolvedBilibiliRoom,
} from '../../src/main/protocol/bilibili-web-v1/bootstrap-client'
import {
  decodeBilibiliPackets,
  encodeBilibiliPacket,
} from '../../src/main/protocol/bilibili-web-v1/packets'

class FakeSocket extends EventEmitter implements BilibiliWebSocket {
  readonly sent: Buffer[] = []
  readyState = 0
  bufferedAmount = 0
  closed = false

  send(data: Uint8Array): void {
    this.sent.push(Buffer.from(data))
  }

  close(): void {
    this.closed = true
    this.readyState = 3
  }

  open(): void {
    this.readyState = 1
    this.emit('open')
  }

  receive(frame: Uint8Array): void {
    this.emit('message', Buffer.from(frame))
  }

  disconnect(code = 1006): void {
    this.readyState = 3
    this.emit('close', code)
  }
}

const flush = async (): Promise<void> => {
  for (let index = 0; index < 10; index += 1) await Promise.resolve()
}

function businessPacket(message: unknown): Buffer {
  return encodeBilibiliPacket({
    operation: 5,
    version: 0,
    body: Buffer.from(JSON.stringify(message), 'utf8'),
  })
}

describe('BilibiliCollector', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('鉴权成功后才创建会话并只输出规范化事件', async () => {
    vi.useFakeTimers()
    const sockets: FakeSocket[] = []
    const bootstrap = {
      resolveRoom: vi.fn<(_input: string) => Promise<ResolvedBilibiliRoom>>(async () => ({
        inputRoomId: '123',
        roomId: '98765',
        liveStatus: 1,
      })),
      discoverTransport: vi.fn<(_roomId: string) => Promise<BilibiliTransportBootstrap>>(
        async () => ({
          token: 'synthetic-token',
          buvid: '',
          hosts: [{ host: 'first.example.invalid', wssPort: 443 }],
        }),
      ),
    }
    const events: unknown[] = []
    const popularity: number[] = []
    const signals: string[] = []
    const onAuthenticated = vi.fn(async () => ({
      sessionId: 7,
      hmacKey: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
    }))
    const callbacks: BilibiliCollectorCallbacks = {
      onRoomResolved: vi.fn(),
      onWaiting: vi.fn(),
      onAuthenticated,
      onEvents: async (batch) => {
        events.push(...batch)
      },
      onPopularity: async (value) => {
        popularity.push(value)
      },
      onSignal: (signal) => signals.push(signal),
      onRecovering: vi.fn(),
      onError: vi.fn(),
    }
    const collector = new BilibiliCollector({
      bootstrap,
      createWebSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
      now: () => 1_780_000_000_500,
      random: () => 0.5,
    })

    await collector.start('123', callbacks)
    expect(sockets).toHaveLength(1)
    const socket = sockets[0]
    if (socket === undefined) throw new Error('missing socket')

    socket.open()
    expect(onAuthenticated).not.toHaveBeenCalled()
    const authPacket = decodeBilibiliPackets(socket.sent[0] ?? Buffer.alloc(0))[0]
    expect(authPacket?.operation).toBe(7)
    expect(JSON.parse(authPacket?.body.toString('utf8') ?? '{}')).toEqual({
      uid: 0,
      roomid: 98765,
      protover: 3,
      buvid: '',
      platform: 'web',
      type: 2,
      key: 'synthetic-token',
    })

    const authReply = encodeBilibiliPacket({
      operation: 8,
      version: 1,
      body: Buffer.from('{"code":0}', 'utf8'),
    })
    const heatBody = Buffer.alloc(4)
    heatBody.writeUInt32BE(54_321)
    const heatReply = encodeBilibiliPacket({ operation: 3, version: 1, body: heatBody })
    socket.receive(
      Buffer.concat([
        authReply,
        heatReply,
        businessPacket({
          cmd: 'DANMU_MSG:4:0:2',
          info: [
            [0, 0, 0, 0, 1_780_000_000_000, 'synthetic-message'],
            '测试弹幕',
            ['synthetic-user', '测试用户'],
            [6, '测试牌'],
          ],
        }),
        businessPacket({ cmd: 'LIVE' }),
      ]),
    )
    await flush()

    expect(onAuthenticated).toHaveBeenCalledTimes(1)
    expect(socket.sent.map((frame) => decodeBilibiliPackets(frame)[0]?.operation)).toEqual([7, 2])
    expect(popularity).toEqual([54_321])
    expect(signals).toEqual(['live'])
    expect(events).toMatchObject([
      {
        type: 'danmaku',
        sessionId: 7,
        displayName: '测试用户',
        text: '测试弹幕',
      },
    ])
    expect(JSON.stringify(events)).not.toContain('synthetic-user')

    await vi.advanceTimersByTimeAsync(30_000)
    expect(socket.sent.map((frame) => decodeBilibiliPackets(frame)[0]?.operation)).toEqual([
      7, 2, 2,
    ])

    await collector.stop()
  })

  it('未开播时每15秒轮询并在停止后取消等待', async () => {
    vi.useFakeTimers()
    const sockets: FakeSocket[] = []
    let resolution = 0
    const bootstrap = {
      resolveRoom: vi.fn<(_input: string) => Promise<ResolvedBilibiliRoom>>(async () => {
        resolution += 1
        return {
          inputRoomId: '123',
          roomId: '98765',
          liveStatus: resolution === 1 ? 0 : 1,
        }
      }),
      discoverTransport: vi.fn<(_roomId: string) => Promise<BilibiliTransportBootstrap>>(
        async () => ({
          token: 'synthetic-token',
          buvid: '',
          hosts: [{ host: 'first.example.invalid', wssPort: 443 }],
        }),
      ),
    }
    const onWaiting = vi.fn()
    const callbacks: BilibiliCollectorCallbacks = {
      onRoomResolved: vi.fn(),
      onWaiting,
      onAuthenticated: vi.fn(async () => ({
        sessionId: 7,
        hmacKey: new Uint8Array(32),
      })),
      onEvents: vi.fn(),
      onPopularity: vi.fn(),
      onSignal: vi.fn(),
      onRecovering: vi.fn(),
      onError: vi.fn(),
    }
    const collector = new BilibiliCollector({
      bootstrap,
      createWebSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
      random: () => 0.5,
    })

    await collector.start('123', callbacks)
    expect(onWaiting).toHaveBeenCalledTimes(1)
    expect(sockets).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(14_999)
    expect(bootstrap.resolveRoom).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(bootstrap.resolveRoom).toHaveBeenCalledTimes(2)
    expect(bootstrap.discoverTransport).toHaveBeenCalledWith('98765')
    expect(sockets).toHaveLength(1)

    await collector.stop()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(bootstrap.resolveRoom).toHaveBeenCalledTimes(2)
  })

  it('断线时按退避轮换节点并在节点耗尽后完整刷新', async () => {
    vi.useFakeTimers()
    const sockets: FakeSocket[] = []
    let discovery = 0
    const bootstrap = {
      resolveRoom: vi.fn<(_input: string) => Promise<ResolvedBilibiliRoom>>(async () => ({
        inputRoomId: '123',
        roomId: '98765',
        liveStatus: 1,
      })),
      discoverTransport: vi.fn<(_roomId: string) => Promise<BilibiliTransportBootstrap>>(
        async () => {
          discovery += 1
          return discovery === 1
            ? {
                token: 'synthetic-token-1',
                buvid: '',
                hosts: [
                  { host: 'first.example.invalid', wssPort: 443 },
                  { host: 'second.example.invalid', wssPort: 443 },
                ],
              }
            : {
                token: 'synthetic-token-2',
                buvid: '',
                hosts: [{ host: 'refreshed.example.invalid', wssPort: 443 }],
              }
        },
      ),
    }
    const onRecovering = vi.fn()
    const callbacks: BilibiliCollectorCallbacks = {
      onRoomResolved: vi.fn(),
      onWaiting: vi.fn(),
      onAuthenticated: vi.fn(async () => ({
        sessionId: 7,
        hmacKey: new Uint8Array(32),
      })),
      onEvents: vi.fn(),
      onPopularity: vi.fn(),
      onSignal: vi.fn(),
      onRecovering,
      onError: vi.fn(),
    }
    const collector = new BilibiliCollector({
      bootstrap,
      createWebSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
      random: () => 0.5,
    })

    await collector.start('123', callbacks)
    expect(sockets).toHaveLength(1)
    sockets[0]?.disconnect()
    expect(onRecovering).toHaveBeenCalledWith('WEBSOCKET_DISCONNECTED')

    await vi.advanceTimersByTimeAsync(999)
    expect(sockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(sockets).toHaveLength(2)
    expect(bootstrap.discoverTransport).toHaveBeenCalledTimes(1)

    sockets[1]?.disconnect()
    await vi.advanceTimersByTimeAsync(1_999)
    expect(sockets).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(bootstrap.discoverTransport).toHaveBeenCalledTimes(2)
    expect(sockets).toHaveLength(3)

    sockets[2]?.disconnect()
    await collector.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(bootstrap.discoverTransport).toHaveBeenCalledTimes(2)
    expect(sockets).toHaveLength(3)
  })

  it('超过接收缓冲上限时只报告固定错误码并恢复', async () => {
    vi.useFakeTimers()
    const socket = new FakeSocket()
    const onRecovering = vi.fn()
    const onError = vi.fn()
    const collector = new BilibiliCollector({
      bootstrap: {
        resolveRoom: async () => ({
          inputRoomId: '123',
          roomId: '98765',
          liveStatus: 1,
        }),
        discoverTransport: async () => ({
          token: 'sensitive-synthetic-token',
          buvid: '',
          hosts: [{ host: 'sensitive.example.invalid', wssPort: 443 }],
        }),
      },
      createWebSocket: () => socket,
      random: () => 0.5,
    })
    const callbacks: BilibiliCollectorCallbacks = {
      onRoomResolved: vi.fn(),
      onWaiting: vi.fn(),
      onAuthenticated: vi.fn(async () => ({
        sessionId: 7,
        hmacKey: new Uint8Array(32),
      })),
      onEvents: vi.fn(),
      onPopularity: vi.fn(),
      onSignal: vi.fn(),
      onRecovering,
      onError,
    }

    await collector.start('123', callbacks)
    socket.receive(Buffer.alloc(16 * 1024 * 1024 + 1, 7))
    await flush()

    expect(onRecovering).toHaveBeenCalledWith('BUFFER_LIMIT_EXCEEDED')
    const callbackOutput = JSON.stringify({
      recovering: onRecovering.mock.calls,
      errors: onError.mock.calls,
    })
    expect(callbackOutput).not.toContain('sensitive-synthetic-token')
    expect(callbackOutput).not.toContain('sensitive.example.invalid')

    await collector.stop()
  })

  it('鉴权失败时不创建会话并完整刷新临时令牌', async () => {
    vi.useFakeTimers()
    const sockets: FakeSocket[] = []
    const discoverTransport = vi.fn(async (): Promise<BilibiliTransportBootstrap> => ({
      token: 'synthetic-token',
      buvid: '',
      hosts: [
        { host: 'first.example.invalid', wssPort: 443 },
        { host: 'second.example.invalid', wssPort: 443 },
      ],
    }))
    const onAuthenticated = vi.fn(async () => ({
      sessionId: 7,
      hmacKey: new Uint8Array(32),
    }))
    const onRecovering = vi.fn()
    const collector = new BilibiliCollector({
      bootstrap: {
        resolveRoom: async () => ({
          inputRoomId: '123',
          roomId: '98765',
          liveStatus: 1,
        }),
        discoverTransport,
      },
      createWebSocket: () => {
        const socket = new FakeSocket()
        sockets.push(socket)
        return socket
      },
      random: () => 0.5,
    })
    await collector.start('123', {
      onRoomResolved: vi.fn(),
      onWaiting: vi.fn(),
      onAuthenticated,
      onEvents: vi.fn(),
      onPopularity: vi.fn(),
      onSignal: vi.fn(),
      onRecovering,
      onError: vi.fn(),
    })
    const socket = sockets[0]
    if (socket === undefined) throw new Error('missing socket')
    socket.open()
    socket.receive(
      encodeBilibiliPacket({
        operation: 8,
        version: 1,
        body: Buffer.from('{"code":-101}', 'utf8'),
      }),
    )
    await flush()

    expect(onAuthenticated).not.toHaveBeenCalled()
    expect(onRecovering).toHaveBeenCalledWith('AUTHENTICATION_FAILED')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(discoverTransport).toHaveBeenCalledTimes(2)
    expect(sockets).toHaveLength(2)

    await collector.stop()
  })

  it('持久化回调拒绝时关闭当前套接字并进入存储恢复', async () => {
    vi.useFakeTimers()
    const socket = new FakeSocket()
    const onRecovering = vi.fn()
    const collector = new BilibiliCollector({
      bootstrap: {
        resolveRoom: async () => ({ inputRoomId: '123', roomId: '98765', liveStatus: 1 }),
        discoverTransport: async () => ({
          token: 'synthetic-token',
          buvid: '',
          hosts: [{ host: 'first.example.invalid', wssPort: 443 }],
        }),
      },
      createWebSocket: () => socket,
      random: () => 0.5,
    })

    await collector.start('123', {
      onRoomResolved: vi.fn(),
      onWaiting: vi.fn(),
      onAuthenticated: vi.fn(async () => ({ sessionId: 7, hmacKey: new Uint8Array(32) })),
      onEvents: vi.fn(async () => {
        throw new Error('synthetic storage failure')
      }),
      onPopularity: vi.fn(async () => undefined),
      onSignal: vi.fn(),
      onRecovering,
      onError: vi.fn(),
    })
    socket.open()
    socket.receive(
      encodeBilibiliPacket({
        operation: 8,
        version: 1,
        body: Buffer.from('{"code":0}', 'utf8'),
      }),
    )
    await flush()
    socket.receive(
      businessPacket({
        cmd: 'DANMU_MSG',
        info: [
          [0, 0, 0, 0, 1_780_000_000_000, 'synthetic-message'],
          '需要持久化的弹幕',
          ['synthetic-user', '测试用户'],
          [],
        ],
      }),
    )
    await flush()
    await flush()

    expect(socket.closed).toBe(true)
    expect(onRecovering).toHaveBeenCalledWith('STORAGE_WRITE_FAILED')
    await collector.stop()
  })

  it('热度写入拒绝时不会产生未处理的Promise异常', async () => {
    vi.useFakeTimers()
    const socket = new FakeSocket()
    const onRecovering = vi.fn()
    const collector = new BilibiliCollector({
      bootstrap: {
        resolveRoom: async () => ({ inputRoomId: '123', roomId: '98765', liveStatus: 1 }),
        discoverTransport: async () => ({
          token: 'synthetic-token',
          buvid: '',
          hosts: [{ host: 'first.example.invalid', wssPort: 443 }],
        }),
      },
      createWebSocket: () => socket,
      random: () => 0.5,
    })
    await collector.start('123', {
      onRoomResolved: vi.fn(),
      onWaiting: vi.fn(),
      onAuthenticated: vi.fn(async () => ({ sessionId: 7, hmacKey: new Uint8Array(32) })),
      onEvents: vi.fn(async () => undefined),
      onPopularity: vi.fn(async () => {
        throw new Error('synthetic popularity storage failure')
      }),
      onSignal: vi.fn(),
      onRecovering,
      onError: vi.fn(),
    })
    socket.open()
    socket.receive(
      encodeBilibiliPacket({
        operation: 8,
        version: 1,
        body: Buffer.from('{"code":0}', 'utf8'),
      }),
    )
    await flush()
    const heatBody = Buffer.alloc(4)
    heatBody.writeUInt32BE(42)
    socket.receive(encodeBilibiliPacket({ operation: 3, version: 1, body: heatBody }))
    await flush()

    expect(socket.closed).toBe(true)
    expect(onRecovering).toHaveBeenCalledWith('STORAGE_WRITE_FAILED')
    await collector.stop()
  })
})
