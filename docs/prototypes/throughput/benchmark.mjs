// PROTOTYPE：使用合成事件和临时SQLite验证单写worker、批量事务与有界实时投影。

import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from 'node:worker_threads'
import { RealtimeProjection, SpaceSaving } from './aggregation.mjs'

const EVENT_RATE_FOR_LOGICAL_TIME = 200
const BATCH_LIMIT = 500
const FLUSH_INTERVAL_MS = 100
const QUEUE_LIMIT = 20_000
const IPC_LIMIT_BYTES = 256 * 1024
const RUN_ID = 'synthetic-run'
const SESSION_ID = 1
const SYNTHETIC_START_MS = Date.UTC(2026, 0, 1)

if (isMainThread) {
  await runBenchmark()
} else {
  runWriterWorker()
}

async function runBenchmark() {
  const options = parseArguments(process.argv.slice(2))
  const profile = resolveProfile(options)
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'danmaku-throughput-prototype-'))
  const databasePath = join(temporaryDirectory, 'PROTOTYPE-wipe-me.sqlite')
  const writer = createWriter(databasePath)
  const loopDelay = monitorEventLoopDelay({ resolution: 10 })
  const projection = new RealtimeProjection()
  const observations = createObservations(profile)
  const memoryTimer = setInterval(() => recordMemory(observations), 1_000)

  loopDelay.enable()

  try {
    await writer.call('initialize', {
      startedAtMs: SYNTHETIC_START_MS,
      profile: profile.name,
    })

    if (profile.mode === 'accelerated') {
      await runAccelerated(profile, writer, projection, observations)
    } else {
      await runTimed(profile, writer, projection, observations)
    }
    observations.collectionElapsedMs ??=
      performance.now() - observations.startedAt

    const writerSummary = await writer.call('finalize', {
      endedAtMs: observations.lastReceivedAtMs ?? SYNTHETIC_START_MS,
    })
    await writer.stop()

    clearInterval(memoryTimer)
    loopDelay.disable()
    observations.lastWorkerHeapUsedBytes = writerSummary.workerHeapUsedBytes
    recordMemory(observations)

    const queries = measureQueries(databasePath)
    const summary = buildSummary({
      profile,
      databasePath,
      projection,
      observations,
      writerSummary,
      queries,
      loopDelay,
    })

    process.stdout.write('\n')
    console.log(JSON.stringify(summary, null, 2))

    if (!summary.acceptance.passed) {
      process.exitCode = 1
    }
  } finally {
    clearInterval(memoryTimer)
    loopDelay.disable()
    await writer.stop()

    if (options.keepDb) {
      console.log(`临时数据库保留在：${databasePath}`)
    } else {
      rmSync(temporaryDirectory, { recursive: true, force: true })
    }
  }
}

function parseArguments(argumentsList) {
  const values = {
    profile: 'smoke',
    durationSeconds: null,
    rate: null,
    total: null,
    keepDb: false,
  }

  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index]
    if (argument === '--keep-db') {
      values.keepDb = true
      continue
    }

    const next = argumentsList[index + 1]
    if (argument === '--profile') values.profile = next
    else if (argument === '--duration-seconds') values.durationSeconds = Number(next)
    else if (argument === '--rate') values.rate = Number(next)
    else if (argument === '--total') values.total = Number(next)
    else throw new Error(`未知参数：${argument}`)
    index += 1
  }

  if (!['smoke', 'million', 'sustained', 'soak'].includes(values.profile)) {
    throw new Error(`未知profile：${values.profile}`)
  }

  return values
}

function resolveProfile(options) {
  if (options.profile === 'smoke') {
    return {
      name: 'smoke',
      mode: 'accelerated',
      totalEvents: options.total ?? 20_000,
      logicalRate: EVENT_RATE_FOR_LOGICAL_TIME,
    }
  }

  if (options.profile === 'million') {
    return {
      name: 'million',
      mode: 'accelerated',
      totalEvents: options.total ?? 1_000_000,
      logicalRate: EVENT_RATE_FOR_LOGICAL_TIME,
    }
  }

  if (options.profile === 'sustained') {
    return {
      name: 'sustained',
      mode: 'timed',
      durationSeconds: options.durationSeconds ?? 600,
      baseRate: options.rate ?? 200,
      burstRate: null,
      burstSeconds: 0,
      burstEverySeconds: 0,
    }
  }

  return {
    name: 'soak',
    mode: 'timed',
    durationSeconds: options.durationSeconds ?? 43_200,
    baseRate: options.rate ?? 20,
    burstRate: 200,
    burstSeconds: 60,
    burstEverySeconds: 900,
  }
}

function createObservations(profile) {
  return {
    profile,
    startedAt: performance.now(),
    generatedEvents: 0,
    committedEvents: 0,
    lastReceivedAtMs: null,
    maxQueueDepth: 0,
    queueOverflow: false,
    writerRoundTripsMs: [],
    writerCommitMs: [],
    ipcPayloadBytes: [],
    ipcPushes: 0,
    analysisPushes: 0,
    maxDisplaySkippedCount: 0,
    lastIpcLogicalMs: -Infinity,
    lastAnalysisLogicalMs: -Infinity,
    revision: 0,
    memory: {
      sampleCount: 0,
      first: null,
      last: null,
      regression: {
        count: 0,
        sumX: 0,
        sumY: 0,
        sumXY: 0,
        sumXX: 0,
      },
    },
    lastWorkerHeapUsedBytes: 0,
    lastProgressAt: 0,
  }
}

function createWriter(databasePath) {
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { role: 'writer', databasePath },
  })
  const pending = new Map()
  let nextRequestId = 1
  let stopped = false

  worker.on('message', (message) => {
    const request = pending.get(message.requestId)
    if (!request) return
    pending.delete(message.requestId)
    if (message.ok) request.resolve(message.data)
    else request.reject(new Error(message.error))
  })

  worker.on('error', (error) => {
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  })

  worker.on('exit', (code) => {
    if (stopped) return
    const error = new Error(`writer意外退出，退出码${code}`)
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  })

  return {
    call(type, payload) {
      if (stopped) throw new Error('writer已经停止')
      const requestId = nextRequestId
      nextRequestId += 1
      return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject })
        worker.postMessage({ requestId, type, payload })
      })
    },
    async stop() {
      if (stopped) return
      stopped = true
      for (const request of pending.values()) {
        request.reject(new Error('writer提前停止'))
      }
      pending.clear()
      await worker.terminate()
    },
  }
}

