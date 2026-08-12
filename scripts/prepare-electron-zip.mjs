import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
const electronVersion = packageJson.devDependencies?.electron

const requestedPlatform = process.argv.find((argument) => argument.startsWith('--platform='))
const requestedArch = process.argv.find((argument) => argument.startsWith('--arch='))
const platform = requestedPlatform?.slice('--platform='.length) ?? process.platform
const arch = requestedArch?.slice('--arch='.length) ?? process.arch
if (!((platform === 'darwin' && arch === 'arm64') || (platform === 'win32' && arch === 'x64'))) {
  throw new Error('UNSUPPORTED_ELECTRON_RUNTIME_TARGET')
}
if (typeof electronVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(electronVersion)) {
  throw new Error('package.json中的Electron版本必须是精确版本号')
}

const zipDirectory = join(projectRoot, '.electron-zip-cache')
const zipPath = join(zipDirectory, `electron-v${electronVersion}-${platform}-${arch}.zip`)

mkdirSync(zipDirectory, { recursive: true })

try {
  if (statSync(zipPath).size > 0) process.exit(0)
} catch {
  // 首次构建时创建本地运行时压缩包。
}

if (platform === 'darwin' && process.platform === 'darwin' && arch === process.arch) {
  const electronApp = join(projectRoot, 'node_modules/electron/dist/Electron.app')
  statSync(electronApp)
  execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', electronApp, zipPath], {
    stdio: 'inherit',
  })
} else {
  const downloadScript = `import { download } from '@electron/get'; const path = await download('${electronVersion}', { platform: '${platform}', arch: '${arch}' }); process.stdout.write(path)`
  const downloadedPath = execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', downloadScript],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  ).trim()
  statSync(downloadedPath)
  copyFileSync(downloadedPath, zipPath)
}
