import { describe, expect, it } from 'vitest'

import { parseDouyinRoomInput } from '../../src/main/protocol/douyin-web-v1/room-input'

describe('parseDouyinRoomInput', () => {
  it('只接受纯数字web_rid和抖音直播HTTPS链接', () => {
    expect(parseDouyinRoomInput(' 123456 ')).toEqual({
      roomDisplay: '123456',
      url: 'https://live.douyin.com/123456',
    })
    expect(parseDouyinRoomInput('https://live.douyin.com/987654?enter_from=web')).toEqual({
      roomDisplay: '987654',
      url: 'https://live.douyin.com/987654',
    })
    expect(parseDouyinRoomInput('https://example.com/123456')).toBeNull()
    expect(parseDouyinRoomInput('http://live.douyin.com/123456')).toBeNull()
    expect(parseDouyinRoomInput('123/456')).toBeNull()
  })
})
