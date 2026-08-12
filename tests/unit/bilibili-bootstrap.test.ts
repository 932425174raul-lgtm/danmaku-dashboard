import { describe, expect, it, vi } from 'vitest'

import { BilibiliBootstrapClient } from '../../src/main/protocol/bilibili-web-v1/bootstrap-client'

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('BilibiliBootstrapClient', () => {
  it('匿名解析真实房间并发现WSS节点', async () => {
    const requests: Array<{ url: string; headers: Headers }> = []
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, headers: new Headers(init?.headers) })
      if (url.includes('/room_init')) {
        return jsonResponse({ code: 0, data: { room_id: 98765, live_status: 1 } })
      }
      if (url.includes('/x/web-interface/nav')) {
        return jsonResponse({
          code: -101,
          data: {
            wbi_img: {
              img_url: 'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
              sub_url: 'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
            },
          },
        })
      }
      if (url.includes('/x/frontend/finger/spi')) {
        return jsonResponse({ code: 0, data: { b_3: 'synthetic-buvid' } })
      }
      if (url.includes('/getDanmuInfo')) {
        return jsonResponse({
          code: 0,
          data: {
            token: 'synthetic-token',
            host_list: [{ host: 'broadcast.example.invalid', wss_port: 443 }],
          },
        })
      }
      throw new Error(`unexpected URL: ${url}`)
    })
    const client = new BilibiliBootstrapClient({
      fetcher,
      now: () => 1_702_204_169_000,
      userAgent: 'DanmakuDashboardSynthetic/1.0',
    })

    await expect(client.resolveRoom('123')).resolves.toEqual({
      inputRoomId: '123',
      roomId: '98765',
      liveStatus: 1,
    })
    await expect(client.discoverTransport('98765')).resolves.toEqual({
      token: 'synthetic-token',
      buvid: 'synthetic-buvid',
      hosts: [{ host: 'broadcast.example.invalid', wssPort: 443 }],
    })

    expect(requests.some((request) => request.url.includes('w_rid='))).toBe(true)
    expect(requests.some((request) => request.url.includes('web_location=444.7'))).toBe(true)
    expect(requests.every((request) => !request.headers.has('cookie'))).toBe(true)
  })
})
