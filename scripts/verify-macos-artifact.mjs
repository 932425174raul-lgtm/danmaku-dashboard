import { execFile } from 'node:child_process'
import { lstat, mkdtemp, readFile, readlink, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

import { listPackage } from '@electron/asar'
import { getCurrentFuseWire } from '@electron/fuses'

import { resolveMacosArtifacts } from './resolve-macos-artifacts.mjs'

const execFileAsync = promisify(execFile)

function assert(condition, code) {
  if (!condition) {
    throw new Error(code)
  }
}

async function run(file, args, options = {}) {
  return execFileAsync(file, args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  })
}

async function readPlistValue(plistPath, key) {
  const { stdout } = await run('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', plistPath])
  return stdout.trim()
}

async function assertPlistKeyAbsent(plistPath, key) {
  try {
    await readPlistValue(plistPath, key)
    throw new Error(`PLIST_KEY_PRESENT_${key}`)
  } catch (error) {
    if (error instanceof Error && error.message === `PLIST_KEY_PRESENT_${key}`) {
      throw error
    }
    const stderr =
      typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr) : ''
    if (!stderr.includes('No value at that key path')) {
      throw error
    }
  }
}

async function verifyDmg(dmgPath, appPath) {
  await run('/usr/bin/hdiutil', ['verify', dmgPath], { timeout: 60_000 })
  const { stdout: formatOutput } = await run('/usr/bin/file', [dmgPath])
  assert(formatOutput.includes('lzfse encoded'), 'DMG_FORMAT_NOT_ULFO')

  const mountPath = await mkdtemp(join(tmpdir(), 'danmaku-dashboard-mount-'))
  let isMounted = false
  try {
    await run('/usr/bin/hdiutil', [
      'attach',
      '-readonly',
      '-nobrowse',
      '-noautoopen',
      '-mountpoint',
      mountPath,
      dmgPath,
    ])
    isMounted = true

    const entries = await readdir(mountPath)
    const appName = basename(appPath)
    assert(entries.includes(appName), 'DMG_APP_MISSING')
    assert((await lstat(join(mountPath, appName))).isDirectory(), 'DMG_APP_NOT_DIRECTORY')
    assert(
      (await lstat(join(mountPath, 'Applications'))).isSymbolicLink(),
      'DMG_APPLICATIONS_NOT_LINK',
    )
    assert(
      (await readlink(join(mountPath, 'Applications'))) === '/Applications',
      'DMG_APPLICATIONS_LINK_TARGET_MISMATCH',
    )
  } finally {
    if (isMounted) {
      await run('/usr/bin/hdiutil', ['detach', mountPath])
    }
    await rm(mountPath, { recursive: true, force: true })
  }
}

async function verifyRuntime(executablePath) {
  const { stdout } = await run(executablePath, ['--verify-runtime'], {
    timeout: 30_000,
    killSignal: 'SIGKILL',
  })
  const lines = stdout.trim().split('\n').filter(Boolean)
  assert(lines.length === 1, 'RUNTIME_OUTPUT_LINE_COUNT')

  const result = JSON.parse(lines[0])
  assert(result.status === 'ok', 'RUNTIME_STATUS_NOT_OK')
  for (const check of [
    'mainSqlite',
    'writerSqlite',
    'readerSqlite',
    'fts5Trigram',
    'wal',
    'foreignKeys',
    'busyTimeout',
    'backup',
    'safeStorage',
  ]) {
    assert(result.checks?.[check] === true, `RUNTIME_${check}_NOT_OK`)
  }
}

async function verifyBenchmark(executablePath) {
  const { stdout } = await run(executablePath, ['--benchmark-profile=smoke'], {
    timeout: 120_000,
    killSignal: 'SIGKILL',
  })
  const lines = stdout.trim().split('\n').filter(Boolean)
  assert(lines.length === 1, 'BENCHMARK_OUTPUT_LINE_COUNT')
  const result = JSON.parse(lines[0])
  assert(result.status === 'ok', 'BENCHMARK_STATUS_NOT_OK')
  assert(result.committed === 20_000, 'BENCHMARK_COMMITTED_MISMATCH')
  assert(result.eventsPerSecond >= 200, 'BENCHMARK_THROUGHPUT_TOO_LOW')
}

async function main() {
  const { appPath, dmgPath } = await resolveMacosArtifacts()
  const plistPath = join(appPath, 'Contents', 'Info.plist')
  const executableName = await readPlistValue(plistPath, 'CFBundleExecutable')
  const executablePath = join(appPath, 'Contents', 'MacOS', executableName)
  const asarPath = join(appPath, 'Contents', 'Resources', 'app.asar')

  assert(
    (await readPlistValue(plistPath, 'CFBundleIdentifier')) === 'com.songjinzhao.danmaku-dashboard',
    'BUNDLE_IDENTIFIER_MISMATCH',
  )
  assert(
    (await readPlistValue(plistPath, 'LSMinimumSystemVersion')) === '13.0',
    'MINIMUM_MACOS_MISMATCH',
  )
  assert((await readPlistValue(plistPath, 'CFBundleVersion')) === '1', 'BUNDLE_VERSION_MISMATCH')

  for (const key of [
    'NSAudioCaptureUsageDescription',
    'NSBluetoothAlwaysUsageDescription',
    'NSBluetoothPeripheralUsageDescription',
    'NSCameraUsageDescription',
    'NSMicrophoneUsageDescription',
    'NSAppTransportSecurity',
  ]) {
    await assertPlistKeyAbsent(plistPath, key)
  }

  const { stdout: architectures } = await run('/usr/bin/lipo', ['-archs', executablePath])
  assert(architectures.trim() === 'arm64', 'EXECUTABLE_NOT_THIN_ARM64')
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
  const { stderr: signatureDetails } = await run('/usr/bin/codesign', [
    '-dv',
    '--verbose=4',
    appPath,
  ])
  assert(signatureDetails.includes('Signature=adhoc'), 'SIGNATURE_NOT_ADHOC')
  assert(signatureDetails.includes('TeamIdentifier=not set'), 'SIGNATURE_TEAM_PRESENT')

  const expectedFuses = ['0', '1', '0', '0', '1', '1', '0', '0', '1']
  const fuseWire = await getCurrentFuseWire(executablePath)
  assert(fuseWire.version === '1', 'FUSE_VERSION_MISMATCH')
  for (const [index, expected] of expectedFuses.entries()) {
    assert(String.fromCharCode(fuseWire[index]) === expected, `FUSE_${index}_MISMATCH`)
  }

  const asarEntries = listPackage(asarPath, { isPack: false })
  assert(asarEntries.includes('/.vite/build/main.js'), 'ASAR_MAIN_MISSING')
  assert(asarEntries.includes('/.vite/build/preload.js'), 'ASAR_PRELOAD_MISSING')
  for (const forbiddenPrefix of ['/src/', '/tests/', '/docs/', '/scripts/']) {
    assert(
      !asarEntries.some((entry) => entry.startsWith(forbiddenPrefix)),
      `ASAR_FORBIDDEN_${forbiddenPrefix}`,
    )
  }

  const plistBuffer = await readFile(plistPath)
  assert(!plistBuffer.includes('NSAllowsArbitraryLoads'), 'ATS_ARBITRARY_LOADS_PRESENT')
  await verifyRuntime(executablePath)
  await verifyBenchmark(executablePath)
  await verifyDmg(dmgPath, appPath)

  process.stdout.write(
    `${JSON.stringify({ status: 'ok', arch: 'arm64', app: appPath, dmg: dmgPath })}\n`,
  )
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'ARTIFACT_VERIFICATION_FAILED'
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
})
