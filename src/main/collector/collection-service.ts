import type { LiveCommandResult, LiveSnapshot, StartLiveInput } from '../../contracts/ipc-v1/live'
import type { DomainEvent } from '../../domain/events'
import { parseDouyinRoomInput } from '../protocol/douyin-web-v1/room-input'
import { StorageWriteQueue } from '../queue/storage-write-queue'
import { LiveProjection } from '../realtime/live-projection'
import type { CommittedEvents, CreateSessionInput, SessionEndReason } from '../storage/local-store'
import type { BilibiliCollector as BilibiliCollectorImplementation } from './bilibili-collector'
import type { DouyinCollector, DouyinCollectorCallbacks } from './douyin-collector'

type BilibiliCollector = Pick<BilibiliCollectorImplementation, 'start' | 'stop'>

type SnapshotListener = (snapshot: LiveSnapshot) => void

interface CollectionStorage {
  createSession(input: CreateSessionInput): Promise<{ id: number }>
  appendBatch(sessionId: number, events: readonly DomainEvent[]): Promise<CommittedEvents>
  finalizeSession(sessionId: number, reason: SessionEndReason, endedAtMs: number): Promise<unknown>
  openGap(sessionId: number, reason: string, startedAtMs: number): Promise<unknown>
  closeGap(sessionId: number, endedAtMs: number, recovered: boolean): Promise<unknown>
  shutdown?(): Promise<void>
}