async function runAccelerated(profile, writer, projection, observations) {
  while (observations.generatedEvents < profile.totalEvents) {
    const batchSize = Math.min(
      BATCH_LIMIT,
      profile.totalEvents - observations.generatedEvents,
    )
    const batch = []
    for (let offset = 0; offset < batchSize; offset += 1) {
      const eventIndex = observations.generatedEvents + offset
      batch.push(
        createSyntheticEvent(
          eventIndex,
          SYNTHETIC_START_MS +
            Math.floor((eventIndex / profile.logicalRate) * 1_000),
        ),
      )
    }

    observations.generatedEvents += batch.length
    observations.maxQueueDepth = Math.max(observations.maxQueueDepth, batch.length)
    await commitBatch(batch, writer, projection, observations)
    renderProgress(profile, observations)
  }
}

async function runTimed(profile, writer, projection, observations) {
  const queue = []
  let generating = true
  let inFlight = false
  const generationStartedAt = performance.now()
  observations.generationStartedAt = generationStartedAt
  const durationMs = profile.durationSeconds * 1_000
  let previousElapsedMs = 0
  let lastFlushAt = generationStartedAt

  await new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const now = performance.now()
      const rawElapsedMs = now - generationStartedAt
      const elapsedMs = Math.min(rawElapsedMs, durationMs)
      const deltaMs = elapsedMs - previousElapsedMs

      if (deltaMs > 0) {
        const scheduledTotal = Math.floor(
          scheduledEventsUntil(profile, elapsedMs / 1_000) + 1e-9,
        )
        const eventCount = scheduledTotal - observations.generatedEvents

        for (let index = 0; index < eventCount; index += 1) {
          const receivedAtMs =
            SYNTHETIC_START_MS + Math.floor(previousElapsedMs) +
            Math.floor((index / Math.max(eventCount, 1)) * deltaMs)
          queue.push(createSyntheticEvent(observations.generatedEvents, receivedAtMs))
          observations.generatedEvents += 1
        }

        previousElapsedMs = elapsedMs
        observations.maxQueueDepth = Math.max(observations.maxQueueDepth, queue.length)
        if (queue.length > QUEUE_LIMIT) {
          observations.queueOverflow = true
          clearInterval(timer)
          reject(new Error(`接收队列超过${QUEUE_LIMIT}条`))
          return
        }
      }

      if (rawElapsedMs >= durationMs) {
        generating = false
        observations.collectionElapsedMs = durationMs
      }

      const shouldFlush =
        queue.length >= BATCH_LIMIT ||
        (!inFlight &&
          queue.length > 0 &&
          (now - lastFlushAt >= FLUSH_INTERVAL_MS || !generating))

      if (shouldFlush && !inFlight) {
        inFlight = true
        lastFlushAt = now
        const batch = queue.splice(0, BATCH_LIMIT)
        commitBatch(batch, writer, projection, observations)
          .then(() => {
            inFlight = false
            renderProgress(profile, observations)
            if (!generating && queue.length === 0) {
              clearInterval(timer)
              resolve()
            }
          })
          .catch((error) => {
            clearInterval(timer)
            reject(error)
          })
      } else if (!generating && queue.length === 0 && !inFlight) {
        clearInterval(timer)
        resolve()
      }
    }, 10)
  })
}

function scheduledEventsUntil(profile, elapsedSeconds) {
  if (!profile.burstRate) return profile.baseRate * elapsedSeconds

  const fullCycles = Math.floor(
    elapsedSeconds / profile.burstEverySeconds,
  )
  const remainder = elapsedSeconds % profile.burstEverySeconds
  const burstSeconds =
    fullCycles * profile.burstSeconds +
    Math.min(remainder, profile.burstSeconds)
  return (
    profile.baseRate * elapsedSeconds +
    (profile.burstRate - profile.baseRate) * burstSeconds
  )
}

async function commitBatch(batch, writer, projection, observations) {
  const roundTripStartedAt = performance.now()
  const result = await writer.call('appendBatch', { events: batch })
  observations.writerRoundTripsMs.push(performance.now() - roundTripStartedAt)
  observations.writerCommitMs.push(result.commitMs)
  observations.committedEvents += result.committedCount
  observations.lastReceivedAtMs = result.highWatermark.receivedAtMs
  observations.lastWorkerHeapUsedBytes = result.workerHeapUsedBytes
  observations.revision += 1

  projection.consume(result.projectionDelta)
  const logicalMs = result.highWatermark.receivedAtMs - SYNTHETIC_START_MS
  if (logicalMs - observations.lastIpcLogicalMs >= 250) {
    const includeAnalysis =
      logicalMs - observations.lastAnalysisLogicalMs >= 1_000
    const payload = projection.takeIpcPayload({
      runId: RUN_ID,
      revision: observations.revision,
      highWatermark: result.highWatermark,
      includeAnalysis,
    })
    const payloadBytes = Buffer.byteLength(JSON.stringify(payload))
    observations.ipcPayloadBytes.push(payloadBytes)
    observations.ipcPushes += 1
    observations.maxDisplaySkippedCount = Math.max(
      observations.maxDisplaySkippedCount,
      payload.displaySkippedCount,
    )
    observations.lastIpcLogicalMs = logicalMs
    if (includeAnalysis) {
      observations.lastAnalysisLogicalMs = logicalMs
      observations.analysisPushes += 1
    }
  }
}

function renderProgress(profile, observations) {
  const now = performance.now()
  const isComplete =
    profile.mode === 'accelerated' &&
    observations.committedEvents === profile.totalEvents
  if (!isComplete && now - observations.lastProgressAt < 1_000) return
  observations.lastProgressAt = now

  const elapsedSeconds = (now - observations.startedAt) / 1_000
  const rate = observations.committedEvents / Math.max(elapsedSeconds, 0.001)
  const target =
    profile.mode === 'accelerated'
      ? profile.totalEvents
      : Math.max(observations.generatedEvents, 1)
  const percent =
    profile.mode === 'accelerated'
      ? Math.min(100, (observations.committedEvents / target) * 100)
      : Math.min(
          100,
          ((now - observations.generationStartedAt) /
            (profile.durationSeconds * 1_000)) *
            100,
        )
  const memoryMiB = process.memoryUsage().rss / 1024 / 1024
  process.stdout.write(
    `\r${profile.name} ${percent.toFixed(1)}%｜${observations.committedEvents.toLocaleString()}条｜${rate.toFixed(0)}条/秒｜队列峰值${observations.maxQueueDepth}｜RSS ${memoryMiB.toFixed(1)}MiB`,
  )
}

