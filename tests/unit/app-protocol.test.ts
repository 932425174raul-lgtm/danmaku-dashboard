import { describe, expect, it } from 'vitest'

import { isAllowedRendererRequest } from '../../src/main/lifecycle/app-protocol'

describe('isAllowedRendererRequest', () => {
  it('只允许renderer主机上的只读静态资源请求', () => {
    expect(isAllowedRendererRequest('app://renderer/index.html', 'GET')).toBe(true)
    expect(isAllowedRendererRequest('app://renderer/assets/main.css', 'GET')).toBe(true)
    expect(isAllowedRendererRequest('https://renderer/index.html', 'GET')).toBe(false)
    expect(isAllowedRendererRequest('app://other/index.html', 'GET')).toBe(false)
    expect(isAllowedRendererRequest('app://renderer:4310/index.html', 'GET')).toBe(false)
    expect(isAllowedRendererRequest('app://renderer/index.html', 'POST')).toBe(false)
    expect(isAllowedRendererRequest('app://renderer/%2e%2e/private', 'GET')).toBe(false)
  })
})