export class CollectionService {
  private readonly projection: LiveProjection
  private readonly writeQueue: StorageWriteQueue
  private activeCollector: { stop(): Promise<void> } | null = null
  private activeSessionId: number | null = null
  private activePlatform: LiveSnapshot['platform'] = 'bilibili'
  private generation = 0
  private readonly listeners = new Set<SnapshotListener>()
  private emitTimer: NodeJS.Timeout | null = null
  private elapsedTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly store: CollectionStorage,
    private readonly hmacKey: Uint8Array,
    private readonly createBilibiliCollector: () => BilibiliCollector,
    private readonly createDouyinCollector: () => DouyinCollector,
    private readonly clock: () => number = Date.now,
  ) {
    this.projection = new LiveProjection(clock)
    this.writeQueue = new StorageWriteQueue(
      { appendBatch: (sessionId, events) => store.appendBatch(sessionId, events) },
      {
        onCommitted: (result) => this.applyCommittedEvents(result),
        now: clock,
      },
    )
  }

  getSnapshot(): LiveSnapshot {
    return this.projection.snapshot()
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(input: StartLiveInput): Promise<LiveCommandResult> {
    if (this.activeCollector !== null) return { ok: false, code: 'SESSION_ALREADY_ACTIVE' }
    const generation = ++this.generation
    this.activePlatform = input.platform
    this.projection.start(input.roomInput.trim(), input.platform)
    this.emitNow()

    if (input.platform === 'douyin') return this.startDouyin(input.roomInput, generation)
    return this.startBilibili(input.roomInput, generation)
  }

  async stop(reason: 'user_stop' | 'app_quit' = 'user_stop'): Promise<LiveCommandResult> {
    const collector = this.activeCollector
    if (collector === null) return { ok: true }
    ++this.generation
    this.projection.markStopping()
    this.emitNow()
    this.stopElapsedTimer()
    try {
      await collector.stop()
      await this.writeQueue.flush()
      if (this.activeSessionId !== null) {
        await this.store.finalizeSession(this.activeSessionId, reason, this.clock())
      }
      this.activeSessionId = null
      this.activeCollector = null
      this.projection.markStopped()
      this.emitNow()
      return { ok: true }
    } catch {
      this.projection.markError('COLLECTOR_STOP_FAILED')
      this.emitNow()
      return { ok: false, code: 'COLLECTOR_STOP_FAILED' }
    }
  }

  async dispose(): Promise<void> {
    await this.stop('app_quit')
    this.listeners.clear()
    if (this.emitTimer !== null) clearTimeout(this.emitTimer)
    await this.writeQueue.shutdown()
    await this.store.shutdown?.()
  }

  private async startBilibili(roomInput: string, generation: number): Promise<LiveCommandResult> {
    const collector = this.createBilibiliCollector()
    this.activeCollector = collector
    try {
      await collector.start(roomInput, {
        onRoomResolved: (room) => {
          if (generation !== this.generation) return
          this.projection.start(room.roomId, 'bilibili')
          this.emitNow()
        },
        onWaiting: () => {
          if (generation !== this.generation) return
          this.projection.markWaiting()
          this.emitNow()
        },
        onAuthenticated: async (room) => {
          if (generation !== this.generation) throw new Error('STALE_RUN')
          const session = await this.store.createSession({
            platform: 'bilibili',
            roomId: room.roomId,
            inputRoomId: room.inputRoomId,
            roomTitle: `B站直播间 ${room.roomId}`,
            adapterVersion: 'bilibili-web-v1',
            startedAtMs: this.clock(),
          })
          this.activeSessionId = session.id
          this.projection.markCollecting()
          this.startElapsedTimer()
          this.emitNow()
          return { sessionId: session.id, hmacKey: Uint8Array.from(this.hmacKey) }
        },
        onConnectionAuthenticated: async () => {
          if (
            generation !== this.generation ||
            this.activeSessionId === null ||
            this.projection.snapshot().status !== 'recovering'
          ) {
            return
          }
          await this.store.closeGap(this.activeSessionId, this.clock(), true)
          this.projection.markCollecting()
          this.emitNow()
        },
        onEvents: async (events) => {
          if (generation !== this.generation || this.activeSessionId === null) return
          await this.writeQueue.enqueueAndWait(this.activeSessionId, events)
        },
        onPopularity: async (value) => {
          if (generation !== this.generation || this.activeSessionId === null) return
          await this.writeQueue.enqueueAndWait(this.activeSessionId, [
            {
              type: 'popularity',
              sessionId: this.activeSessionId,
              receivedAtMs: this.clock(),
              value,
            },
          ])
        },
        onSignal: (signal) => {
          if (signal === 'preparing') void this.stop('user_stop')
        },
        onRecovering: async (code) => {
          if (generation !== this.generation) return
          if (this.activeSessionId !== null) {
            await this.store.openGap(this.activeSessionId, code, this.clock())
          }
          this.projection.markRecovering(code)
          this.emitNow()
        },
        onError: (code) => {
          if (generation !== this.generation) return
          void this.failCollector(collector, generation, code)
        },
      })
      return { ok: true }
    } catch {
      await collector.stop().catch(() => undefined)
      if (generation === this.generation) {
        this.activeCollector = null
        this.projection.markError('COLLECTOR_START_FAILED')
        this.emitNow()
      }
      return { ok: false, code: 'COLLECTOR_START_FAILED' }
    }
  }

  private async startDouyin(roomInput: string, generation: number): Promise<LiveCommandResult> {
    const target = parseDouyinRoomInput(roomInput)
    if (target === null) {
      this.projection.markError('INVALID_ROOM_INPUT')
      this.activeCollector = null
      return { ok: false, code: 'INVALID_ROOM_INPUT' }
    }
    const collector = this.createDouyinCollector()
    this.activeCollector = collector
    const callbacks: DouyinCollectorCallbacks = {
      onConnected: async () => {
        if (generation !== this.generation) return
        const now = this.clock()
        const session = await this.store.createSession({
          platform: 'douyin',
          roomId: target.roomDisplay,
          roomTitle: `抖音直播间 ${target.roomDisplay}`,
          adapterVersion: 'douyin-browser-v1',
          startedAtMs: now,
        })
        this.activeSessionId = session.id
        this.projection.markCollecting()
        this.startElapsedTimer()
        this.emitNow()
      },
      onChats: async (chats) => {
        if (generation !== this.generation || this.activeSessionId === null) return
        const events: DomainEvent[] = chats.map((chat) => {
          const localUserKey =
            chat.localUserKey === undefined ? null : Buffer.from(chat.localUserKey, 'base64url')
          return {
            type: 'danmaku',
            sessionId: this.activeSessionId as number,
            sourceEventKey: null,
            receivedAtMs: this.clock(),
            sentAtMs: null,
            localUserKey: localUserKey?.byteLength === 16 ? localUserKey : null,
            displayName: chat.displayName,
            text: chat.content,
            medalName: null,
            medalLevel: null,
          }
        })
        await this.writeQueue.enqueueAndWait(this.activeSessionId, events)
      },
      onError: async (code) => {
        if (generation !== this.generation) return
        await this.failCollector(collector, generation, code)
      },
    }
    try {
      await collector.start(target.url, callbacks)
      return { ok: true }
    } catch {
      this.activeCollector = null
      return { ok: false, code: 'COLLECTOR_START_FAILED' }
    }
  }

  private emitNow(): void {
    const snapshot = this.projection.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }

  private applyCommittedEvents(result: CommittedEvents): void {
    if (result.sessionId !== this.activeSessionId) return
    this.projection.updateActiveSpeakerCount(result.activeUserCount)
    for (const event of result.committedEvents) {
      if (event.type === 'danmaku') {
        this.projection.ingest({
          displayName: event.displayName,
          content: event.text,
          receivedAtMs: event.receivedAtMs,
          ...(event.localUserKey === null
            ? {}
            : { localUserKey: Buffer.from(event.localUserKey).toString('hex') }),
        })
      } else if (event.type === 'gift') {
        this.projection.ingestGift(event)
      } else if (event.type === 'super_chat') {
        this.projection.ingestSuperChat(event)
      } else {
        this.projection.updatePopularity(event.value)
      }
    }
    this.scheduleEmit()
  }

  private async failCollector(
    collector: { stop(): Promise<void> },
    generation: number,
    code: string,
  ): Promise<void> {
    if (generation !== this.generation) return
    ++this.generation
    await collector.stop().catch(() => undefined)
    await this.writeQueue.flush().catch(() => undefined)
    if (this.activeSessionId !== null) {
      try {
        await this.store.finalizeSession(this.activeSessionId, 'process_interrupted', this.clock())
      } catch {
        // 启动前失败或会话已终态时无需再改写。
      }
    }
    this.activeSessionId = null
    this.activeCollector = null
    this.stopElapsedTimer()
    this.projection.markError(code)
    this.emitNow()
  }

  private scheduleEmit(): void {
    if (this.emitTimer !== null) return
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null
      this.emitNow()
    }, 250)
  }

  private startElapsedTimer(): void {
    this.stopElapsedTimer()
    this.elapsedTimer = setInterval(() => this.emitNow(), 1_000)
  }

  private stopElapsedTimer(): void {
    if (this.elapsedTimer !== null) clearInterval(this.elapsedTimer)
    this.elapsedTimer = null
  }
}
