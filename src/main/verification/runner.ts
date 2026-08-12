import type { SafeStorage } from 'electron'

import { getWorkerPath } from '../paths'
import { runRuntimeProbe } from './runtime-probe'

export async function runRuntimeVerification(
  safeStorage: SafeStorage,
  bundleDirectory: string,
): Promise<number> {
  const summary = await runRuntimeProbe(safeStorage, {
    writer: getWorkerPath(bundleDirectory, 'writer'),
    reader: getWorkerPath(bundleDirectory, 'reader'),
  })
  process.stdout.write(`${JSON.stringify(summary)}\n`)
  return summary.status === 'ok' ? 0 : 1
}