function createSyntheticEvent(index, receivedAtMs) {
  const selector = index % 100
  const common = {
    id: index + 1,
    receivedAtMs,
    sourceEventKey: fixedKey(index + 1),
  }

  if (selector < 90) {
    const userNumber = index % 50_000
    return {
      ...common,
      type: 'danmaku',
      localUserKey: fixedKey(userNumber + 1),
      displayName: `合成观众${String(userNumber).padStart(5, '0')}`,
      text: syntheticText(index),
    }
  }

  if (selector < 95) {
    return {
      ...common,
      type: 'gift',
      quantity: 1 + (index % 5),
      knownValueMilliCny: index % 4 === 0 ? null : 1_000 + (index % 20) * 500,
    }
  }

  if (selector === 95) {
    return {
      ...common,
      type: 'superChat',
      priceMilliCny: 30_000 + (index % 10) * 10_000,
    }
  }

  return {
    ...common,
    type: 'popularity',
    popularity: 10_000 + ((index * 97) % 500_000),
  }
}

function fixedKey(value) {
  const key = new Uint8Array(16)
  const view = new DataView(key.buffer)
  view.setUint32(12, value >>> 0)
  return key
}

function syntheticText(index) {
  const words = [
    '直播',
    '弹幕',
    '看板',
    '测试',
    '数据',
    '连接',
    '礼物',
    '主播',
    '今天',
    '不错',
    '喜欢',
    '继续',
    '声音',
    '画面',
    '实时',
    '统计',
  ]
  const first = words[index % words.length]
  const second = words[(index * 7 + 3) % words.length]
  const third = words[(index * 11 + 5) % words.length]
  const rare =
    index % 20 === 0
      ? ` rare${(index % 100_000).toString(36).padStart(4, '0')}`
      : ''
  const long = index % 2_000 === 0 ? ` ${'长文本 '.repeat(40)}` : ''
  return `${first} ${second} ${third}${rare}${long}`.trim()
}

