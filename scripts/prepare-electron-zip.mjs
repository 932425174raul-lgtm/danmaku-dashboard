import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'))
const electronVersion = packageJson.devDependencies?.electron

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('本项目第一版只支持在Apple Silicon Mac上构建')
}
if (typeof electronVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(electronVersion)) {
  throw new Error('package.json中的Electron版本必须是精确版本号')
}

const electronApp = join(projectRoot, 'node_modules/electron/dist/Electron.app')
const zipDirectory = join(projectRoot, '.electron-zip-cache')
const zipPath = join(zipDirectory, `electron-v${electronVersion}-darwin-arm64.zip`)

statSync(electronApp)
mkdirSync(zipDirectory, { recursive: true })

try {
  if (statSync(zipPath).size > 0) process.exit(0)
} catch {
  // 首次构建时创建本地运行时压缩包。
}

execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', electronApp, zipPath], {
  stdio: 'inherit',
})
