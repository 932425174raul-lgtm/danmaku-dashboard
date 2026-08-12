import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { _electron as electron, chromium } from '@playwright/test'

import { decodeDouyinPushFrame } from '../src/main/protocol/douyin-web-v1/push-frame.ts'

const mainEntryPath = join(process.cwd(), '.vite', 'build', 'main.js')

function writeSummary(summary) {
  process.stdout.write(`${JSON.stringify(summary)}\n`)
}

async function discoverPublicRoom() {
  let browser
  try {
    browser = await chromium.launch({ headless: true })
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("Executable doesn't exist")) {
      throw error
    }
    browser = await chromium.launch({ channel: 'chrome', headless: true })
  }
  const diagnostics = {
    candidateCount: 0,
    websocketCount: 0,
    binaryFrameCount: 0,
    decodedFrameCount: 0,
    chatFrameCount: 0,
  }
  try {
    const context = await browser.newContext({
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      serviceWorkers: 'block',
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    })
    const page = await context.newPage()
    const response = await page
      .goto('https://live.douyin.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      })
      .catch(() => null)
    if (response?.ok() !== true) return null
    await page.waitForTimeout(2_000)
    for (let index = 0; index < 5; index += 1) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5))
      await page.waitForTimeout(700)
    }
    const candidates = await page.locator('a[href]').evaluateAll((anchors) => {
      const rooms = []
      for (const anchor of anchors) {
        const href = anchor.getAttribute('href')
        if (href === null) continue
        try {
          const candidate = new URL(href, window.location.href)
          if (
            candidate.origin === window.location.origin &&
            /^\/\d+\/?$/.test(candidate.pathname)
          ) {
            const normalized = candidate.href.replace(/\/$/, '')
            if (!rooms.includes(normalized)) rooms.push(normalized)
            if (rooms.length >= 15) break
          }
        } catch {
          continue
        }
      }
      return rooms
    })
    diagnostics.candidateCount = candidates.length

    async function hasLiveChat(candidate) {
      const roomPage = await context.newPage()
      let resolveChat
      const chatSeen = new Promise((resolve) => {
        resolveChat = resolve
      })

      roomPage.on('websocket', (socket) => {
        let socketUrl
        try {
          socketUrl = new URL(socket.url())
        } catch {
          return
        }
        if (!socketUrl.pathname.startsWith('/webcast/im/push/v2')) return
        diagnostics.websocketCount += 1

        socket.on('framereceived', ({ payload }) => {
          if (!Buffer.isBuffer(payload)) return
          diagnostics.binaryFrameCount += 1
          try {
            const decoded = decodeDouyinPushFrame(new Uint8Array(payload))
            diagnostics.decodedFrameCount += 1
            if (decoded.messageMethods.includes('WebcastChatMessage')) {
              diagnostics.chatFrameCount += 1
              resolveChat(true)
            }
          } catch {
            return
          }
        })
      })

      await roomPage
        .goto(candidate, { waitUntil: 'domcontentloaded', timeout: 30_000 })
        .catch(() => null)
      const active = await Promise.race([
        chatSeen,
        roomPage.waitForTimeout(12_000).then(() => false),
      ])
      await roomPage.close()
      return active
    }

    for (let index = 0; index < candidates.length; index += 5) {
      const batch = candidates.slice(index, index + 5)
      const results = await Promise.all(batch.map((candidate) => hasLiveChat(candidate)))
      const activeIndex = results.findIndex(Boolean)
      if (activeIndex >= 0) return { roomUrl: batch[activeIndex], diagnostics }
    }

    return { roomUrl: null, diagnostics }
  } finally {
    await browser.close()
  }
}

