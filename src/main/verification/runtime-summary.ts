export interface RuntimeProbeEvidence {
  mainSqlite: boolean
  writerSqlite: boolean
  readerSqlite: boolean
  fts5Trigram: boolean
  wal: boolean
  foreignKeys: boolean
  busyTimeout: boolean
  backup: boolean
  safeStorage: boolean
}

export interface RuntimeVersions {
  electron: string
  node: string
}

export type RuntimeSummary =
  | {
      schemaVersion: 1
      status: 'ok'
      checks: RuntimeProbeEvidence
      runtime: RuntimeVersions
    }
  | {
      schemaVersion: 1
      status: 'error'
      code: 'RUNTIME_PROBE_FAILED'
    }

export function createRuntimeSummary(
  evidence: RuntimeProbeEvidence,
  runtime: RuntimeVersions,
): RuntimeSummary {
  if (Object.values(evidence).every((value) => value)) {
    return {
      schemaVersion: 1,
      status: 'ok',
      checks: evidence,
      runtime,
    }
  }

  return {
    schemaVersion: 1,
    status: 'error',
    code: 'RUNTIME_PROBE_FAILED',
  }
}
