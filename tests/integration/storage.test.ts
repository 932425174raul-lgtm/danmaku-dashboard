import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { DanmakuEvent } from '../../src/domain/events'
import { LocalStore } from '../../src/main/storage/local-store'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

describe('LocalStore', () => {
  it('删除先逻辑隐藏会话，再以有界批次物理清理', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'danmaku-dashboard-delete-'))
    temporaryDirectories.push(directory)
    const store = new LocalStore(join(directory, 'library.sqlite3'))
    store.initialize()
    const session = store.createSession({
      platform: 'bilibili',
      roomId: '54321',
      roomTitle: '待删除直播间',
      adapterVersion: 'bilibili-web-v1',
      startedAtMs: 1_780_000_000_000,
    })
    const events: DanmakuEvent[] = [0, 1].map((index) => ({
      type: 'danmaku',
      sessionId: session.id,
      sourceEventKey: null,
      receivedAtMs: 1_780_000_000_100 + index,
      sentAtMs: null,
      localUserKey: null,
      displayName: '观众',
      text: `待删除${index}`,
      medalName: null,
      medalLevel: null,
    }))
    store.appendEvents(session.id, events)
    store.finalizeSession(session.id, 'user_stop', 1_780_000_001_000)

    expect(store.prepareDeletion(session.id, 1_780_000_002_000)).toEqual({
      sessionId: session.id,
      accepted: true,
    })
    expect(store.listSessions()).toEqual([])
    expect(store.listDanmaku(session.id, { limit: 100 })).toEqual([])
    expect(store.confirmDeletion(session.id, 1)).toMatchObject({ done: false, deletedRows: 1 })

    let result = store.confirmDeletion(session.id, 1)
    while (!result.done) result = store.confirmDeletion(session.id, 1)
    expect(result.done).toBe(true)
    store.close()
  })

  it('重连期间重复打开同一数据缺口只累加重试次数', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'danmaku-dashboard-gap-'))
    temporaryDirectories.push(directory)
    const store = new LocalStore(join(directory, 'library.sqlite3'))
    store.initialize()
    const session = store.createSession({
      platform: 'bilibili',
      roomId: '12345',
      roomTitle: '合成直播间',
      adapterVersion: 'bilibili-web-v1',
      startedAtMs: 1_780_000_000_000,
    })

    const opened = store.openGap(session.id, 'network', 1_780_000_001_000)
    const retried = store.openGap(session.id, 'heartbeat_timeout', 1_780_000_001_500)
    const closed = store.closeGap(session.id, 1_780_000_003_000, true)

    expect(retried).toMatchObject({
      id: opened.id,
      firstReason: 'network',
      lastReason: 'heartbeat_timeout',
      retryCount: 1,
    })
    expect(closed).toMatchObject({
      id: opened.id,
      endedAtMs: 1_780_000_003_000,
      recovered: true,
    })
    expect(store.closeGap(session.id, 1_780_000_004_000, true)).toBeNull()
    store.finalizeSession(session.id, 'user_stop', 1_780_000_005_000)
    expect(store.listSessions()).toMatchObject([{ gapCount: 1, gapDurationMs: 2_000 }])
    store.close()
  })

  it('重启后会关闭异常中断会话的未完成缺口', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'danmaku-dashboard-interrupted-gap-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'library.sqlite3')
    let store = new LocalStore(databasePath)
    store.initialize()
    const session = store.createSession({
      platform: 'bilibili',
      roomId: '12345',
      roomTitle: '合成直播间',
      adapterVersion: 'bilibili-web-v1',
      startedAtMs: 1_780_000_000_000,
    })
    store.openGap(session.id, 'network', 1_780_000_002_000)
    store.close()

    store = new LocalStore(databasePath)
    store.initialize()
    expect(store.listSessions()).toMatchObject([
      {
        id: session.id,
        status: 'interrupted',
        endReason: 'process_interrupted',
        endedAtMs: 1_780_000_002_000,
        gapCount: 1,
        gapDurationMs: 0,
      },
    ])
    store.close()
  })

  it('持久化会话与弹幕，重启后可搜索并可删除整场', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'danmaku-dashboard-storage-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'library.sqlite3')

    let store = new LocalStore(databasePath)
    store.initialize()
    const session = store.createSession({
      platform: 'bilibili',
      roomId: '12345',
      inputRoomId: '12345',
      roomTitle: '合成直播间',
      anchorDisplayName: '测试主播',
      adapterVersion: 'bilibili-web-v1',
      startedAtMs: 1_780_000_000_000,
    })

    const events: DanmakuEvent[] = [
      {
        type: 'danmaku',
        sessionId: session.id,
        sourceEventKey: Uint8Array.from({ length: 16 }, (_, index) => index),
        receivedAtMs: 1_780_000_000_100,
        sentAtMs: null,
        localUserKey: Uint8Array.from({ length: 16 }, (_, index) => index + 16),
        displayName: '测试用户',
        text: '今天直播真精彩',
        medalName: null,
        medalLevel: null,
      },
      {
        type: 'danmaku',
        sessionId: session.id,
        sourceEventKey: null,
        receivedAtMs: 1_780_000_000_200,
        sentAtMs: null,
        localUserKey: null,
        displayName: '匿名用户',
        text: '精彩继续',
        medalName: '合成牌',
        medalLevel: 3,
      },
    ]

    const committed = store.appendEvents(session.id, events)
    expect(committed.insertedCounts.danmaku).toBe(2)
    expect(committed.activeUserCount).toBe(1)
    expect(committed.committedEvents).toEqual(events)
    const duplicate = store.appendEvents(session.id, [events[0]!])
    expect(duplicate.insertedCounts.danmaku).toBe(0)
    expect(duplicate.committedEvents).toEqual([])
    store.finalizeSession(session.id, 'user_stop', 1_780_000_001_000)
    store.close()

    store = new LocalStore(databasePath)
    store.initialize()
    expect(store.listSessions()).toMatchObject([
      {
        id: session.id,
        platform: 'bilibili',
        roomId: '12345',
        status: 'completed',
        danmakuCount: 2,
        activeUserCount: 1,
      },
    ])
    expect(store.listDanmaku(session.id, { limit: 100 })).toHaveLength(2)
    const newest = store.listDanmaku(session.id, { limit: 1 })
    expect(newest).toMatchObject([{ text: '精彩继续' }])
    expect(
      store.listDanmaku(session.id, {
        limit: 1,
        before: { receivedAtMs: newest[0]!.receivedAtMs, id: newest[0]!.id },
      }),
    ).toMatchObject([{ text: '今天直播真精彩' }])
    expect(store.searchDanmaku(session.id, '真精彩', { limit: 100 })).toMatchObject([
      { displayName: '测试用户', text: '今天直播真精彩' },
    ])

    store.deleteSession(session.id)
    expect(store.listSessions()).toEqual([])
    expect(store.listDanmaku(session.id, { limit: 100 })).toEqual([])
    store.close()
  })
})
