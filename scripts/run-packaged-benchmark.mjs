import { execFile } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { resolveMacosArtifacts } from './resolve-macos-artifacts.mjs'

const run = promisify(execFile)
const profile = process.argv.find((argument) => argument.startsWith('--profile='))?.slice(10)
const expectedCounts = { smoke: 20_000, million: 1_000_000 }

if (!(profile in expectedCounts)) throw new Error('INVALID_PACKAGED_BENCHMARK_PROFILE')

const { appPath } = await resolveMacosArtifacts({ requireDmg: false })
const executableDirectory = join(appPath, 'Contents', 'MacOS')
const executableCandidates = await readdir(executableDirectory)
if (executableCandidates.length !== 1) throw new Error('APP_EXECUTABLE_COUNT_MISMATCH')

const executablePath = join(executableDirectory, executableCandidates[0])
const { stdout } = await run(executablePath, [`--benchmark-profile=${profile}`], {
  timeout: profile === 'million' ? 180_000 : 120_000,
  killSignal: 'SIGKILL',
  maxBuffer: 1024 * 1024,
})
const lines = stdout.trim().split('\n').filter(Boolean)
if (lines.length !== 1) throw new Error('BENCHMARK_OUTPUT_LINE_COUNT')

const result = JSON.parse(lines[0])
if (
  result.status !== 'ok' ||
  result.profile !== profile ||
  result.committed !== expectedCounts[profile] ||
  result.eventsPerSecond < 2_000
) {
  throw new Error('PACKAGED_BENCHMARK_FAILED')
}

process.stdout.write(`${JSON.stringify(result)}\n`)
