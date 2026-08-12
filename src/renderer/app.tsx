import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'

import type {
  HistoryDanmakuView,
  HistorySummaryView,
  LiveSnapshot,
  LiveStatus,
  StartLiveInput,
} from '../contracts/ipc-v1/live'

type Platform = StartLiveInput['platform']
type MainView = 'live' | 'history'

const statusLabels: Record<LiveStatus, string> = {
  idle: '未开始',
  waiting: '等待开播',
  connecting: '正在连接',
  collecting: '正在采集',
  recovering: '正在重连',
  stopping: '正在停止',
  stopped: '已停止',
  error: '采集异常',
}

const historyStatusLabels: Record<HistorySummaryView['status'], string> = {
  active: '采集中',
  completed: '已完成',
  interrupted: '曾中断',
}

const commandErrors: Record<string, string> = {
  INVALID_ROOM_INPUT: '请输入正确的直播间号或直播链接。',
  SESSION_ALREADY_ACTIVE: '已有采集任务正在运行，请先停止。',
  COLLECTOR_START_FAILED: '暂时无法连接这个直播间，请稍后重试。',
  COLLECTOR_STOP_FAILED: '停止采集失败，请重新尝试。',
}

const collectorErrors: Record<string, string> = {
  COLLECTOR_START_FAILED: '匿名采集启动失败，请检查网络后重试。',
  COLLECTOR_WINDOW_CLOSED: '采集页面意外关闭，已停止本次采集。',
  STORAGE_WRITE_FAILED: '本地存储写入失败，请退出应用并检查磁盘空间后重试。',
  NO_DECODABLE_FRAME: '已进入直播间，但暂未收到可识别的实时消息。',
  NO_WEBSOCKET_CONNECTION: '直播间已打开，但实时消息通道尚未建立。',
  WEBSOCKET_DISCONNECTED: '实时消息通道已断开，可重新开始采集。',
  ROOM_PAGE_LOAD_FAILED: '无法打开这个公开直播间，请检查房间号与网络。',
  ROOM_PAGE_NOT_LOADED: '直播间页面加载超时，请稍后重试。',
  ROOM_PAGE_HIDDEN: '直播间没有进入实时运行状态。',
  DEBUGGER_NETWORK_FAILED: '无法监听直播间的实时消息通道。',
  NO_BINARY_FRAME: '消息通道已建立，但暂未收到直播消息。',
  FRAME_MALFORMED_PROTOBUF: '平台协议发生变化，部分消息暂时无法识别。',
  FRAME_DECODE_FAILED: '实时消息解析失败，可停止后重新采集。',
}

const platformLabels: Record<Platform, string> = {
  bilibili: 'B站',
  douyin: '抖音',
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1_000)
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, '0')).join(':')
}

function formatClock(timestamp: number | null): string {
  if (timestamp === null) return '尚未收到'
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(timestamp)
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(timestamp)
}

