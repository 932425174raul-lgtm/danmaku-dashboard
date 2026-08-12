// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  DanmakuAppApi,
  HistoryReviewView,
  HistorySummaryView,
  LiveSnapshot,
} from '../../src/contracts/ipc-v1/live'
import { App } from '../../src/renderer/app'

const idleSnapshot: LiveSnapshot = {
  apiVersion: 1,
  platform: 'bilibili',
  status: 'idle',
  roomDisplay: null,
  startedAtMs: null,
  elapsedMs: 0,
  totalDanmaku: 0,
  danmakuPerMinute: 0,
  activeSpeakers: 0,
  lastMessageAtMs: null,
  gapCount: 0,
  currentGapSince: null,
  lastGap: null,
  trend: [],
  keywords: [],
  activeUsers: [],
  recentDanmaku: [],
  metrics: {
    giftCount: 0,
    giftValueMilliCny: 0,
    superChatCount: 0,
    superChatValueMilliCny: 0,
    popularity: null,
  },
  unavailable: {
    gifts: false,
    superChats: false,
    popularity: false,
    viewerCount: true,
    history: false,
  },
  errorCode: null,
}

const historySession: HistorySummaryView = {
  id: 21,
  platform: 'bilibili',
  roomId: '123456',
  roomTitle: '测试直播间',
  anchorDisplayName: '测试主播',
  startedAtMs: 1_700_000_000_000,
  endedAtMs: 1_700_000_600_000,
  status: 'completed',
  danmakuCount: 321,
  activeUserCount: 48,
  giftCount: 6,
  superChatCount: 2,
}

const historyReview: HistoryReviewView = {
  sessionId: 21,
  startedAtMs: 1_700_000_000_000,
  endedAtMs: 1_700_000_600_000,
  bucketMinutes: 5,
  totals: {
    danmakuCount: 321,
    activeUserCount: 48,
    giftCount: 6,
    superChatCount: 2,
    gapCount: 1,
    gapDurationMs: 10_000,
  },
  buckets: [
    {
      bucketStartMs: 1_700_000_000_000,
      bucketEndMs: 1_700_000_300_000,
      danmakuCount: 120,
      activeSpeakerCount: 28,
      giftCount: 3,
      superChatCount: 1,
      popularityPeak: 88_000,
      hasGap: false,
    },
    {
      bucketStartMs: 1_700_000_300_000,
      bucketEndMs: 1_700_000_600_000,
      danmakuCount: 201,
      activeSpeakerCount: 36,
      giftCount: 3,
      superChatCount: 1,
      popularityPeak: 96_000,
      hasGap: true,
    },
  ],
  repeatedDanmaku: [
    {
      text: '再讲一遍',
      count: 18,
      uniqueUserCount: 12,
      firstAtMs: 1_700_000_320_000,
      lastAtMs: 1_700_000_550_000,
    },
  ],
  mostRepeatedDanmaku: {
    text: '再讲一遍',
    count: 18,
    uniqueUserCount: 12,
    firstAtMs: 1_700_000_320_000,
    lastAtMs: 1_700_000_550_000,
  },
  peakDanmakuBucket: {
    bucketStartMs: 1_700_000_300_000,
    bucketEndMs: 1_700_000_600_000,
    danmakuCount: 201,
    activeSpeakerCount: 36,
    giftCount: 3,
    superChatCount: 1,
    popularityPeak: 96_000,
    hasGap: true,
  },
  peakActiveSpeakerBucket: {
    bucketStartMs: 1_700_000_300_000,
    bucketEndMs: 1_700_000_600_000,
    danmakuCount: 201,
    activeSpeakerCount: 36,
    giftCount: 3,
    superChatCount: 1,
    popularityPeak: 96_000,
    hasGap: true,
  },
  topThreeDanmakuShare: 0.63,
}