function runWriterWorker() {
  if (workerData?.role !== 'writer') throw new Error('未知worker角色')

  const databasePath = workerData.databasePath
  let database
  let statements
  let sessionKeywordTracker
  let segmenter
  let lastKeywordPersistedAtMs = -Infinity
  let batchNumber = 0
  let maxWalBytes = 0

  parentPort.on('message', (request) => {
    try {
      let data
      if (request.type === 'initialize') {
        database = openWriterDatabase(databasePath)
        statements = prepareStatements(database)
        sessionKeywordTracker = new SpaceSaving(128)
        segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })
        initializeSession(database, request.payload.startedAtMs)
        data = { ready: true }
      } else if (request.type === 'appendBatch') {
        data = appendBatch(request.payload.events)
      } else if (request.type === 'finalize') {
        data = finalize(request.payload.endedAtMs)
      } else {
        throw new Error(`未知writer命令：${request.type}`)
      }
      parentPort.postMessage({ requestId: request.requestId, ok: true, data })
    } catch (error) {
      parentPort.postMessage({
        requestId: request.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  function appendBatch(events) {
    const startedAt = performance.now()
    const batchCounts = {
      danmaku: 0,
      gift: 0,
      giftEvents: 0,
      superChat: 0,
      popularity: 0,
      giftKnownValueMilliCny: 0,
      giftUnknownValueCount: 0,
      superChatValueMilliCny: 0,
      lastPopularity: null,
      peakPopularity: null,
      lastMessageAtMs: null,
    }
    const users = new Map()
    const buckets = new Map()
    const newDanmaku = []

    database.exec('BEGIN IMMEDIATE')
    try {
      for (const event of events) {
        const bucketStartMs =
          Math.floor(event.receivedAtMs / 10_000) * 10_000
        const bucket = buckets.get(bucketStartMs) ?? {
          bucketStartMs,
          danmakuCount: 0,
          giftCount: 0,
          superChatCount: 0,
          lastPopularity: null,
          peakPopularity: null,
        }

        if (event.type === 'danmaku') {
          statements.insertDanmaku.run(
            event.id,
            SESSION_ID,
            event.sourceEventKey,
            event.receivedAtMs,
            event.localUserKey,
            event.displayName,
            event.text,
          )
          batchCounts.danmaku += 1
          bucket.danmakuCount += 1
          const userId = Buffer.from(event.localUserKey).toString('hex')
          const user = users.get(userId) ?? {
            localUserKey: event.localUserKey,
            displayName: event.displayName,
            count: 0,
            lastAtMs: event.receivedAtMs,
          }
          user.count += 1
          user.lastAtMs = event.receivedAtMs
          users.set(userId, user)
          for (const term of extractTerms(event.text, segmenter)) {
            sessionKeywordTracker.offer(term)
          }
          newDanmaku.push({
            eventId: event.id,
            receivedAtMs: event.receivedAtMs,
            displayName: event.displayName,
            text: event.text,
            medal: null,
          })
        } else if (event.type === 'gift') {
          statements.insertGift.run(
            event.id,
            SESSION_ID,
            event.sourceEventKey,
            event.receivedAtMs,
            event.quantity,
            event.knownValueMilliCny,
          )
          batchCounts.gift += event.quantity
          batchCounts.giftEvents += 1
          bucket.giftCount += event.quantity
          if (event.knownValueMilliCny === null) {
            batchCounts.giftUnknownValueCount += event.quantity
          } else {
            batchCounts.giftKnownValueMilliCny +=
              event.knownValueMilliCny * event.quantity
          }
        } else if (event.type === 'superChat') {
          statements.insertSuperChat.run(
            event.id,
            SESSION_ID,
            event.sourceEventKey,
            event.receivedAtMs,
            event.priceMilliCny,
          )
          batchCounts.superChat += 1
          batchCounts.superChatValueMilliCny += event.priceMilliCny
          bucket.superChatCount += 1
        } else {
          statements.insertPopularity.run(
            event.id,
            SESSION_ID,
            event.receivedAtMs,
            event.popularity,
          )
          batchCounts.popularity += 1
          batchCounts.lastPopularity = event.popularity
          batchCounts.peakPopularity = Math.max(
            batchCounts.peakPopularity ?? 0,
            event.popularity,
          )
          bucket.lastPopularity = event.popularity
          bucket.peakPopularity = Math.max(
            bucket.peakPopularity ?? 0,
            event.popularity,
          )
        }

        batchCounts.lastMessageAtMs = event.receivedAtMs
        buckets.set(bucketStartMs, bucket)
      }

      let newUserCount = 0
      for (const user of users.values()) {
        const row = statements.upsertUser.get(
          SESSION_ID,
          user.localUserKey,
          user.displayName,
          user.count,
          user.lastAtMs,
        )
        if (Number(row.danmaku_count) === user.count) newUserCount += 1
      }

      const bucketDeltas = []
      for (const bucket of buckets.values()) {
        const row = statements.upsertBucket.get(
          SESSION_ID,
          bucket.bucketStartMs,
          bucket.danmakuCount,
          bucket.giftCount,
          bucket.superChatCount,
          bucket.lastPopularity,
          bucket.peakPopularity,
        )
        bucketDeltas.push({
          bucketStartMs: Number(row.bucket_start_ms),
          danmakuCount: Number(row.danmaku_count),
          giftCount: Number(row.gift_count),
          superChatCount: Number(row.super_chat_count),
          lastPopularity:
            row.last_popularity === null ? null : Number(row.last_popularity),
          peakPopularity:
            row.peak_popularity === null ? null : Number(row.peak_popularity),
        })
      }

      statements.updateMetrics.run(
        batchCounts.danmaku,
        newUserCount,
        batchCounts.gift,
        batchCounts.giftEvents,
        batchCounts.giftKnownValueMilliCny,
        batchCounts.giftUnknownValueCount,
        batchCounts.superChat,
        batchCounts.superChatValueMilliCny,
        batchCounts.lastPopularity,
        batchCounts.peakPopularity,
        batchCounts.lastMessageAtMs,
        batchCounts.lastMessageAtMs,
        SESSION_ID,
      )

      const newestReceivedAtMs = events[events.length - 1].receivedAtMs
      let keywords = null
      if (newestReceivedAtMs - lastKeywordPersistedAtMs >= 1_000) {
        keywords = sessionKeywordTracker.top(10)
        statements.deleteKeywords.run(SESSION_ID)
        for (const keyword of sessionKeywordTracker.top(128)) {
          statements.insertKeyword.run(
            SESSION_ID,
            keyword.term,
            keyword.count,
            keyword.error,
            newestReceivedAtMs,
          )
        }
        lastKeywordPersistedAtMs = newestReceivedAtMs
      }

      database.exec('COMMIT')

      const metrics = normalizeMetrics(statements.getMetrics.get(SESSION_ID))
      const activeUsers =
        keywords === null
          ? null
          : statements.topUsers.all(SESSION_ID, 10).map((row) => ({
              displayName: row.display_name,
              danmakuCount: Number(row.danmaku_count),
            }))

      batchNumber += 1
      if (batchNumber % 20 === 0) {
        maxWalBytes = Math.max(maxWalBytes, fileSize(`${databasePath}-wal`))
      }
      if (batchNumber % 100 === 0) {
        database.exec('PRAGMA wal_checkpoint(PASSIVE)')
      }

      return {
        committedCount: events.length,
        commitMs: performance.now() - startedAt,
        highWatermark: {
          receivedAtMs: events[events.length - 1].receivedAtMs,
          eventId: events[events.length - 1].id,
        },
        projectionDelta: {
          newDanmaku,
          bucketDeltas,
          metrics,
          keywords,
          activeUsers,
        },
        workerHeapUsedBytes: process.memoryUsage().heapUsed,
      }
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }

  function finalize(endedAtMs) {
    statements.completeSession.run(endedAtMs, endedAtMs, SESSION_ID)
    const beforeCheckpoint = databaseSizes(databasePath)
    maxWalBytes = Math.max(maxWalBytes, beforeCheckpoint.walBytes)
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    const afterCheckpoint = databaseSizes(databasePath)
    const counts = {
      danmaku: Number(statements.countDanmaku.get().count),
      gift: Number(statements.countGift.get().count),
      superChat: Number(statements.countSuperChat.get().count),
      popularity: Number(statements.countPopularity.get().count),
      fts: Number(statements.countFts.get().count),
      users: Number(statements.countUsers.get().count),
      keywords: Number(statements.countKeywords.get().count),
      buckets: Number(statements.countBuckets.get().count),
    }
    const metrics = normalizeMetrics(statements.getMetrics.get(SESSION_ID))
    const quickCheck = statements.quickCheck.get().quick_check
    const workerHeapUsedBytes = process.memoryUsage().heapUsed
    database.close()

    return {
      beforeCheckpoint,
      afterCheckpoint,
      maxWalBytes,
      counts,
      metrics,
      quickCheck,
      keywordTrackerSize: sessionKeywordTracker.size,
      workerHeapUsedBytes,
    }
  }
}

function openWriterDatabase(databasePath) {
  const database = new DatabaseSync(databasePath)
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = MEMORY;
    PRAGMA auto_vacuum = INCREMENTAL;
    PRAGMA wal_autocheckpoint = 1000;

    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY,
      status TEXT NOT NULL,
      started_at_ms INTEGER NOT NULL,
      ended_at_ms INTEGER,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE session_metrics (
      session_id INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      danmaku_count INTEGER NOT NULL DEFAULT 0,
      active_user_count INTEGER NOT NULL DEFAULT 0,
      gift_count INTEGER NOT NULL DEFAULT 0,
      gift_event_count INTEGER NOT NULL DEFAULT 0,
      gift_known_value_milli_cny INTEGER NOT NULL DEFAULT 0,
      gift_unknown_value_count INTEGER NOT NULL DEFAULT 0,
      super_chat_count INTEGER NOT NULL DEFAULT 0,
      super_chat_value_milli_cny INTEGER NOT NULL DEFAULT 0,
      last_popularity INTEGER,
      peak_popularity INTEGER,
      last_message_at_ms INTEGER,
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE danmaku_events (
      id INTEGER PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      source_event_key BLOB,
      received_at_ms INTEGER NOT NULL,
      local_user_key BLOB,
      display_name TEXT NOT NULL,
      text TEXT NOT NULL
    );

    CREATE UNIQUE INDEX danmaku_dedup
    ON danmaku_events(session_id, source_event_key);

    CREATE INDEX danmaku_timeline
    ON danmaku_events(session_id, received_at_ms, id);

    CREATE TABLE gift_events (
      id INTEGER PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      source_event_key BLOB,
      received_at_ms INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      known_value_milli_cny INTEGER
    );

    CREATE TABLE super_chat_events (
      id INTEGER PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      source_event_key BLOB,
      received_at_ms INTEGER NOT NULL,
      price_milli_cny INTEGER NOT NULL
    );

    CREATE TABLE popularity_samples (
      id INTEGER PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      received_at_ms INTEGER NOT NULL,
      popularity INTEGER NOT NULL
    );

    CREATE TABLE session_users (
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      local_user_key BLOB NOT NULL,
      display_name TEXT NOT NULL,
      danmaku_count INTEGER NOT NULL,
      last_danmaku_at_ms INTEGER NOT NULL,
      PRIMARY KEY (session_id, local_user_key)
    ) WITHOUT ROWID;

    CREATE INDEX session_users_rank
    ON session_users(session_id, danmaku_count DESC, last_danmaku_at_ms DESC);

    CREATE TABLE metric_buckets (
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      bucket_start_ms INTEGER NOT NULL,
      danmaku_count INTEGER NOT NULL,
      gift_count INTEGER NOT NULL,
      super_chat_count INTEGER NOT NULL,
      last_popularity INTEGER,
      peak_popularity INTEGER,
      PRIMARY KEY (session_id, bucket_start_ms)
    ) WITHOUT ROWID;

    CREATE TABLE session_keywords (
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      term TEXT NOT NULL,
      estimated_count INTEGER NOT NULL,
      error_upper_bound INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (session_id, term)
    ) WITHOUT ROWID;

    CREATE INDEX session_keywords_rank
    ON session_keywords(session_id, estimated_count DESC, term);

    CREATE VIRTUAL TABLE danmaku_fts USING fts5(
      session_id UNINDEXED,
      text,
      display_name,
      content = 'danmaku_events',
      content_rowid = 'id',
      tokenize = 'trigram'
    );

    CREATE TRIGGER danmaku_fts_insert AFTER INSERT ON danmaku_events BEGIN
      INSERT INTO danmaku_fts(rowid, session_id, text, display_name)
      VALUES (new.id, new.session_id, new.text, new.display_name);
    END;

    CREATE TRIGGER danmaku_fts_delete AFTER DELETE ON danmaku_events BEGIN
      INSERT INTO danmaku_fts(danmaku_fts, rowid, session_id, text, display_name)
      VALUES ('delete', old.id, old.session_id, old.text, old.display_name);
    END;
  `)
  return database
}

function initializeSession(database, startedAtMs) {
  database
    .prepare(
      `INSERT INTO sessions(id, status, started_at_ms, updated_at_ms)
       VALUES (?, 'active', ?, ?)`,
    )
    .run(SESSION_ID, startedAtMs, startedAtMs)
  database
    .prepare(
      `INSERT INTO session_metrics(session_id, updated_at_ms)
       VALUES (?, ?)`,
    )
    .run(SESSION_ID, startedAtMs)
}

function prepareStatements(database) {
  return {
    insertDanmaku: database.prepare(`
      INSERT INTO danmaku_events(
        id, session_id, source_event_key, received_at_ms,
        local_user_key, display_name, text
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    insertGift: database.prepare(`
      INSERT INTO gift_events(
        id, session_id, source_event_key, received_at_ms,
        quantity, known_value_milli_cny
      ) VALUES (?, ?, ?, ?, ?, ?)
    `),
    insertSuperChat: database.prepare(`
      INSERT INTO super_chat_events(
        id, session_id, source_event_key, received_at_ms, price_milli_cny
      ) VALUES (?, ?, ?, ?, ?)
    `),
    insertPopularity: database.prepare(`
      INSERT INTO popularity_samples(
        id, session_id, received_at_ms, popularity
      ) VALUES (?, ?, ?, ?)
    `),
    upsertUser: database.prepare(`
      INSERT INTO session_users(
        session_id, local_user_key, display_name,
        danmaku_count, last_danmaku_at_ms
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id, local_user_key) DO UPDATE SET
        display_name = excluded.display_name,
        danmaku_count = session_users.danmaku_count + excluded.danmaku_count,
        last_danmaku_at_ms = excluded.last_danmaku_at_ms
      RETURNING danmaku_count
    `),
    upsertBucket: database.prepare(`
      INSERT INTO metric_buckets(
        session_id, bucket_start_ms, danmaku_count,
        gift_count, super_chat_count, last_popularity, peak_popularity
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, bucket_start_ms) DO UPDATE SET
        danmaku_count = metric_buckets.danmaku_count + excluded.danmaku_count,
        gift_count = metric_buckets.gift_count + excluded.gift_count,
        super_chat_count =
          metric_buckets.super_chat_count + excluded.super_chat_count,
        last_popularity =
          COALESCE(excluded.last_popularity, metric_buckets.last_popularity),
        peak_popularity = MAX(
          COALESCE(metric_buckets.peak_popularity, 0),
          COALESCE(excluded.peak_popularity, 0)
        )
      RETURNING *
    `),
    updateMetrics: database.prepare(`
      UPDATE session_metrics SET
        danmaku_count = danmaku_count + ?,
        active_user_count = active_user_count + ?,
        gift_count = gift_count + ?,
        gift_event_count = gift_event_count + ?,
        gift_known_value_milli_cny = gift_known_value_milli_cny + ?,
        gift_unknown_value_count = gift_unknown_value_count + ?,
        super_chat_count = super_chat_count + ?,
        super_chat_value_milli_cny = super_chat_value_milli_cny + ?,
        last_popularity = COALESCE(?, last_popularity),
        peak_popularity = MAX(
          COALESCE(peak_popularity, 0),
          COALESCE(?, 0)
        ),
        last_message_at_ms = ?,
        updated_at_ms = ?
      WHERE session_id = ?
    `),
    deleteKeywords: database.prepare(
      'DELETE FROM session_keywords WHERE session_id = ?',
    ),
    insertKeyword: database.prepare(`
      INSERT INTO session_keywords(
        session_id, term, estimated_count, error_upper_bound, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?)
    `),
    getMetrics: database.prepare(
      'SELECT * FROM session_metrics WHERE session_id = ?',
    ),
    topUsers: database.prepare(`
      SELECT display_name, danmaku_count
      FROM session_users
      WHERE session_id = ?
      ORDER BY danmaku_count DESC, last_danmaku_at_ms DESC
      LIMIT ?
    `),
    completeSession: database.prepare(`
      UPDATE sessions
      SET status = 'completed', ended_at_ms = ?, updated_at_ms = ?
      WHERE id = ?
    `),
    countDanmaku: database.prepare('SELECT count(*) AS count FROM danmaku_events'),
    countGift: database.prepare('SELECT count(*) AS count FROM gift_events'),
    countSuperChat: database.prepare(
      'SELECT count(*) AS count FROM super_chat_events',
    ),
    countPopularity: database.prepare(
      'SELECT count(*) AS count FROM popularity_samples',
    ),
    countFts: database.prepare('SELECT count(*) AS count FROM danmaku_fts'),
    countUsers: database.prepare('SELECT count(*) AS count FROM session_users'),
    countKeywords: database.prepare(
      'SELECT count(*) AS count FROM session_keywords',
    ),
    countBuckets: database.prepare('SELECT count(*) AS count FROM metric_buckets'),
    quickCheck: database.prepare('PRAGMA quick_check'),
  }
}

function extractTerms(text, segmenter) {
  const terms = []
  const seen = new Set()
  for (const part of segmenter.segment(text)) {
    const term = part.segment.trim().toLocaleLowerCase('zh-CN')
    const termLength = [...term].length
    if (!part.isWordLike || termLength < 2 || termLength > 16) continue
    if (seen.has(term)) continue
    if (/^\d+$/.test(term)) continue
    seen.add(term)
    terms.push(term)
    if (terms.length === 6) break
  }
  return terms
}

function normalizeMetrics(row) {
  return {
    danmakuCount: Number(row.danmaku_count),
    activeUserCount: Number(row.active_user_count),
    giftCount: Number(row.gift_count),
    giftEventCount: Number(row.gift_event_count),
    giftKnownValueMilliCny: Number(row.gift_known_value_milli_cny),
    giftUnknownValueCount: Number(row.gift_unknown_value_count),
    superChatCount: Number(row.super_chat_count),
    superChatValueMilliCny: Number(row.super_chat_value_milli_cny),
    lastPopularity:
      row.last_popularity === null ? null : Number(row.last_popularity),
    peakPopularity:
      row.peak_popularity === null ? null : Number(row.peak_popularity),
  }
}

function databaseSizes(databasePath) {
  return {
    databaseBytes: fileSize(databasePath),
    walBytes: fileSize(`${databasePath}-wal`),
    shmBytes: fileSize(`${databasePath}-shm`),
  }
}

function fileSize(path) {
  return existsSync(path) ? statSync(path).size : 0
}

function measureQueries(databasePath) {
  const queryDefinitions = [
    {
      name: 'historyFirstScreen',
      run(database) {
        return database
          .prepare(`
            SELECT s.id, s.status, s.started_at_ms, s.ended_at_ms, m.*
            FROM sessions s
            JOIN session_metrics m ON m.session_id = s.id
            WHERE s.status <> 'active'
            ORDER BY s.started_at_ms DESC, s.id DESC
            LIMIT 50
          `)
          .all()
      },
    },
    {
      name: 'danmakuFirstPage',
      run(database) {
        return database
          .prepare(`
            SELECT id, received_at_ms, display_name, text
            FROM danmaku_events
            WHERE session_id = ?
            ORDER BY received_at_ms DESC, id DESC
            LIMIT 100
          `)
          .all(SESSION_ID)
      },
    },
    {
      name: 'searchDanmaku',
      run(database) {
        return database
          .prepare(`
            WITH matches AS MATERIALIZED (
              SELECT rowid
              FROM danmaku_fts
              WHERE danmaku_fts MATCH ?
                AND rowid BETWEEN ? AND ?
            )
            SELECT d.id, d.received_at_ms, d.display_name, d.text
            FROM matches
            JOIN danmaku_events d ON d.id = matches.rowid
            WHERE d.session_id = ?
            ORDER BY d.received_at_ms DESC, d.id DESC
            LIMIT 100
          `)
          .all('"长文本"', 1, Number.MAX_SAFE_INTEGER, SESSION_ID)
      },
    },
    {
      name: 'searchDanmakuShortCommon',
      run(database) {
        return database
          .prepare(`
            SELECT id, received_at_ms, display_name, text
            FROM danmaku_events
            WHERE session_id = ?
              AND (instr(text, ?) > 0 OR instr(display_name, ?) > 0)
            ORDER BY received_at_ms DESC, id DESC
            LIMIT 100
          `)
          .all(SESSION_ID, '直播', '直播')
      },
    },
    {
      name: 'searchDanmakuShortAbsent',
      run(database) {
        return database
          .prepare(`
            SELECT id, received_at_ms, display_name, text
            FROM danmaku_events
            WHERE session_id = ?
              AND (instr(text, ?) > 0 OR instr(display_name, ?) > 0)
            ORDER BY received_at_ms DESC, id DESC
            LIMIT 100
          `)
          .all(SESSION_ID, '未见', '未见')
      },
    },
    {
      name: 'topUsers',
      run(database) {
        return database
          .prepare(`
            SELECT display_name, danmaku_count
            FROM session_users
            WHERE session_id = ?
            ORDER BY danmaku_count DESC, last_danmaku_at_ms DESC
            LIMIT 20
          `)
          .all(SESSION_ID)
      },
    },
    {
      name: 'topKeywords',
      run(database) {
        return database
          .prepare(`
            SELECT term, estimated_count, error_upper_bound
            FROM session_keywords
            WHERE session_id = ?
            ORDER BY estimated_count DESC, term
            LIMIT 30
          `)
          .all(SESSION_ID)
      },
    },
    {
      name: 'recentTrend',
      run(database) {
        return database
          .prepare(`
            SELECT *
            FROM metric_buckets
            WHERE session_id = ?
            ORDER BY bucket_start_ms DESC
            LIMIT 180
          `)
          .all(SESSION_ID)
      },
    },
  ]

  const results = {}
  for (const definition of queryDefinitions) {
    const freshStartedAt = performance.now()
    const freshDatabase = new DatabaseSync(databasePath, { readOnly: true })
    freshDatabase.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;')
    const freshRows = definition.run(freshDatabase)
    freshDatabase.close()
    const freshConnectionMs = performance.now() - freshStartedAt

    const warmDatabase = new DatabaseSync(databasePath, { readOnly: true })
    warmDatabase.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;')
    const samples = []
    let rows = freshRows
    for (let index = 0; index < 20; index += 1) {
      const startedAt = performance.now()
      rows = definition.run(warmDatabase)
      samples.push(performance.now() - startedAt)
    }
    warmDatabase.close()

    results[definition.name] = {
      freshConnectionMs: round(freshConnectionMs),
      warmP50Ms: round(percentile(samples, 0.5)),
      warmP95Ms: round(percentile(samples, 0.95)),
      rowCount: rows.length,
    }
  }

  return results
}

function buildSummary({
  profile,
  databasePath,
  projection,
  observations,
  writerSummary,
  queries,
  loopDelay,
}) {
  const elapsedMs =
    observations.collectionElapsedMs ??
    performance.now() - observations.startedAt
  const expectedMix = expectedEventMix(observations.generatedEvents)
  const expectedScheduledEvents =
    profile.mode === 'timed'
      ? Math.floor(
          scheduledEventsUntil(profile, profile.durationSeconds) + 1e-9,
        )
      : profile.totalEvents
  const totalFacts =
    writerSummary.counts.danmaku +
    writerSummary.counts.gift +
    writerSummary.counts.superChat +
    writerSummary.counts.popularity
  const bounds = projection.bounds()
  const memorySlopeMiBPerHour = calculateMemorySlope(
    observations.memory.regression,
  )
  const eventLoopP99Ms = Number.isFinite(loopDelay.percentile(99))
    ? loopDelay.percentile(99) / 1_000_000
    : 0
  const maxIpcPayloadBytes = Math.max(0, ...observations.ipcPayloadBytes)
  const commitP99Ms = percentile(observations.writerCommitMs, 0.99)
  const roundTripP99Ms = percentile(observations.writerRoundTripsMs, 0.99)
  const logicalDurationSeconds = Math.max(
    0.001,
    ((observations.lastReceivedAtMs ?? SYNTHETIC_START_MS) -
      SYNTHETIC_START_MS) /
      1_000,
  )
  const ipcPushesPerSecond =
    observations.ipcPushes / logicalDurationSeconds
  const analysisPushesPerSecond =
    observations.analysisPushes / logicalDurationSeconds

  const checks = {
    generatedMatchesSchedule:
      observations.generatedEvents === expectedScheduledEvents,
    allEventsCommitted:
      observations.generatedEvents === observations.committedEvents &&
      totalFacts === observations.generatedEvents,
    factMixMatches:
      writerSummary.counts.danmaku === expectedMix.danmaku &&
      writerSummary.counts.gift === expectedMix.gift &&
      writerSummary.counts.superChat === expectedMix.superChat &&
      writerSummary.counts.popularity === expectedMix.popularity,
    ftsMatchesDanmaku:
      writerSummary.counts.fts === writerSummary.counts.danmaku,
    metricsMatchFacts:
      writerSummary.metrics.danmakuCount === writerSummary.counts.danmaku &&
      writerSummary.metrics.activeUserCount === expectedMix.activeUserCount &&
      writerSummary.metrics.giftCount === expectedMix.giftQuantity &&
      writerSummary.metrics.giftEventCount === writerSummary.counts.gift &&
      writerSummary.metrics.giftKnownValueMilliCny ===
        expectedMix.giftKnownValueMilliCny &&
      writerSummary.metrics.giftUnknownValueCount ===
        expectedMix.giftUnknownValueCount &&
      writerSummary.metrics.superChatCount === writerSummary.counts.superChat &&
      writerSummary.metrics.superChatValueMilliCny ===
        expectedMix.superChatValueMilliCny &&
      writerSummary.metrics.lastPopularity === expectedMix.lastPopularity &&
      writerSummary.metrics.peakPopularity === expectedMix.peakPopularity,
    queueBounded:
      !observations.queueOverflow &&
      observations.maxQueueDepth <= QUEUE_LIMIT,
    normalRateQueueUnder1000:
      profile.mode === 'accelerated' ||
      observations.maxQueueDepth <= 1_000,
    projectionBounded:
      bounds.recentDanmaku <= 500 &&
      bounds.trendBuckets <= 180 &&
      bounds.pendingRows <= 200 &&
      bounds.keywords <= 10 &&
      bounds.activeUsers <= 10,
    keywordTrackerBounded:
      writerSummary.keywordTrackerSize <= 128 &&
      writerSummary.counts.keywords <= 128,
    ipcPayloadBounded: maxIpcPayloadBytes <= IPC_LIMIT_BYTES,
    walCheckpointed: writerSummary.afterCheckpoint.walBytes === 0,
    walPeakUnder64MiB: writerSummary.maxWalBytes <= 64 * 1024 * 1024,
    databaseHealthy: writerSummary.quickCheck === 'ok',
    capacityMeetsProfileTarget:
      observations.committedEvents / (elapsedMs / 1_000) >=
      (profile.name === 'million'
        ? 2_000
        : profile.mode === 'accelerated'
          ? 200
          : profile.baseRate * 0.98),
    writerCommitP99Under100Ms: commitP99Ms <= 100,
    writerRoundTripP99Under150Ms: roundTripP99Ms <= 150,
    mainEventLoopP99Under50Ms:
      profile.mode === 'accelerated' || eventLoopP99Ms <= 50,
    mainEventLoopMaxUnder250Ms:
      profile.mode === 'accelerated' ||
      loopDelay.max / 1_000_000 <= 250,
    rendererPushRateBounded:
      ipcPushesPerSecond <= 4.01 &&
      analysisPushesPerSecond <= 1.01,
    historyQueryWithinTarget:
      queries.historyFirstScreen.freshConnectionMs <= 500 &&
      queries.historyFirstScreen.warmP95Ms <= 200,
    timelineQueryWithinTarget:
      queries.danmakuFirstPage.warmP95Ms <= 200,
    searchQueryWithinTarget:
      queries.searchDanmaku.freshConnectionMs <= 1_500 &&
      queries.searchDanmaku.warmP95Ms <= 500 &&
      queries.searchDanmakuShortCommon.freshConnectionMs <= 1_500 &&
      queries.searchDanmakuShortCommon.warmP95Ms <= 500 &&
      queries.searchDanmakuShortAbsent.freshConnectionMs <= 1_500 &&
      queries.searchDanmakuShortAbsent.warmP95Ms <= 500,
    searchQueriesReturnExpectedRows:
      queries.searchDanmaku.rowCount > 0 &&
      queries.searchDanmakuShortCommon.rowCount > 0 &&
      queries.searchDanmakuShortAbsent.rowCount === 0,
    projectionQueriesWithinTarget:
      queries.topUsers.warmP95Ms <= 200 &&
      queries.topKeywords.warmP95Ms <= 200 &&
      queries.recentTrend.warmP95Ms <= 200,
  }

  if (profile.name === 'soak' && profile.durationSeconds >= 43_200) {
    checks.memorySlopeUnder1MiBPerHour = memorySlopeMiBPerHour <= 1
  }

  return {
    prototype: true,
    profile,
    environment: {
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      sqlite: 'node:sqlite',
      databasePath: databasePath.replace(/[^/]+$/, '<temporary.sqlite>'),
    },
    workload: {
      generatedEvents: observations.generatedEvents,
      committedEvents: observations.committedEvents,
      elapsedMs: round(elapsedMs),
      effectiveEventsPerSecond: round(
        observations.committedEvents / (elapsedMs / 1_000),
      ),
      expectedMix,
      expectedScheduledEvents,
    },
    writer: {
      batchCount: observations.writerCommitMs.length,
      batchSizeLimit: BATCH_LIMIT,
      flushIntervalMs: FLUSH_INTERVAL_MS,
      commitP50Ms: round(percentile(observations.writerCommitMs, 0.5)),
      commitP95Ms: round(percentile(observations.writerCommitMs, 0.95)),
      commitP99Ms: round(commitP99Ms),
      roundTripP99Ms: round(roundTripP99Ms),
      maxQueueDepth: observations.maxQueueDepth,
      maxWalBytes: writerSummary.maxWalBytes,
      sizesBeforeCheckpoint: writerSummary.beforeCheckpoint,
      sizesAfterCheckpoint: writerSummary.afterCheckpoint,
    },
    integrity: {
      counts: writerSummary.counts,
      metrics: writerSummary.metrics,
      quickCheck: writerSummary.quickCheck,
    },
    realtime: {
      bounds,
      ipcPushes: observations.ipcPushes,
      analysisPushes: observations.analysisPushes,
      ipcPushesPerSecond: round(ipcPushesPerSecond),
      analysisPushesPerSecond: round(analysisPushesPerSecond),
      maxIpcPayloadBytes,
      maxDisplaySkippedCount: observations.maxDisplaySkippedCount,
      keywordTrackerSize: writerSummary.keywordTrackerSize,
    },
    responsiveness: {
      mainEventLoopDelayP99Ms: round(eventLoopP99Ms),
      mainEventLoopDelayMaxMs: round(loopDelay.max / 1_000_000),
    },
    memory: {
      samples: observations.memory.sampleCount,
      firstRssMiB: round(
        (observations.memory.first?.rssBytes ?? 0) / 1024 / 1024,
      ),
      lastRssMiB: round(
        (observations.memory.last?.rssBytes ?? 0) / 1024 / 1024,
      ),
      slopeMiBPerHour: round(memorySlopeMiBPerHour),
      slopeGateApplied:
        profile.name === 'soak' && profile.durationSeconds >= 43_200,
    },
    queries,
    acceptance: {
      checks,
      passed: Object.values(checks).every(Boolean),
    },
  }
}

function expectedEventMix(total) {
  const activeUsers = new Set()
  const mix = {
    danmaku: 0,
    gift: 0,
    giftQuantity: 0,
    giftKnownValueMilliCny: 0,
    giftUnknownValueCount: 0,
    superChat: 0,
    superChatValueMilliCny: 0,
    popularity: 0,
    lastPopularity: null,
    peakPopularity: null,
    activeUserCount: 0,
  }
  for (let index = 0; index < total; index += 1) {
    const selector = index % 100
    if (selector < 90) {
      mix.danmaku += 1
      activeUsers.add(index % 50_000)
    } else if (selector < 95) {
      mix.gift += 1
      const quantity = 1 + (index % 5)
      mix.giftQuantity += quantity
      if (index % 4 === 0) {
        mix.giftUnknownValueCount += quantity
      } else {
        mix.giftKnownValueMilliCny +=
          (1_000 + (index % 20) * 500) * quantity
      }
    } else if (selector === 95) {
      mix.superChat += 1
      mix.superChatValueMilliCny += 30_000 + (index % 10) * 10_000
    } else {
      const popularity = 10_000 + ((index * 97) % 500_000)
      mix.popularity += 1
      mix.lastPopularity = popularity
      mix.peakPopularity = Math.max(mix.peakPopularity ?? 0, popularity)
    }
  }
  mix.activeUserCount = activeUsers.size
  return mix
}

function recordMemory(observations) {
  const sample = {
    elapsedMs: performance.now() - observations.startedAt,
    rssBytes: process.memoryUsage().rss,
    heapUsedBytes: process.memoryUsage().heapUsed,
    workerHeapUsedBytes: observations.lastWorkerHeapUsedBytes,
  }
  const memory = observations.memory
  memory.sampleCount += 1
  memory.first ??= sample
  memory.last = sample

  const warmupMs =
    observations.profile.name === 'soak' &&
    observations.profile.durationSeconds >= 43_200
      ? 30 * 60 * 1_000
      : 0
  if (sample.elapsedMs < warmupMs) return

  const x = sample.elapsedMs / 3_600_000
  const y = sample.rssBytes / 1024 / 1024
  memory.regression.count += 1
  memory.regression.sumX += x
  memory.regression.sumY += y
  memory.regression.sumXY += x * y
  memory.regression.sumXX += x * x
}

function calculateMemorySlope(regression) {
  if (regression.count < 2) return 0
  const numerator =
    regression.count * regression.sumXY -
    regression.sumX * regression.sumY
  const denominator =
    regression.count * regression.sumXX -
    regression.sumX * regression.sumX
  return denominator === 0 ? 0 : numerator / denominator
}

function percentile(values, fraction) {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(sorted.length * fraction) - 1),
  )
  return sorted[index]
}

function round(value) {
  return Math.round(value * 100) / 100
}
