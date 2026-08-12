import { describe, expect, it } from 'vitest'

import { BilibiliEventNormalizer } from '../../src/main/protocol/bilibili-web-v1/normalizer'

describe('BilibiliEventNormalizer', () => {
  const normalizer = new BilibiliEventNormalizer({
    sessionId: 7,
    hmacKey: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
    now: () => 1_780_000_000_500,
  })

  it('把合成弹幕转换为不含原始UID的内部事件', () => {
    const result = normalizer.normalizeBusinessMessage({
      cmd: 'DANMU_MSG:4:0:2',
      info: [
        [0, 0, 0, 0, 1_780_000_000_000, 'synthetic-message-1'],
        '  你\u0000好世界  ',
        ['synthetic-user-1', '测试用户'],
        [12, '测试牌'],
      ],
    })

    expect(result).toMatchObject({
      kind: 'event',
      event: {
        type: 'danmaku',
        sessionId: 7,
        receivedAtMs: 1_780_000_000_500,
        sentAtMs: 1_780_000_000_000,
        displayName: '测试用户',
        text: '你好世界',
        medalName: '测试牌',
        medalLevel: 12,
      },
    })
    if (result.kind !== 'event' || result.event.type !== 'danmaku') throw new Error('unexpected')
    expect(result.event.localUserKey).toHaveLength(16)
    expect(result.event.sourceEventKey).toHaveLength(16)
    expect(JSON.stringify(result)).not.toContain('synthetic-user-1')
  })

  it('规范化礼物、醒目留言和直播状态', () => {
    expect(
      normalizer.normalizeBusinessMessage({
        cmd: 'SEND_GIFT',
        data: {
          uid: 'synthetic-user-2',
          uname: '送礼用户',
          giftName: '小花',
          num: 2,
          price: 1_000,
          coin_type: 'gold',
          tid: 'synthetic-gift-1',
          timestamp: 1_780_000_001,
        },
      }),
    ).toMatchObject({
      kind: 'event',
      event: {
        type: 'gift',
        quantity: 2,
        unitValueMilliCny: 1_000,
        totalValueMilliCny: 2_000,
      },
    })

    expect(
      normalizer.normalizeBusinessMessage({
        cmd: 'SUPER_CHAT_MESSAGE',
        data: {
          id: 'synthetic-sc-1',
          uid: 'synthetic-user-3',
          user_info: { uname: 'SC用户' },
          message: '支持主播',
          price: 30,
          start_time: 1_780_000_001,
          end_time: 1_780_000_061,
        },
      }),
    ).toMatchObject({
      kind: 'event',
      event: { type: 'super_chat', valueMilliCny: 30_000, expiresAtMs: 1_780_000_061_000 },
    })

    expect(normalizer.normalizeBusinessMessage({ cmd: 'LIVE' })).toEqual({
      kind: 'signal',
      signal: 'live',
    })
    expect(normalizer.normalizeBusinessMessage({ cmd: 'PREPARING' })).toEqual({
      kind: 'signal',
      signal: 'preparing',
    })
  })
})
