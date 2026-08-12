import type { LiveCommandResult, LiveSnapshot, StartLiveInput } from '../../contracts/ipc-v1/live'
import { parseDouyinRoomInput } from '../protocol/douyin-web-v1/room-input'
import { LiveProjection } from '../realtime/live-projection'
import type { DouyinCollector, DouyinCollectorCallbacks } from './douyin-collector'

type CollectorFactory = () => DouyinCollector
type SnapshotListener = (snapshot: LiveSnapshot) => void

export class LiveService {
  private readonly projection: LiveProjection
  private collector: DouyinCollector | null = null
  private runGeneration = 0
  private readonly listeners = new Set<SnapshotListener>()
  private emitTimer: NodeJS.Timeout | null = null
  private elapsedTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly createCollector: CollectorFactory,
    clock: () => number = Date.now,
  ) {
    this.projection = new LiveProjection(clock)
  }

  getSnapshot(): LiveSnapshot {
    return this.projection.snapshot()
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(input: StartLiveInput): Promise<LiveCommandResult> {
    const target = input.platform === 'douyin' ? parseDouyinRoomInput(input.roomInput) : null
    if (target === null) {
      return { ok: false, code: 'INVALID_ROOM_INPUT' }
    }

    const currentStatus = this.projection.snapshot().status
    if (
      currentStatus === 'connecting' ||
      currentStatus === 'collecting' ||
      currentStatus === 'stopping'
    ) {
      return { ok: false, code: 'SESSION_ALREADY_ACTIVE' }
    }

    const generation = this.runGeneration + 1
    this.runGeneration = generation
    this.projection.start(target.roomDisplay)
    this.emitNow()

    const collector = this.createCollector()
    this.collector = collector
    const callbacks: DouyinCollectorCallbacks = {
      onConnected: async () => {
        if (this.runGeneration !== generation) return
        this.projection.markCollecting()
        this.emitNow()
      },
      onChats: async (chats) => {
        if (this.runGeneration !== generation) return
        for (const chat of chats) {
          this.projection.ingest(chat)
        }
        this.scheduleEmit()
      },
      onError: async (code) => {
        if (this.runGeneration !== generation) return
        this.runGeneration += 1
        if (this.collector === collector) {
          this.collector = null
        }
        this.projection.markError(code)
        this.stopElapsedTimer()
        this.emitNow()
        await collector.stop().catch(() => undefined)
      },
    }

    try {
      await collector.start(target.url, callbacks)
      if (this.runGeneration === generation && this.collector === collector) {
        this.startElapsedTimer()
      }
      return { ok: true }
    } catch {
      await collector.stop().catch(() => undefined)
      if (this.runGeneration === generation) {
        this.projection.markError('COLLECTOR_START_FAILED')
        if (this.collector === collector) {
          this.collector = null
        }
        this.emitNow()
      }
      return { ok: false, code: 'COLLECTOR_START_FAILED' }
    }
  }

  async stop(): Promise<LiveCommandResult> {
    const collector = this.collector
    if (collector === null) {
      return { ok: true }
    }

    this.runGeneration += 1
    this.projection.markStopping()
    this.emitNow()
    this.stopElapsedTimer()
    try {
      await collector.stop()
      this.collector = null
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
    await this.stop()
    this.listeners.clear()
    if (this.emitTimer !== null) {
      clearTimeout(this.emitTimer)
      this.emitTimer = null
    }
  }

  private emitNow(): void {
    const snapshot = this.projection.snapshot()
    for (const listener of this.listeners) {
      listener(snapshot)
    }
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
    if (this.elapsedTimer !== null) {
      clearInterval(this.elapsedTimer)
      this.elapsedTimer = null
    }
  }
}
