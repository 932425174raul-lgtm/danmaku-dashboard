import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'

const blockedPathEncoding = /(?:\.\.|%2e|%2f|%5c)/i

const contentTypes: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

export interface RendererProtocolApi {
  registerSchemesAsPrivileged(
    schemes: Array<{
      scheme: string
      privileges: {
        standard: boolean
        secure: boolean
        supportFetchAPI: boolean
        corsEnabled: boolean
        stream: boolean
      }
    }>,
  ): void
  handle(scheme: string, handler: (request: Request) => Promise<Response>): void
}

export function isAllowedRendererRequest(rawUrl: string, method: string): boolean {
  if (method !== 'GET' || blockedPathEncoding.test(rawUrl)) {
    return false
  }

  try {
    const url = new URL(rawUrl)
    return (
      url.protocol === 'app:' &&
      url.hostname === 'renderer' &&
      url.port === '' &&
      url.username === '' &&
      url.password === ''
    )
  } catch {
    return false
  }
}

export function registerRendererScheme(protocolApi: RendererProtocolApi): void {
  protocolApi.registerSchemesAsPrivileged([
    {
      scheme: 'app',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: false,
        stream: true,
      },
    },
  ])
}

export function installRendererProtocol(
  protocolApi: RendererProtocolApi,
  rendererRoot: string,
): void {
  const absoluteRoot = resolve(rendererRoot)

  protocolApi.handle('app', async (request) => {
    if (!isAllowedRendererRequest(request.url, request.method)) {
      return new Response(null, { status: 403 })
    }

    const url = new URL(request.url)
    const relativePath =
      url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1))
    const filePath = resolve(absoluteRoot, relativePath)
    if (filePath !== absoluteRoot && !filePath.startsWith(`${absoluteRoot}${sep}`)) {
      return new Response(null, { status: 403 })
    }

    try {
      const body = await readFile(filePath)
      return new Response(body, {
        headers: {
          'Cache-Control': 'no-store',
          'Content-Security-Policy':
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
          'Content-Type': contentTypes[extname(filePath)] ?? 'application/octet-stream',
          'Cross-Origin-Opener-Policy': 'same-origin',
          'X-Content-Type-Options': 'nosniff',
        },
      })
    } catch {
      return new Response(null, { status: 404 })
    }
  })
}
