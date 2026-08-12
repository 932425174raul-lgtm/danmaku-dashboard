import { describe, expect, it } from 'vitest'

import { createRuntimeSummary } from '../../src/main/verification/runtime-summary'

describe('createRuntimeSummary', () => {
  it('只有全部固定探针通过时才返回ok', () => {
    const evidence = {
      mainSqlite: true,
      writerSqlite: true,
      readerSqlite: true,
      fts5Trigram: true,
      wal: true,
      foreignKeys: true,
      busyTimeout: true,
      backup: true,
      safeStorage: true,
    }

    expect(createRuntimeSummary(evidence, { electron: '43.2.0', node: '24.18.0' })).toEqual({
      schemaVersion: 1,
      status: 'ok',
      checks: evidence,
      runtime: { electron: '43.2.0', node: '24.18.0' },
    })

    expect(
      createRuntimeSummary({ ...evidence, backup: false }, { electron: '43.2.0', node: '24.18.0' }),
    ).toEqual({
      schemaVersion: 1,
      status: 'error',
      code: 'RUNTIME_PROBE_FAILED',
    })
  })
})
