import { describe, expect, it } from 'vitest'

import { createDouyinProbeSummary } from '../../src/main/protocol/douyin-web-v1/probe-summary'

describe('createDouyinProbeSummary', () => {
  it('只输出固定验证字段并把未知方法合并计数', () => {
    const evidence = {
      homePageReached: true,
      roomPageReached: true,
      websocketOpened: 1,
      websocketClosed: 0,
      receivedFrames: 4,
      sentFrames: 3,
      sentAckFrames: 2,
      sentHeartbeatFrames: 1,
      sentUnknownFrames: 0,
      decodedFrames: 3,
      gzipFrames: 3,
      plainFrames: 0,
      ackRequiredFrames: 2,
      decodedChatPayloads: 2,
      methodCounts: {
        WebcastChatMessage: 2,
        UnexpectedUserDerivedValue: 7,
      },
      decodeErrorCounts: {
        MALFORMED_PROTOBUF: 1,
        UserDerivedError: 3,
      },
      durationMs: 30_000,
      roomId: 'must-not-appear',
      roomUrl: 'https://example.invalid/must-not-appear',
      cookie: 'must-not-appear',
    }

    const summary = createDouyinProbeSummary(evidence)

    expect(summary).toEqual({
      schemaVersion: 1,
      status: 'ok',
      checks: {
        homePageReached: true,
        roomPageReached: true,
        websocketOpened: 1,
        websocketClosed: 0,
      },
      frames: {
        received: 4,
        sent: 3,
        outbound: { ack: 2, heartbeat: 1, unknown: 0 },
        decoded: 3,
        failed: 1,
        compression: { gzip: 3, none: 0 },
        ackRequired: 2,
      },
      messages: {
        WebcastChatMessage: 2,
        unknown: 7,
      },
      decodedChatPayloads: 2,
      decodeErrors: {
        MALFORMED_PROTOBUF: 1,
        unknown: 3,
      },
      durationMs: 30_000,
    })
    expect(JSON.stringify(summary)).not.toContain('must-not-appear')
  })
})
