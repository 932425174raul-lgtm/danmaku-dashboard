import { gzipSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import {
  classifyDouyinOutboundFrame,
  decodeDouyinChatFrame,
  decodeDouyinPushFrame,
} from '../../src/main/protocol/douyin-web-v1/push-frame'

function varint(value: number): Buffer {
  const bytes: number[] = []
  let remaining = value

  do {
    const next = remaining & 0x7f
    remaining = Math.floor(remaining / 128)
    bytes.push(remaining > 0 ? next | 0x80 : next)
  } while (remaining > 0)

  return Buffer.from(bytes)
}

function fieldVarint(field: number, value: number): Buffer {
  return Buffer.concat([varint(field << 3), varint(value)])
}

function fieldBytes(field: number, value: Uint8Array | string): Buffer {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value)
  return Buffer.concat([varint((field << 3) | 2), varint(bytes.length), bytes])
}

function header(key: string, value: string): Buffer {
  return Buffer.concat([fieldBytes(1, key), fieldBytes(2, value)])
}

describe('decodeDouyinPushFrame', () => {
  it('从头字段识别gzip并只返回业务方法摘要', () => {
    const message = Buffer.concat([fieldBytes(1, 'WebcastChatMessage'), fieldBytes(2, 'secret')])
    const response = Buffer.concat([
      fieldBytes(1, message),
      fieldBytes(5, 'sensitive-internal-ext'),
      fieldVarint(9, 1),
    ])
    const frame = Buffer.concat([
      fieldVarint(1, 1),
      fieldBytes(5, header('compress_type', 'gzip')),
      fieldBytes(7, 'pb'),
      fieldBytes(8, gzipSync(response)),
    ])

    expect(decodeDouyinPushFrame(frame)).toEqual({
      compression: 'gzip',
      payloadType: 'protobuf',
      messageMethods: ['WebcastChatMessage'],
      needsAck: true,
    })
  })

  it('跳过无需暴露且超过JavaScript安全整数范围的uint64字段', () => {
    const response = fieldBytes(1, fieldBytes(1, 'WebcastLikeMessage'))
    const maximumUint64 = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01])
    const frame = Buffer.concat([
      fieldVarint(1, 1),
      Buffer.from([0x10]),
      maximumUint64,
      fieldBytes(7, 'pb'),
      fieldBytes(8, response),
    ])

    expect(decodeDouyinPushFrame(frame)).toEqual({
      compression: 'none',
      payloadType: 'protobuf',
      messageMethods: ['WebcastLikeMessage'],
      needsAck: false,
    })
  })

  it('只按固定payloadType分类出站ACK与心跳', () => {
    expect(classifyDouyinOutboundFrame(fieldBytes(7, 'ack'))).toBe('ack')
    expect(classifyDouyinOutboundFrame(fieldBytes(7, 'hb'))).toBe('heartbeat')
    expect(classifyDouyinOutboundFrame(fieldBytes(7, 'user-derived-value'))).toBe('unknown')
  })

  it('拒绝未知入站载荷类型', () => {
    const frame = Buffer.concat([fieldBytes(7, 'json'), fieldBytes(8, Buffer.alloc(0))])

    expect(() => decodeDouyinPushFrame(frame)).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_PAYLOAD_TYPE' }),
    )
  })

  it('兼容当前网页使用的msg载荷类型', () => {
    const response = fieldBytes(1, fieldBytes(1, 'WebcastChatMessage'))
    const frame = Buffer.concat([fieldBytes(7, 'msg'), fieldBytes(8, response)])

    expect(decodeDouyinPushFrame(frame).payloadType).toBe('protobuf')
  })

  it('拒绝超过固定上限的外层帧和gzip解压结果', () => {
    expect(() => decodeDouyinPushFrame(Buffer.alloc(1024 * 1024 + 1))).toThrow(
      expect.objectContaining({ code: 'FRAME_TOO_LARGE' }),
    )

    const oversizedResponse = gzipSync(Buffer.alloc(8 * 1024 * 1024 + 1))
    const frame = Buffer.concat([
      fieldBytes(6, 'gzip'),
      fieldBytes(7, 'pb'),
      fieldBytes(8, oversizedResponse),
    ])
    expect(() => decodeDouyinPushFrame(frame)).toThrow(
      expect.objectContaining({ code: 'INFLATED_PAYLOAD_TOO_LARGE' }),
    )
  })

  it('把评论载荷裁剪成不含平台用户ID的实时弹幕', () => {
    const user = Buffer.concat([fieldVarint(1, 9_999), fieldBytes(3, '匿名观众')])
    const chat = Buffer.concat([fieldBytes(2, user), fieldBytes(3, '这是一条实时弹幕')])
    const message = Buffer.concat([fieldBytes(1, 'WebcastChatMessage'), fieldBytes(2, chat)])
    const response = fieldBytes(1, message)
    const frame = Buffer.concat([fieldBytes(7, 'pb'), fieldBytes(8, response)])

    expect(decodeDouyinChatFrame(frame)).toEqual([
      { displayName: '匿名观众', content: '这是一条实时弹幕' },
    ])
    expect(JSON.stringify(decodeDouyinChatFrame(frame))).not.toContain('9999')

    expect(
      decodeDouyinChatFrame(frame, (platformUserId) => `local-${platformUserId.length}`),
    ).toEqual([{ displayName: '匿名观众', content: '这是一条实时弹幕', localUserKey: 'local-4' }])
  })
})
