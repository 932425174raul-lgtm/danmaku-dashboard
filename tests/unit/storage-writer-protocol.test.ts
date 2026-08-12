import { describe, expect, it } from 'vitest'

import { parseStorageWriterCommand } from '../../src/main/workers/storage-writer-protocol'

describe('storage writer内部协议', () => {
  it('拒绝命令中的SQL和任意路径', () => {
    expect(() =>
      parseStorageWriterCommand({
        kind: 'storage-command',
        id: 1,
        command: 'initialize',
        payload: null,
        databasePath: '/tmp/other.sqlite3',
      }),
    ).toThrow()
    expect(() =>
      parseStorageWriterCommand({
        kind: 'storage-command',
        id: 2,
        command: 'appendBatch',
        payload: { sessionId: 1, events: [], sql: 'DELETE FROM sessions' },
      }),
    ).toThrow()
  })
})
