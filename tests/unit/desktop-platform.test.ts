import { posix, win32 } from 'node:path'

import { describe, expect, it } from 'vitest'

import { getDesktopUserAgent } from '../../src/main/environment'
import { resolveSessionDataPath } from '../../src/main/paths'

describe('desktop platform boundary', () => {
  it('uses a platform-matching desktop user agent', () => {
    expect(getDesktopUserAgent('darwin', '150.0.0.0')).toContain(
      'Macintosh; Intel Mac OS X 10_15_7',
    )
    expect(getDesktopUserAgent('win32', '150.0.0.0')).toContain('Windows NT 10.0; Win64; x64')
    expect(() => getDesktopUserAgent('linux', '150.0.0.0')).toThrow('UNSUPPORTED_DESKTOP_PLATFORM')
  })

  it('keeps Chromium data in the platform-specific application directory', () => {
    expect(
      resolveSessionDataPath('darwin', {
        home: '/Users/example',
        userData: '/Users/example/Library/Application Support/弹幕看板',
      }),
    ).toBe(
      posix.join(
        '/Users/example',
        'Library',
        'Caches',
        'com.songjinzhao.danmaku-dashboard',
        'Chromium',
      ),
    )
    expect(
      resolveSessionDataPath('win32', {
        home: 'C:\\Users\\example',
        userData: 'C:\\Users\\example\\AppData\\Roaming\\弹幕看板',
      }),
    ).toBe(win32.join('C:\\Users\\example\\AppData\\Roaming\\弹幕看板', 'Chromium'))
  })
})
