import { describe, expect, it } from 'vitest'

import { parseDomainEvent } from '../../src/domain/events'

const key = new Uint8Array(16).fill(7)

describe('parseDomainEvent', () => {
  it('接受规范化弹幕并拒绝上游字段和非法本地键', () => {
    const event = parseDomainEvent({
      type: 'danmaku',
      sessionId: 12,
      sourceEventKey: key,
      receivedAtMs: 1_780_000_000_000,
      sentAtMs: null,
      localUserKey: key,
      displayName: '合成用户',
      text: '合成弹幕',
      medalName: null,
      medalLevel: null,
    })

    expect(event.type).toBe('danmaku')
    expect(event).not.toHaveProperty('rawUid')

    expect(() =>
      parseDomainEvent({
        ...event,
        rawUid: 'fixture_raw_uid_987654321',
      }),
    ).toThrow()

    expect(() =>
      parseDomainEvent({
        ...event,
        localUserKey: new Uint8Array(15),
      }),
    ).toThrow()
  })
})
