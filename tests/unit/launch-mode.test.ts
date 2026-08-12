import { describe, expect, it } from 'vitest'

import { parseLaunchMode } from '../../src/main/environment'

describe('parseLaunchMode', () => {
  it('只接受固定的正式验证参数', () => {
    expect(parseLaunchMode(['Electron', 'app', '--verify-runtime'])).toEqual({
      kind: 'verify-runtime',
    })
    expect(parseLaunchMode(['Electron', 'app', '--benchmark-profile=smoke'])).toEqual({
      kind: 'benchmark',
      profile: 'smoke',
    })
    expect(parseLaunchMode(['Electron', 'app', '--benchmark-profile=custom'])).toEqual({
      kind: 'invalid',
      code: 'INVALID_LAUNCH_ARGUMENT',
    })
    expect(parseLaunchMode(['Electron', 'app', '--verify-runtime', '--verify-runtime'])).toEqual({
      kind: 'invalid',
      code: 'INVALID_LAUNCH_ARGUMENT',
    })
  })
})