async function main() {
  if (!existsSync(mainEntryPath)) {
    writeSummary({ schemaVersion: 1, status: 'error', code: 'APP_NOT_BUILT' })
    process.exitCode = 1
    return
  }

  const discovery = await discoverPublicRoom()
  if (discovery === null || discovery.roomUrl === null) {
    writeSummary({
      schemaVersion: 1,
      status: 'error',
      code: 'NO_PUBLIC_LIVE_ROOM',
      diagnostics: discovery?.diagnostics ?? null,
    })
    process.exitCode = 1
    return
  }
  const { roomUrl } = discovery

  let stage = 'launch'
  const application = await electron.launch({ args: [mainEntryPath] })
  let mainWindow = null
  try {
    stage = 'window'
    const window = await application.firstWindow()
    mainWindow = window
    const rendererErrors = []
    window.on('console', (message) => {
      if (message.type() === 'error') rendererErrors.push(message.text())
    })
    window.on('pageerror', (error) => rendererErrors.push(error.name))
    stage = 'input'
    const roomInput = window.getByLabel('抖音直播间号或直播链接')
    await roomInput.waitFor({ timeout: 15_000 })
    const initialViewportAtTop = await window.evaluate(() => window.scrollY === 0)
    await window.screenshot({ path: '/private/tmp/douyin-dashboard-idle.png' })
    stage = 'responsive-layout'
    await window.setViewportSize({ width: 700, height: 760 })
    const mobileTabsVisible = await window.getByRole('tablist', { name: '实时内容' }).isVisible()
    const narrowOverflow = await window.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    )
    await window.setViewportSize({ width: 1280, height: 800 })
    stage = 'input'
    await roomInput.fill(roomUrl)
    stage = 'start-button'
    await window.getByRole('button', { name: '开始采集' }).click()
    stage = 'collecting'
    await window.locator('.status-pill', { hasText: '正在采集' }).waitFor({ timeout: 45_000 })
    stage = 'danmaku'
    await window.locator('.danmaku-row').first().waitFor({ timeout: 60_000 })

    stage = 'background'
    const hidden = await application.evaluate(({ BrowserWindow }) => {
      const rendererWindow = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().startsWith('app://renderer'),
      )
      if (rendererWindow === undefined) return false
      rendererWindow.hide()
      return true
    })
    await window.waitForTimeout(1_500)
    const backgroundStatus = await window.evaluate(async () => {
      const snapshot = await window.danmakuApp.live.getSnapshot()
      return snapshot.status
    })
    await application.evaluate(({ BrowserWindow }) => {
      const rendererWindow = BrowserWindow.getAllWindows().find((candidate) =>
        candidate.webContents.getURL().startsWith('app://renderer'),
      )
      rendererWindow?.show()
      rendererWindow?.focus()
    })

    const danmakuRows = await window.locator('.danmaku-row').count()
    const unavailableLabels = await window.getByText('不可用', { exact: true }).count()
    const horizontalOverflow = await window.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    )

    stage = 'stop'
    await window.getByRole('button', { name: '停止采集' }).click()
    await window.locator('.status-pill', { hasText: '已停止' }).waitFor({ timeout: 10_000 })

    const checks = {
      collecting: true,
      liveDanmaku: danmakuRows > 0,
      backgroundCollection: hidden && backgroundStatus === 'collecting',
      rendererConsoleClean: rendererErrors.length === 0,
      initialViewportAtTop,
      unavailableSemantics: unavailableLabels >= 4,
      responsiveLayout: mobileTabsVisible && !narrowOverflow,
      noHorizontalOverflow: !horizontalOverflow && !narrowOverflow,
      stopped: true,
    }
    const passed = Object.values(checks).every(Boolean)
    writeSummary({
      schemaVersion: 1,
      status: passed ? 'ok' : 'error',
      ...(passed ? {} : { code: 'DASHBOARD_CHECK_FAILED', rendererErrors }),
      checks,
    })
    if (!passed) process.exitCode = 1
  } catch {
    let runtime = null
    if (mainWindow !== null) {
      runtime = await mainWindow
        .evaluate(async () => {
          const snapshot = await window.danmakuApp.live.getSnapshot()
          return {
            status: snapshot.status,
            errorCode: snapshot.errorCode,
            totalDanmaku: snapshot.totalDanmaku,
          }
        })
        .catch(() => null)
    }
    const pageKinds = application.windows().map((page) => {
      try {
        const url = new URL(page.url())
        if (url.protocol === 'app:' && url.hostname === 'renderer') return 'renderer'
        if (url.origin === 'https://live.douyin.com') return 'douyin-live'
        if (url.href === 'about:blank') return 'blank'
        return 'other'
      } catch {
        return 'unknown'
      }
    })
    writeSummary({
      schemaVersion: 1,
      status: 'error',
      code: 'DASHBOARD_RUNTIME_FAILED',
      stage,
      runtime,
      pageKinds,
    })
    process.exitCode = 1
  } finally {
    await application.close()
  }
}

await main()
