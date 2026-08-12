import { brotliCompressSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import {
  BilibiliProtocolError,
  decodeBilibiliPackets,
  encodeBilibiliPacket,
} from '../../src/main/protocol/bilibili-web-v1/packets'

describe('B站直播数据包', () => {
  it('解析同一Brotli帧中的多个业务包', () => {
    const first = encodeBilibiliPacket({
      operation: 5,
      version: 0,
      body: Buffer.from('{"cmd":"DANMU_MSG","info":[]}', 'utf8'),
    })
    const second = encodeBilibiliPacket({
      operation: 5,
      version: 1,
      body: Buffer.from('{"cmd":"LIVE"}', 'utf8'),
    })
    const outer = encodeBilibiliPacket({
      operation: 5,
      version: 3,
      body: brotliCompressSync(Buffer.concat([first, second])),
    })

    expect(
      decodeBilibiliPackets(outer).map((packet) => ({
        operation: packet.operation,
        version: packet.version,
        body: packet.body.toString('utf8'),
      })),
    ).toEqual([
      { operation: 5, version: 0, body: '{"cmd":"DANMU_MSG","info":[]}' },
      { operation: 5, version: 1, body: '{"cmd":"LIVE"}' },
    ])
  })

  it('拒绝声明长度越界的包', () => {
    const malformed = Buffer.alloc(16)
    malformed.writeUInt32BE(1024, 0)
    malformed.writeUInt16BE(16, 4)

    expect(() => decodeBilibiliPackets(malformed)).toThrowError(BilibiliProtocolError)
  })
})
