import { resolve } from 'node:path'

import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses'
import { VitePlugin } from '@electron-forge/plugin-vite'
import type { ForgeConfig } from '@electron-forge/shared-types'

import { hardenMacosPlist } from './scripts/harden-macos-plist'
import { HdiutilDmgMaker } from './scripts/maker-dmg'
import { WindowsZipMaker } from './scripts/maker-windows-zip'

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    appBundleId: 'com.songjinzhao.danmaku-dashboard',
    appCategoryType: 'public.app-category.utilities',
    buildVersion: '1',
    darwinDarkModeSupport: true,
    icon: 'assets/icon',
    electronZipDir: resolve('.electron-zip-cache'),
    extraResource: ['assets/tray-windows.png'],
    extendInfo: {
      LSMinimumSystemVersion: '13.0',
    },
    ignore: (file) => file.length > 0 && !file.startsWith('/.vite'),
    osxSign: {
      identity: '-',
      identityValidation: false,
      preAutoEntitlements: false,
      preEmbedProvisioningProfile: false,
      optionsForFile: () => ({
        hardenedRuntime: false,
        timestamp: 'none',
      }),
    },
  },
  rebuildConfig: {},
  hooks: {
    packageAfterCopy: async (_config, buildPath, _electronVersion, platform) => {
      const electronBinary =
        platform === 'darwin'
          ? resolve(buildPath, '../../MacOS/Electron')
          : platform === 'win32'
            ? resolve(buildPath, '../../electron.exe')
            : null
      if (electronBinary === null) throw new Error(`UNSUPPORTED_PACKAGE_PLATFORM_${platform}`)
      if (platform === 'darwin') await hardenMacosPlist(buildPath)
      await flipFuses(electronBinary, {
        version: FuseVersion.V1,
        [FuseV1Options.RunAsNode]: false,
        [FuseV1Options.EnableCookieEncryption]: true,
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
        [FuseV1Options.EnableNodeCliInspectArguments]: false,
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
        [FuseV1Options.OnlyLoadAppFromAsar]: true,
        [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
        [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
        [FuseV1Options.WasmTrapHandlers]: true,
        strictlyRequireAllFuses: true,
      })
    },
  },
  makers: [new HdiutilDmgMaker(), new WindowsZipMaker()],
  plugins: [
    new VitePlugin({
      concurrent: 2,
      build: [
        {
          entry: 'src/main/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
        {
          entry: 'src/main/workers/reader.ts',
          config: 'vite.worker.config.ts',
          target: 'main',
        },
        {
          entry: 'src/main/workers/writer.ts',
          config: 'vite.worker.config.ts',
          target: 'main',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
  ],
}

export default config