function installApi(overrides: Partial<DanmakuAppApi['history']> = {}) {
  let listener: ((snapshot: LiveSnapshot) => void) | undefined
  const api: DanmakuAppApi = {
    apiVersion: 1,
    live: {
      getSnapshot: vi.fn().mockResolvedValue(idleSnapshot),
      start: vi.fn().mockResolvedValue({ ok: true }),
      stop: vi.fn().mockResolvedValue({ ok: true }),
      subscribe: vi.fn((nextListener) => {
        listener = nextListener
        return () => undefined
      }),
    },
    history: {
      list: vi.fn().mockResolvedValue([historySession]),
      getReview: vi.fn().mockResolvedValue(historyReview),
      listDanmaku: vi.fn().mockResolvedValue([
        {
          id: 91,
          sessionId: 21,
          receivedAtMs: 1_700_000_200_000,
          displayName: '小明',
          text: '今天的内容很有用',
          medalName: null,
          medalLevel: null,
        },
      ]),
      searchDanmaku: vi.fn().mockResolvedValue([
        {
          id: 92,
          sessionId: 21,
          receivedAtMs: 1_700_000_300_000,
          displayName: '小红',
          text: '搜索命中的弹幕',
          medalName: '学习委员',
          medalLevel: 8,
        },
      ]),
      deleteSession: vi.fn().mockResolvedValue({ ok: true }),
      ...overrides,
    },
  }
  Object.defineProperty(window, 'danmakuApp', {
    configurable: true,
    value: api,
  })
  return { api, emit: (snapshot: LiveSnapshot) => listener?.(snapshot) }
}

