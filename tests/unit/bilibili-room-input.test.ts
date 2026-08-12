import { describe, expect, it } from 'vitest'

import { parseBilibiliRoomInput } from '../../src/main/protocol/bilibili-web-v1/room-input'

describe('parseBilibiliRoomInput', () => {
  it('接受房间号和B站直播链接', () => {
    expect(parseBilibiliRoomInput('  12345  ')).toEqual({ roomId: '12345' })
    expect(parseBilibiliRoomInput('https://live.bilibili.com/67890?spm_id_from=333')).toEqual({
      roomId: '67890',
    })
  })

  it('拒绝其他站点、负数和过长输入', () => {
    expect(parseBilibiliRoomInput('https://example.com/12345')).toBeNull()
    expect(parseBilibiliRoomInput('-1')).toBeNull()
    expect(parseBilibiliRoomInput('1'.repeat(21))).toBeNull()
  })
})
