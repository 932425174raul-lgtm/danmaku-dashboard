import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

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

  it('结束场次生成可追溯的弹幕复盘与分时活跃发言趋势', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'danmaku-dashboard-review-'))
    temporaryDirectories.push(directory)
    const store = new LocalStore(join(directory, 'library.sqlite3'))
    store.initialize()
    const startedAtMs = 1_780_000_000_000
    const session = store.createSession({
      platform: 'bilibili',
      roomId: 'review-room',
      roomTitle: '复盘合成直播间',
      adapterVersion: 'bilibili-web-v1',
      startedAtMs,
    })
    const userA = Uint8Array.from({ length: 16 }, (_, index) => index + 1)
    const userB = Uint8Array.from({ length: 16 }, (_, index) => index + 17)
    const events: DanmakuEvent[] = [
      {
        type: 'danmaku',
        sessionId: session.id,
        sourceEventKey: null,
        receivedAtMs: startedAtMs + 30_000,
        sentAtMs: null,
        localUserKey: userA,
        displayName: '观众甲',
        text: '再讲一遍',
        medalName: null,
        medalLevel: null,
      },
      {
        type: 'danmaku',
        sessionId: session.id,
        sourceEventKey: null,
        receivedAtMs: startedAtMs + 60_000,
        sentAtMs: null,
        localUserKey: userB,
        displayName: '观众乙',
        text: '再讲一遍',
        medalName: null,
        medalLevel: null,
      },
      {
        type: 'danmaku',
        sessionId: session.id,
        sourceEventKey: null,
        receivedAtMs: startedAtMs + 330_000,
        sentAtMs: null,
        localUserKey: userA,
        displayName: '观众甲',
        text: '这个案例很好',
        medalName: null,
        medalLevel: null,
      },
    ]
    store.appendEvents(session.id, events)
    store.openGap(session.id, 'network', startedAtMs + 340_000)
    store.closeGap(session.id, startedAtMs + 350_000, true)
    store.finalizeSession(session.id, 'user_stop', startedAtMs + 600_000)

    const review = store.getSessionReview(session.id)
    expect(review).toMatchObject({
      sessionId: session.id,
      bucketMinutes: 5,
      totals: { danmakuCount: 3, activeUserCount: 2, gapCount: 1 },
      mostRepeatedDanmaku: {
        text: '再讲一遍',
        count: 2,
        uniqueUserCount: 2,
      },
      peakDanmakuBucket: { danmakuCount: 2, activeSpeakerCount: 2 },
      peakActiveSpeakerBucket: { danmakuCount: 2, activeSpeakerCount: 2 },
    })
    expect(review?.repeatedDanmaku).toHaveLength(1)
    expect(review?.buckets).toMatchObject([
      { danmakuCount: 2, activeSpeakerCount: 2, hasGap: false },
      { danmakuCount: 1, activeSpeakerCount: 1, hasGap: true },
    ])
    expect(review?.topThreeDanmakuShare).toBe(1)
    store.close()
  })

  it('活动场次不生成最终复盘', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'danmaku-dashboard-active-review-'))
    temporaryDirectories.push(directory)
    const store = new LocalStore(join(directory, 'library.sqlite3'))
    store.initialize()
    const session = store.createSession({
      platform: 'bilibili',
      roomId: 'active-room',
      roomTitle: '进行中的合成直播间',
      adapterVersion: 'bilibili-web-v1',
      startedAtMs: 1_780_000_000_000,
    })

    expect(store.getSessionReview(session.id)).toBeNull()
    store.close()
  })

  it('超过12小时的场次会自动放大时间格并限制144格', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'danmaku-dashboard-long-review-'))
    temporaryDirectories.push(directory)
    const store = new LocalStore(join(directory, 'library.sqlite3'))
    store.initialize()
    const startedAtMs = 1_780_000_000_000
    const session = store.createSession({
      platform: 'bilibili',
      roomId: 'long-room',
      roomTitle: '超长合成直播间',
      adapterVersion: 'bilibili-web-v1',
      startedAtMs,
    })
    store.finalizeSession(session.id, 'user_stop', startedAtMs + 24 * 60 * 60 * 1_000)

    const review = store.getSessionReview(session.id)
    expect(review).toMatchObject({ bucketMinutes: 10 })
    expect(review?.buckets).toHaveLength(144)
    expect(review?.buckets[0]).toMatchObject({ bucketStartMs: startedAtMs })
    expect(review?.buckets.at(-1)).toMatchObject({
      bucketEndMs: startedAtMs + 24 * 60 * 60 * 1_000,
    })
    store.close()
  })

  it('会把现有v3数据库升级到支持复盘索引的v4', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'danmaku-dashboard-review-migration-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'library.sqlite3')
    const store = new LocalStore(databasePath)
    store.initialize()
    store.close()

    const legacy = new DatabaseSync(databasePath)
    const checksum = legacy
      .prepare('SELECT checksum FROM schema_migrations WHERE version = 4')
      .get() as { checksum: string }
    legacy.exec(`
      DROP INDEX danmaku_review_text;
      DELETE FROM schema_migrations WHERE version = 4;
      INSERT INTO schema_migrations(version, name, checksum, applied_at_ms)
      VALUES (3, 'storage-worker-and-deletion-index', '${checksum.checksum}', 1);
      PRAGMA user_version = 3;
    `)
    legacy.close()

    const upgraded = new LocalStore(databasePath)
    upgraded.initialize()
    upgraded.close()
    const verified = new DatabaseSync(databasePath, { readOnly: true })
    const version = verified.prepare('PRAGMA user_version').get() as { user_version: number }
    const index = verified
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get('danmaku_review_text')
    expect(version.user_version).toBe(4)
    expect(index).toBeDefined()
    verified.close()
  })
})
