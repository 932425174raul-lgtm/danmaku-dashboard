import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { listPackage } from '@electron/asar'
import { getCurrentFuseWire } from '@electron/fuses'

import { resolveWindowsArtifacts } from './resolve-windows-artifacts.mjs'

const run = promisify(execFile)

function assert(condition, code) {
  if (!condition) throw new Error(code)
}

function normalizeArchiveEntry(entry) {
  const normalized = entry.replaceAll('\\', '/')
  return normalized.startsWith('/') ? normalized : `/${normalized}`
}

function verifyPeX64(executable) {
  assert(executable.subarray(0, 2).equals(Buffer.from('MZ')), 'EXECUTABLE_NOT_PE')
  const peOffset = executable.readUInt32LE(0x3c)
  assert(
    executable.subarray(peOffset, peOffset + 4).equals(Buffer.from('PE\0\0')),
    'PE_HEADER_MISSING',
  )
  assert(executable.readUInt16LE(peOffset + 4) === 0x8664, 'EXECUTABLE_NOT_X64')
}

async function verifyIcon(executable) {
  const { NtExecutable, NtExecutableResource, Resource } = await import('resedit')
  const parsed = NtExecutable.from(executable)
  const resources = NtExecutableResource.from(parsed)
  const iconGroups = Resource.IconGroupEntry.fromEntries(resources.entries)
  assert(iconGroups.length === 1, 'WINDOWS_ICON_GROUP_MISSING')
  assert(
    iconGroups[0].icons.some((icon) => icon.width >= 32),
    'WINDOWS_ICON_SIZE_MISSING',
  )
}

function verifyZipUtf8Entry(zip, entryName) {
  const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06])
  const endOffset = zip.lastIndexOf(endSignature)
  if (endOffset < 0 || endOffset + 22 > zip.length) return false
  const entryCount = zip.readUInt16LE(endOffset + 10)
  let offset = zip.readUInt32LE(endOffset + 16)
  for (let entryIndex = 0; entryIndex < entryCount; entryIndex += 1) {
    if (offset + 46 > endOffset || zip.readUInt32LE(offset) !== 0x02014b50) return false
    const flags = zip.readUInt16LE(offset + 8)
    const nameLength = zip.readUInt16LE(offset + 28)
    const extraLength = zip.readUInt16LE(offset + 30)
    const commentLength = zip.readUInt16LE(offset + 32)
    const name = zip.subarray(offset + 46, offset + 46 + nameLength)
    if (name.equals(Buffer.from(entryName, 'utf8'))) return (flags & 0x0800) !== 0
    offset += 46 + nameLength + extraLength + commentLength
  }
  return false
}

async function verifyRuntime(executablePath, args, timeout) {
  const { stdout } = await run(executablePath, args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout,
  })
  const lines = stdout.trim().split('\n').filter(Boolean)
  assert(lines.length === 1, 'RUNTIME_OUTPUT_LINE_COUNT')
  return JSON.parse(lines[0])
}

async function main() {
  const { packageRoot, executablePath, zipPath } = await resolveWindowsArtifacts()
  const asarPath = join(packageRoot, 'resources', 'app.asar')
  const executable = await readFile(executablePath)
  const zip = await readFile(zipPath)
  verifyPeX64(executable)
  await verifyIcon(executable)
  assert(zip.subarray(0, 2).equals(Buffer.from('PK')), 'ZIP_HEADER_MISSING')
  assert((await stat(zipPath)).size > 50 * 1024 * 1024, 'ZIP_UNEXPECTEDLY_SMALL')
  assert(
    verifyZipUtf8Entry(zip, '弹幕看板-win32-x64/弹幕看板.exe'),
    'ZIP_UTF8_EXECUTABLE_NAME_MISSING',
  )

  const expectedFuses = ['0', '1', '0', '0', '1', '1', '0', '0', '1']
  const fuseWire = await getCurrentFuseWire(executablePath)
  assert(fuseWire.version === '1', 'FUSE_VERSION_MISMATCH')
  for (const [index, expected] of expectedFuses.entries()) {
    assert(String.fromCharCode(fuseWire[index]) === expected, `FUSE_${index}_MISMATCH`)
  }

  const asarEntries = listPackage(asarPath, { isPack: false }).map(normalizeArchiveEntry)
  for (const requiredEntry of [
    '/.vite/build/main.js',
    '/.vite/build/preload.js',
    '/.vite/build/reader.js',
    '/.vite/build/writer.js',
    '/.vite/renderer/main_window/index.html',
  ]) {
    assert(asarEntries.includes(requiredEntry), `ASAR_REQUIRED_ENTRY_MISSING_${requiredEntry}`)
  }
  for (const forbiddenPrefix of ['/src/', '/tests/', '/docs/', '/scripts/']) {
    assert(
      !asarEntries.some((entry) => entry.startsWith(forbiddenPrefix)),
      `ASAR_FORBIDDEN_${forbiddenPrefix}`,
    )
  }

  let runtime = 'static-only'
  if (process.platform === 'win32') {
    const runtimeResult = await verifyRuntime(executablePath, ['--verify-runtime'], 30_000)
    assert(runtimeResult.status === 'ok', 'RUNTIME_STATUS_NOT_OK')
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
      assert(runtimeResult.checks?.[check] === true, `RUNTIME_${check}_NOT_OK`)
    }
    const benchmark = await verifyRuntime(executablePath, ['--benchmark-profile=smoke'], 120_000)
    assert(benchmark.status === 'ok', 'BENCHMARK_STATUS_NOT_OK')
    assert(benchmark.committed === 20_000, 'BENCHMARK_COMMITTED_MISMATCH')
    assert(benchmark.eventsPerSecond >= 200, 'BENCHMARK_THROUGHPUT_TOO_LOW')
    runtime = 'verified'
  }

  process.stdout.write(
    `${JSON.stringify({ status: 'ok', arch: 'x64', runtime, executable: executablePath, zip: zipPath })}\n`,
  )
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'ARTIFACT_VERIFICATION_FAILED'}\n`,
  )
  process.exitCode = 1
})