describe('App', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('默认从B站房间输入启动采集，并支持切换到抖音', async () => {
    const { api } = installApi()
    render(<App />)

    const input = await screen.findByLabelText('B站直播间号或直播链接')
    await userEvent.type(input, '123456')
    await userEvent.click(screen.getByRole('button', { name: '开始采集' }))

    expect(api.live.start).toHaveBeenCalledWith({ platform: 'bilibili', roomInput: '123456' })

    await userEvent.click(screen.getByRole('radio', { name: '抖音' }))
    expect(screen.getByLabelText('抖音直播间号或直播链接')).toBeInTheDocument()
  })

  it('抖音匿名协议不可用的指标不会伪装成零', async () => {
    const { emit } = installApi()
    render(<App />)
    await screen.findByText('实时弹幕')

    await userEvent.click(screen.getByRole('radio', { name: '抖音' }))

    act(() => {
      emit({
        ...idleSnapshot,
        platform: 'douyin',
        metrics: { ...idleSnapshot.metrics, popularity: null },
        unavailable: {
          ...idleSnapshot.unavailable,
          gifts: true,
          superChats: true,
          popularity: true,
        },
      })
    })

    const dashboard = screen.getByRole('complementary', { name: '实时看板' })
    expect(within(dashboard).getAllByText('不可用')).toHaveLength(3)
    expect(within(dashboard).queryByText('¥0.00')).not.toBeInTheDocument()
  })

  it('实时看板使用光谱区分指标、趋势与排行类别', async () => {
    const { emit } = installApi()
    render(<App />)
    await screen.findByText('实时弹幕')

    act(() => {
      emit({
        ...idleSnapshot,
        trend: Array.from({ length: 6 }, (_, index) => ({
          bucketStartMs: 1_700_000_000_000 + index * 10_000,
          danmakuCount: index + 1,
          hasGap: index === 3,
        })),
        keywords: [{ term: '合成高频词', estimatedCount: 12, errorBound: 1 }],
        activeUsers: [{ displayName: '匿名观众甲', danmakuCount: 8 }],
      })
    })

    const dashboard = screen.getByRole('complementary', { name: '实时看板' })
    expect(dashboard.querySelectorAll('[class*="metric-tone-"]')).toHaveLength(6)
    expect(dashboard.querySelectorAll('[class*="trend-spectrum-"]')).toHaveLength(5)
    expect(dashboard.querySelector('.trend-gap')).toBeInTheDocument()
    expect(dashboard.querySelector('.ranking-tone-warm')).toHaveTextContent('合成高频词')
    expect(dashboard.querySelector('.ranking-tone-cool')).toHaveTextContent('匿名观众甲')
  })

  it('可查看历史、搜索弹幕，并在二次确认后删除整场', async () => {
    const { api } = installApi()
    render(<App />)
    await screen.findByText('实时弹幕')

    await userEvent.click(screen.getByRole('button', { name: '历史' }))
    await userEvent.click(await screen.findByRole('button', { name: /测试直播间/ }))
    expect(await screen.findByText('今天的内容很有用')).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText('搜索本场弹幕'), '命中')
    await userEvent.click(screen.getByRole('button', { name: '搜索' }))
    expect(await screen.findByText('搜索命中的弹幕')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '删除整场记录' }))
    const dialog = screen.getByRole('dialog', { name: '删除整场记录' })
    expect(dialog).toHaveTextContent('删除后无法恢复')
    await userEvent.click(within(dialog).getByRole('button', { name: '确认删除' }))

    expect(api.history.deleteSession).toHaveBeenCalledWith(21)
    expect(await screen.findByText('还没有历史场次')).toBeInTheDocument()
  })

  it('历史场次展示观众反馈复盘、分时趋势和可追溯建议', async () => {
    installApi()
    render(<App />)
    await screen.findByText('实时弹幕')

    await userEvent.click(screen.getByRole('button', { name: '历史' }))
    await userEvent.click(await screen.findByRole('button', { name: /测试直播间/ }))

    expect(await screen.findByRole('heading', { name: '直播复盘' })).toBeInTheDocument()
    expect(screen.getByText('活跃发言人数峰值')).toBeInTheDocument()
    expect(screen.getByText('再讲一遍')).toBeInTheDocument()
    expect(screen.getByText(/不是在线观众人数/)).toBeInTheDocument()
    expect(screen.getByText(/存在1次数据缺口/)).toBeInTheDocument()
    expect(screen.getByText(/建议回看/)).toBeInTheDocument()
  })

  it('暂停跟随后提示新消息，并可一键回到最新', async () => {
    const { emit } = installApi()
    render(<App />)
    await screen.findByText('实时弹幕')

    act(() => {
      emit({
        ...idleSnapshot,
        status: 'collecting',
        totalDanmaku: 0,
        recentDanmaku: [
          {
            id: 'new-1',
            receivedAtMs: 1_700_000_400_000,
            displayName: '新观众',
            content: '刚刚到达的新消息',
          },
        ],
      })
    })
    await userEvent.click(screen.getByRole('button', { name: '暂停跟随' }))
    act(() => {
      emit({
        ...idleSnapshot,
        status: 'collecting',
        totalDanmaku: 1,
        recentDanmaku: [
          {
            id: 'new-1',
            receivedAtMs: 1_700_000_400_000,
            displayName: '新观众',
            content: '刚刚到达的新消息',
          },
        ],
      })
    })

    await userEvent.click(screen.getByRole('button', { name: '1条新消息，回到最新' }))
    expect(screen.getByRole('button', { name: '暂停跟随' })).toBeInTheDocument()
  })

  it('历史弹幕达到100条时可以继续加载更早内容', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: 200 - index,
      sessionId: 21,
      receivedAtMs: 1_700_000_200_000 - index,
      displayName: '观众',
      text: `弹幕${index}`,
      medalName: null,
      medalLevel: null,
    }))
    const listDanmaku = vi
      .fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([
        {
          id: 100,
          sessionId: 21,
          receivedAtMs: 1_700_000_100_000,
          displayName: '更早观众',
          text: '更早的弹幕',
          medalName: null,
          medalLevel: null,
        },
      ])
    const { api } = installApi({ listDanmaku })
    render(<App />)
    await screen.findByText('实时弹幕')
    await userEvent.click(screen.getByRole('button', { name: '历史' }))
    await userEvent.click(await screen.findByRole('button', { name: /测试直播间/ }))
    await userEvent.click(await screen.findByRole('button', { name: '加载更早弹幕' }))

    expect(await screen.findByText('更早的弹幕')).toBeInTheDocument()
    expect(api.history.listDanmaku).toHaveBeenLastCalledWith(21, {
      receivedAtMs: firstPage.at(-1)!.receivedAtMs,
      id: firstPage.at(-1)!.id,
    })
  })
})
