export interface WriterRuntimeProbeRequest {
  kind: 'runtime-probe'
  databasePath: string
  backupPath: string
}

export interface ReaderRuntimeProbeRequest {
  kind: 'runtime-probe'
  databasePath: string
}

export interface WriterRuntimeProbeResult {
  role: 'writer'
  ok: boolean
  fts5Trigram: boolean
  wal: boolean
  foreignKeys: boolean
  busyTimeout: boolean
  backup: boolean
}

export interface ReaderRuntimeProbeResult {
  role: 'reader'
  ok: boolean
}

export type RuntimeProbeWorkerResult = WriterRuntimeProbeResult | ReaderRuntimeProbeResult
