// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  DanmakuAppApi,
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