function formatMoney(milliCny: number): string {
  return `¥${(milliCny / 1_000).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function PrismArtwork({ variant }: { variant: 'brand' | 'hero' | 'compact' }) {
  return (
    <svg
      className={`prism-artwork prism-artwork-${variant}`}
      viewBox="0 0 360 132"
      aria-hidden="true"
      focusable="false"
    >
      <path className="prism-beam" d="M4 111 108 75" />
      <path className="prism-shape" d="m104 108 44-87 42 87Z" />
      <path className="prism-inner-light" d="m108 75 57-14" />
      <g className="prism-spectrum">
        <path className="spectrum-red" d="m164 61 192-27" />
        <path className="spectrum-orange" d="m165 64 191-18" />
        <path className="spectrum-yellow" d="m166 67 190-9" />
        <path className="spectrum-green" d="m167 70 189 1" />
        <path className="spectrum-blue" d="m168 73 188 11" />
        <path className="spectrum-violet" d="m169 76 187 20" />
      </g>
    </svg>
  )
}

function MetricCard({
  label,
  value,
  note,
  tone,
  unavailable = false,
  primary = false,
}: {
  label: string
  value: string
  note: string
  tone: 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'violet'
  unavailable?: boolean
  primary?: boolean
}) {
  return (
    <div className={`metric-card metric-tone-${tone} ${primary ? 'metric-primary' : ''}`}>
      <dt>{label}</dt>
      <dd className={unavailable ? 'metric-unavailable' : undefined}>
        {unavailable ? '不可用' : value}
      </dd>
      <span>{unavailable ? '匿名协议暂不提供' : note}</span>
    </div>
  )
}

function TrendChart({ trend }: { trend: LiveSnapshot['trend'] }) {
  const max = Math.max(1, ...trend.map((bucket) => bucket.danmakuCount))
  return (
    <section className="signal-card trend-card" aria-labelledby="trend-title">
      <div className="section-heading">
        <h3 id="trend-title">最近30分钟趋势</h3>
        <span>10秒一格</span>
      </div>
      <div className="trend-bars" role="img" aria-label="最近30分钟弹幕数量趋势">
        {trend.length === 0 ? (
          <p className="signal-empty">收到弹幕后生成趋势</p>
        ) : (
          trend.map((bucket, index) => {
            const spectrumBand = Math.min(5, Math.floor((index * 6) / trend.length))
            return (
              <span
                className={bucket.hasGap ? 'trend-gap' : `trend-spectrum-${spectrumBand}`}
                key={bucket.bucketStartMs}
                title={`${formatClock(bucket.bucketStartMs)}，${bucket.danmakuCount}条${bucket.hasGap ? '，数据缺口' : ''}`}
                style={{ height: `${Math.max(8, (bucket.danmakuCount / max) * 100)}%` }}
              />
            )
          })
        )}
      </div>
      <p className="trend-legend">
        <i />
        弹幕数量 <i className="gap-key" />
        数据缺口
      </p>
    </section>
  )
}

function RankingCard({
  title,
  empty,
  items,
  tone,
}: {
  title: string
  empty: string
  items: Array<{ label: string; count: number }>
  tone: 'warm' | 'cool'
}) {
  return (
    <section className={`signal-card ranking-card ranking-tone-${tone}`}>
      <div className="section-heading">
        <h3>{title}</h3>
        <span>TOP 5</span>
      </div>
      {items.length === 0 ? (
        <p className="signal-empty">{empty}</p>
      ) : (
        <ol>
          {items.slice(0, 5).map((item) => (
            <li key={item.label}>
              <span>{item.label}</span>
              <strong>约{item.count}</strong>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

export function App() {
  const [snapshot, setSnapshot] = useState<LiveSnapshot | null>(null)
  const [platform, setPlatform] = useState<Platform>('bilibili')
  const [roomInput, setRoomInput] = useState('')
  const [formError, setFormError] = useState<string | null>(null)
  const [startPending, setStartPending] = useState(false)
  const [mainView, setMainView] = useState<MainView>('live')
  const [activePanel, setActivePanel] = useState<'danmaku' | 'dashboard'>('danmaku')
  const [autoFollow, setAutoFollow] = useState(true)
  const [newMessageCount, setNewMessageCount] = useState(0)
  const [history, setHistory] = useState<HistorySummaryView[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [selectedSession, setSelectedSession] = useState<HistorySummaryView | null>(null)
  const [historyDanmaku, setHistoryDanmaku] = useState<HistoryDanmakuView[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [appliedSearchQuery, setAppliedSearchQuery] = useState('')
  const [historyDetailLoading, setHistoryDetailLoading] = useState(false)
  const [historyHasMore, setHistoryHasMore] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<HistorySummaryView | null>(null)
  const [deletePending, setDeletePending] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const previousTotalRef = useRef(0)

  useEffect(() => {
    let active = true
    void window.danmakuApp.live.getSnapshot().then((nextSnapshot) => {
      if (active) {
        previousTotalRef.current = nextSnapshot.totalDanmaku
        setSnapshot(nextSnapshot)
      }
    })
    const unsubscribe = window.danmakuApp.live.subscribe((nextSnapshot) => {
      setSnapshot(nextSnapshot)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (snapshot === null) return
    const increase = Math.max(0, snapshot.totalDanmaku - previousTotalRef.current)
    previousTotalRef.current = snapshot.totalDanmaku
    if (autoFollow) {
      const list = listRef.current
      if (list !== null) list.scrollTop = list.scrollHeight
      setNewMessageCount(0)
    } else if (increase > 0) {
      setNewMessageCount((current) => current + increase)
    }
  }, [autoFollow, snapshot])

  useEffect(() => {
    if (deleteTarget === null) return
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !deletePending) setDeleteTarget(null)
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [deletePending, deleteTarget])

  const isActive =
    snapshot?.status === 'waiting' ||
    snapshot?.status === 'connecting' ||
    snapshot?.status === 'collecting' ||
    snapshot?.status === 'recovering' ||
    snapshot?.status === 'stopping'
  const collectorError = useMemo(() => {
    if (snapshot?.errorCode === null || snapshot?.errorCode === undefined) return null
    return collectorErrors[snapshot.errorCode] ?? '采集发生异常，可以直接重新开始。'
  }, [snapshot?.errorCode])
  const visibleDanmaku = useMemo(() => snapshot?.recentDanmaku.slice(-500) ?? [], [snapshot])

  async function startCollection(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (startPending) return
    if (roomInput.trim() === '') {
      setFormError('请输入直播间号或直播链接。')
      return
    }
    setFormError(null)
    setStartPending(true)
    try {
      const result = await window.danmakuApp.live.start({ platform, roomInput: roomInput.trim() })
      if (!result.ok) setFormError(commandErrors[result.code] ?? '无法开始采集，请稍后重试。')
    } catch {
      setFormError('采集服务暂时不可用，请稍后重试。')
    } finally {
      setStartPending(false)
    }
  }

  async function stopCollection(): Promise<void> {
    setFormError(null)
    const result = await window.danmakuApp.live.stop()
    if (!result.ok) setFormError(commandErrors[result.code] ?? '无法停止采集。')
  }

  async function openHistory(): Promise<void> {
    setMainView('history')
    setHistoryLoading(true)
    setHistoryError(null)
    try {
      setHistory(await window.danmakuApp.history.list())
    } catch {
      setHistoryError('历史记录暂时无法读取，请稍后重试。')
    } finally {
      setHistoryLoading(false)
    }
  }

  async function openSession(session: HistorySummaryView): Promise<void> {
    setSelectedSession(session)
    setSearchQuery('')
    setAppliedSearchQuery('')
    setHistoryDetailLoading(true)
    setHistoryError(null)
    setHistoryHasMore(false)
    try {
      const rows = await window.danmakuApp.history.listDanmaku(session.id)
      setHistoryDanmaku(rows)
      setHistoryHasMore(rows.length === 100)
    } catch {
      setHistoryError('本场弹幕暂时无法读取。')
      setHistoryDanmaku([])
      setHistoryHasMore(false)
    } finally {
      setHistoryDetailLoading(false)
    }
  }

  async function searchHistory(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (selectedSession === null) return
    setHistoryDetailLoading(true)
    setHistoryError(null)
    setHistoryHasMore(false)
    try {
      const rows = searchQuery.trim()
        ? await window.danmakuApp.history.searchDanmaku(selectedSession.id, searchQuery.trim())
        : await window.danmakuApp.history.listDanmaku(selectedSession.id)
      setHistoryDanmaku(rows)
      setHistoryHasMore(rows.length === 100)
      setAppliedSearchQuery(searchQuery.trim())
    } catch {
      setHistoryError('搜索没有完成，请稍后再试。')
    } finally {
      setHistoryDetailLoading(false)
    }
  }

  async function loadEarlierHistory(): Promise<void> {
    if (selectedSession === null || historyDetailLoading || !historyHasMore) return
    const oldest = historyDanmaku.at(-1)
    if (oldest === undefined) return
    setHistoryDetailLoading(true)
    setHistoryError(null)
    try {
      const before = { receivedAtMs: oldest.receivedAtMs, id: oldest.id }
      const rows = appliedSearchQuery
        ? await window.danmakuApp.history.searchDanmaku(
            selectedSession.id,
            appliedSearchQuery,
            before,
          )
        : await window.danmakuApp.history.listDanmaku(selectedSession.id, before)
      setHistoryDanmaku((current) => [...current, ...rows])
      setHistoryHasMore(rows.length === 100)
    } catch {
      setHistoryError('更早的弹幕暂时无法读取。')
    } finally {
      setHistoryDetailLoading(false)
    }
  }

  async function confirmDelete(): Promise<void> {
    if (deleteTarget === null) return
    setDeletePending(true)
    const result = await window.danmakuApp.history.deleteSession(deleteTarget.id)
    setDeletePending(false)
    if (!result.ok) {
      setHistoryError('删除失败，记录仍然保留在本机。')
      setDeleteTarget(null)
      return
    }
    setHistory((sessions) => sessions.filter((session) => session.id !== deleteTarget.id))
    if (selectedSession?.id === deleteTarget.id) {
      setSelectedSession(null)
      setHistoryDanmaku([])
    }
    setDeleteTarget(null)
  }

  function returnToLatest(): void {
    setAutoFollow(true)
    setNewMessageCount(0)
    const list = listRef.current
    if (list !== null) list.scrollTop = list.scrollHeight
  }

  function handleListScroll(): void {
    const list = listRef.current
    if (list === null || !autoFollow) return
    if (list.scrollHeight - list.scrollTop - list.clientHeight > 48) setAutoFollow(false)
  }

  function handlePlatformKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    setPlatform((current) => (current === 'bilibili' ? 'douyin' : 'bilibili'))
  }

  if (snapshot === null) {
    return (
      <main className="loading-screen" aria-live="polite">
        正在读取本地状态…
      </main>
    )
  }

  const currentPlatform = isActive ? snapshot.platform : platform
  const currentUnavailable = isActive
    ? snapshot.unavailable
    : {
        ...snapshot.unavailable,
        gifts: platform === 'douyin',
        superChats: platform === 'douyin',
        popularity: platform === 'douyin',
      }
  const inputLabel = `${platformLabels[platform]}直播间号或直播链接`

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark">
            <PrismArtwork variant="brand" />
          </span>
          <div>
            <p className="brand-name">弹幕看板</p>
            <p className="brand-subtitle">把直播现场留在本机</p>
          </div>
        </div>
        <div className="room-meta">
          <span className="platform-chip">{platformLabels[currentPlatform]}直播</span>
          <span className="room-id">{snapshot.roomDisplay ?? '等待输入直播间'}</span>
          <span className="duration">{formatDuration(snapshot.elapsedMs)}</span>
        </div>
        <div className={`status-pill status-${snapshot.status}`} aria-live="polite">
          <span className="status-dot" aria-hidden="true" />
          {statusLabels[snapshot.status]}
        </div>
      </header>

      <nav className="primary-nav" aria-label="主导航">
        <button
          className={`nav-item ${mainView === 'live' ? 'nav-item-active' : ''}`}
          type="button"
          aria-current={mainView === 'live' ? 'page' : undefined}
          onClick={() => setMainView('live')}
        >
          实时
        </button>
        <button
          className={`nav-item ${mainView === 'history' ? 'nav-item-active' : ''}`}
          type="button"
          aria-current={mainView === 'history' ? 'page' : undefined}
          onClick={() => void openHistory()}
        >
          历史
        </button>
      </nav>

      {mainView === 'live' ? (
        <>
          <section className="control-strip" aria-label="采集控制">
            {!isActive ? (
              <form className="room-form" onSubmit={(event) => void startCollection(event)}>
                <div
                  className="platform-switch"
                  role="radiogroup"
                  aria-label="直播平台"
                  onKeyDown={handlePlatformKeyDown}
                >
                  {(['bilibili', 'douyin'] as const).map((item) => (
                    <button
                      key={item}
                      type="button"
                      role="radio"
                      aria-checked={platform === item}
                      tabIndex={platform === item ? 0 : -1}
                      onClick={() => {
                        setPlatform(item)
                        setRoomInput('')
                        setFormError(null)
                      }}
                    >
                      {platformLabels[item]}
                    </button>
                  ))}
                </div>
                <label htmlFor="room-input">{inputLabel}</label>
                <div className="room-form-row">
                  <input
                    id="room-input"
                    name="roomInput"
                    value={roomInput}
                    onChange={(event) => setRoomInput(event.target.value)}
                    onBlur={() => {
                      if (roomInput.trim() === '') setFormError('请输入直播间号或直播链接。')
                    }}
                    placeholder={
                      platform === 'bilibili'
                        ? '例如：22625025或live.bilibili.com/22625025'
                        : '例如：123456或live.douyin.com/123456'
                    }
                    autoComplete="off"
                    aria-describedby="room-help room-error"
                  />
                  <button className="primary-button" type="submit" disabled={startPending}>
                    {startPending ? '正在开始' : '开始采集'}
                  </button>
                </div>
                <p id="room-help" className="field-help">
                  匿名连接公开直播间，不读取登录状态。关闭窗口后仍会在菜单栏继续采集。
                </p>
                <p id="room-error" className="field-error" role="alert">
                  {formError}
                </p>
              </form>
            ) : (
              <div className="active-control">
                <div>
                  <p className="control-kicker">活动会话</p>
                  <p>
                    {snapshot.status === 'waiting'
                      ? '直播间尚未开播，正在后台等待'
                      : snapshot.status === 'connecting'
                        ? '正在建立匿名消息通道'
                        : snapshot.status === 'recovering'
                          ? '连接暂时中断，正在自动重连'
                          : `${platformLabels[snapshot.platform]}弹幕正在写入本地历史`}
                  </p>
                </div>
                <button
                  className="stop-button"
                  type="button"
                  onClick={() => void stopCollection()}
                  disabled={snapshot.status === 'stopping'}
                >
                  {snapshot.status === 'stopping' ? '正在停止' : '停止采集'}
                </button>
              </div>
            )}
          </section>

          {collectorError !== null && snapshot.status !== 'recovering' && (
            <div className="status-banner" role="alert">
              <strong>本次采集已停止</strong>
              <span>{collectorError}</span>
            </div>
          )}

          <div className="mobile-tabs" role="tablist" aria-label="实时内容">
            <button
              id="danmaku-tab"
              type="button"
              role="tab"
              aria-selected={activePanel === 'danmaku'}
              aria-controls="danmaku-panel"
              onClick={() => setActivePanel('danmaku')}
            >
              弹幕
            </button>
            <button
              id="dashboard-tab"
              type="button"
              role="tab"
              aria-selected={activePanel === 'dashboard'}
              aria-controls="dashboard-panel"
              onClick={() => setActivePanel('dashboard')}
            >
              看板
            </button>
          </div>

          <main className="workspace">
            <section
              id="danmaku-panel"
              className={`danmaku-panel ${activePanel === 'danmaku' ? 'mobile-panel-active' : ''}`}
              aria-labelledby="danmaku-title"
            >
              <div className="panel-heading feed-heading">
                <div>
                  <p className="panel-kicker">直播流</p>
                  <h1 id="danmaku-title">实时弹幕</h1>
                </div>
                <div className="feed-actions">
                  <span className="feed-count">最近{visibleDanmaku.length}/500条</span>
                  {(visibleDanmaku.length > 0 || isActive) && (
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => (autoFollow ? setAutoFollow(false) : returnToLatest())}
                    >
                      {autoFollow ? '暂停跟随' : '继续跟随'}
                    </button>
                  )}
                </div>
              </div>

              <div
                ref={listRef}
                className="danmaku-list"
                aria-live={autoFollow ? 'polite' : 'off'}
                aria-relevant="additions"
                onScroll={handleListScroll}
              >
                {visibleDanmaku.length === 0 ? (
                  <div className="empty-state">
                    <PrismArtwork variant="hero" />
                    <h2>
                      {snapshot.status === 'waiting'
                        ? '直播间尚未开播'
                        : snapshot.status === 'connecting' || snapshot.status === 'recovering'
                          ? '正在等待实时消息'
                          : '弹幕会从这里开始'}
                    </h2>
                    <p>输入公开直播间并开始采集，新弹幕会按接收顺序出现并保存到本机。</p>
                  </div>
                ) : (
                  visibleDanmaku.map((item) => (
                    <article className="danmaku-row" key={item.id}>
                      <time dateTime={new Date(item.receivedAtMs).toISOString()}>
                        {formatClock(item.receivedAtMs)}
                      </time>
                      <span className="danmaku-user" title={item.displayName}>
                        {item.displayName}
                      </span>
                      <p>{item.content}</p>
                    </article>
                  ))
                )}
              </div>
              {!autoFollow && newMessageCount > 0 && (
                <button className="new-message-button" type="button" onClick={returnToLatest}>
                  <span className="signal-dot" aria-hidden="true" />
                  <span className="sr-only">{newMessageCount}条新消息，回到最新</span>
                  <span aria-hidden="true">{newMessageCount}条新消息，回到最新</span>
                </button>
              )}
            </section>

            <aside
              id="dashboard-panel"
              className={`dashboard-panel ${activePanel === 'dashboard' ? 'mobile-panel-active' : ''}`}
              aria-labelledby="dashboard-title"
            >
              <div className="panel-heading compact-heading">
                <div>
                  <p className="panel-kicker">现场概览</p>
                  <h2 id="dashboard-title">实时看板</h2>
                </div>
                <span
                  className={`live-indicator ${snapshot.status === 'collecting' ? 'is-live' : ''}`}
                >
                  {snapshot.status === 'collecting' ? '采集中' : '等待开始'}
                </span>
              </div>

              <dl className="metric-grid">
                <MetricCard
                  label="弹幕总数"
                  value={snapshot.totalDanmaku.toLocaleString('zh-CN')}
                  note="本次会话"
                  tone="red"
                  primary
                />
                <MetricCard
                  label="最近一分钟"
                  value={snapshot.danmakuPerMinute.toLocaleString('zh-CN')}
                  note="条/分钟"
                  tone="orange"
                />
                <MetricCard
                  label="活跃人数"
                  value={snapshot.activeSpeakers.toLocaleString('zh-CN')}
                  note="本地匿名去重"
                  tone="yellow"
                />
                <MetricCard
                  label="直播热度"
                  value={(snapshot.metrics.popularity ?? 0).toLocaleString('zh-CN')}
                  note="平台热度值"
                  tone="green"
                  unavailable={currentUnavailable.popularity}
                />
                <MetricCard
                  label="礼物"
                  value={`${snapshot.metrics.giftCount.toLocaleString('zh-CN')}件 · ${formatMoney(snapshot.metrics.giftValueMilliCny)}`}
                  note="数量与估算金额"
                  tone="blue"
                  unavailable={currentUnavailable.gifts}
                />
                <MetricCard
                  label="醒目留言"
                  value={`${snapshot.metrics.superChatCount.toLocaleString('zh-CN')}条 · ${formatMoney(snapshot.metrics.superChatValueMilliCny)}`}
                  note="数量与金额"
                  tone="violet"
                  unavailable={currentUnavailable.superChats}
                />
              </dl>

              {snapshot.gapCount > 0 && (
                <div className="status-banner gap-banner" role="status">
                  <strong>本场有{snapshot.gapCount}次数据缺口</strong>
                  <span>
                    {snapshot.currentGapSince === null
                      ? '连接已恢复，缺口期间的消息无法补回。'
                      : `自${formatClock(snapshot.currentGapSince)}起正在中断。`}
                  </span>
                </div>
              )}

              <TrendChart trend={snapshot.trend} />
              <div className="ranking-grid">
                <RankingCard
                  title="高频词"
                  empty="暂无高频词"
                  items={snapshot.keywords.map((item) => ({
                    label: item.term,
                    count: item.estimatedCount,
                  }))}
                  tone="warm"
                />
                <RankingCard
                  title="活跃用户"
                  empty="暂无可排行用户"
                  items={snapshot.activeUsers.map((item) => ({
                    label: item.displayName,
                    count: item.danmakuCount,
                  }))}
                  tone="cool"
                />
              </div>

              <section className="session-panel" aria-labelledby="session-title">
                <div className="section-heading">
                  <h3 id="session-title">会话状态</h3>
                  <span>{statusLabels[snapshot.status]}</span>
                </div>
                <dl>
                  <div>
                    <dt>采集时长</dt>
                    <dd>{formatDuration(snapshot.elapsedMs)}</dd>
                  </div>
                  <div>
                    <dt>最后消息</dt>
                    <dd>{formatClock(snapshot.lastMessageAtMs)}</dd>
                  </div>
                  <div>
                    <dt>数据位置</dt>
                    <dd>本机数据库</dd>
                  </div>
                  <div>
                    <dt>登录状态</dt>
                    <dd>未读取</dd>
                  </div>
                </dl>
                {(currentUnavailable.gifts ||
                  currentUnavailable.superChats ||
                  currentUnavailable.popularity) && (
                  <p className="capability-note">
                    匿名协议未稳定提供的指标会明确标记，不会按零计算。
                  </p>
                )}
              </section>
            </aside>
          </main>
        </>
      ) : (
        <main className={`history-workspace ${selectedSession === null ? '' : 'has-selection'}`}>
          <section className="history-sidebar" aria-labelledby="history-title">
            <div className="panel-heading">
              <div>
                <p className="panel-kicker">本地存档</p>
                <h1 id="history-title">历史场次</h1>
              </div>
              <span className="feed-count">{history.length}场</span>
            </div>
            <div className="history-session-list">
              {historyLoading ? (
                <p className="list-state" aria-live="polite">
                  正在读取历史…
                </p>
              ) : history.length === 0 ? (
                <div className="empty-state compact-empty">
                  <PrismArtwork variant="compact" />
                  <h2>还没有历史场次</h2>
                  <p>完成一次采集后，这里会保留直播间、时间和关键统计。</p>
                </div>
              ) : (
                history.map((session) => (
                  <button
                    className={`history-session ${selectedSession?.id === session.id ? 'history-session-active' : ''}`}
                    key={session.id}
                    type="button"
                    aria-label={`${session.roomTitle}，${formatDate(session.startedAtMs)}`}
                    onClick={() => void openSession(session)}
                  >
                    <span className="history-session-topline">
                      <strong>{session.roomTitle || `直播间${session.roomId}`}</strong>
                      <em className={`history-status history-status-${session.status}`}>
                        {historyStatusLabels[session.status]}
                      </em>
                    </span>
                    <span>
                      {session.anchorDisplayName ?? `${platformLabels[session.platform]}直播间`}
                    </span>
                    <span className="history-session-meta">
                      <time dateTime={new Date(session.startedAtMs).toISOString()}>
                        {formatDate(session.startedAtMs)}
                      </time>
                      <span>{session.danmakuCount.toLocaleString('zh-CN')}条弹幕</span>
                    </span>
                  </button>
                ))
              )}
            </div>
          </section>

          <section className="history-detail" aria-labelledby="history-detail-title">
            {selectedSession === null ? (
              <div className="empty-state history-welcome">
                <PrismArtwork variant="compact" />
                <h2 id="history-detail-title">选择一场直播</h2>
                <p>可以分页查看全部弹幕、搜索本场内容，或删除整场本地记录。</p>
              </div>
            ) : (
              <>
                <div className="history-detail-header">
                  <div>
                    <button
                      className="mobile-back-button"
                      type="button"
                      onClick={() => setSelectedSession(null)}
                    >
                      返回场次
                    </button>
                    <p className="panel-kicker">SESSION #{selectedSession.id}</p>
                    <h2 id="history-detail-title">{selectedSession.roomTitle}</h2>
                    <p className="history-detail-meta">
                      {platformLabels[selectedSession.platform]} · {selectedSession.roomId} ·{' '}
                      {formatDate(selectedSession.startedAtMs)}
                    </p>
                  </div>
                  <button
                    className="danger-text-button"
                    type="button"
                    onClick={() => setDeleteTarget(selectedSession)}
                  >
                    删除整场记录
                  </button>
                </div>
                <dl className="history-stats">
                  <div>
                    <dt>弹幕</dt>
                    <dd>{selectedSession.danmakuCount.toLocaleString('zh-CN')}</dd>
                  </div>
                  <div>
                    <dt>活跃人数</dt>
                    <dd>{selectedSession.activeUserCount.toLocaleString('zh-CN')}</dd>
                  </div>
                  <div>
                    <dt>礼物</dt>
                    <dd>
                      {selectedSession.platform === 'douyin'
                        ? '不可用'
                        : selectedSession.giftCount.toLocaleString('zh-CN')}
                    </dd>
                  </div>
                  <div>
                    <dt>醒目留言</dt>
                    <dd>
                      {selectedSession.platform === 'douyin'
                        ? '不可用'
                        : selectedSession.superChatCount.toLocaleString('zh-CN')}
                    </dd>
                  </div>
                </dl>
                <form className="history-search" onSubmit={(event) => void searchHistory(event)}>
                  <label htmlFor="history-search">搜索本场弹幕</label>
                  <div>
                    <input
                      id="history-search"
                      type="search"
                      value={searchQuery}
                      onChange={(event) => setSearchQuery(event.target.value)}
                      placeholder="输入昵称或弹幕内容"
                    />
                    <button type="submit" className="secondary-button">
                      搜索
                    </button>
                  </div>
                </form>
                {historyError !== null && (
                  <p className="history-error" role="alert">
                    {historyError}
                  </p>
                )}
                <div className="history-danmaku-heading">
                  <h3>{appliedSearchQuery ? `搜索「${appliedSearchQuery}」` : '本场弹幕'}</h3>
                  <span>{historyDanmaku.length}条</span>
                </div>
                <div className="history-danmaku-list" aria-busy={historyDetailLoading}>
                  {historyDetailLoading ? (
                    <p className="list-state">正在读取本场弹幕…</p>
                  ) : historyDanmaku.length === 0 ? (
                    <p className="list-state">
                      {appliedSearchQuery ? '没有找到匹配的弹幕。' : '本场没有保存普通弹幕。'}
                    </p>
                  ) : (
                    historyDanmaku.map((item) => (
                      <article className="danmaku-row history-danmaku-row" key={item.id}>
                        <time dateTime={new Date(item.receivedAtMs).toISOString()}>
                          {formatClock(item.receivedAtMs)}
                        </time>
                        <span className="danmaku-user" title={item.displayName}>
                          {item.displayName}
                          {item.medalName !== null && (
                            <small>
                              {item.medalName}
                              {item.medalLevel}
                            </small>
                          )}
                        </span>
                        <p>{item.text}</p>
                      </article>
                    ))
                  )}
                  {!historyDetailLoading && historyHasMore && historyDanmaku.length > 0 && (
                    <button
                      className="load-more-button"
                      type="button"
                      onClick={() => void loadEarlierHistory()}
                    >
                      加载更早弹幕
                    </button>
                  )}
                </div>
              </>
            )}
          </section>
        </main>
      )}

      {historyError !== null && selectedSession === null && mainView === 'history' && (
        <div className="status-banner" role="alert">
          <strong>历史记录读取失败</strong>
          <span>{historyError}</span>
        </div>
      )}

      {deleteTarget !== null && (
        <div className="dialog-backdrop" role="presentation">
          <section
            className="confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-dialog-title"
            aria-describedby="delete-dialog-description"
          >
            <span className="dialog-warning" aria-hidden="true">
              !
            </span>
            <h2 id="delete-dialog-title">删除整场记录</h2>
            <p id="delete-dialog-description">
              将删除{formatDate(deleteTarget.startedAtMs)}的{platformLabels[deleteTarget.platform]}
              直播间{deleteTarget.roomId}「{deleteTarget.roomTitle}
              」的全部本地弹幕与统计，删除后无法恢复。
            </p>
            <div className="dialog-actions">
              <button type="button" onClick={() => setDeleteTarget(null)} disabled={deletePending}>
                取消
              </button>
              <button
                className="danger-button"
                type="button"
                onClick={() => void confirmDelete()}
                disabled={deletePending}
              >
                {deletePending ? '正在删除' : '确认删除'}
              </button>
            </div>
          </section>
        </div>
      )}

      <footer className="footer-line">
        <span>数据仅保存在本机 · 不读取账号登录状态</span>
        <span>本地接口v{window.danmakuApp.apiVersion}</span>
      </footer>
    </div>
  )
}
