import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { IdentityKeyStore } from '../../src/main/storage/identity-key-store'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('IdentityKeyStore', () => {
  it('生成32字节密钥并以受保护形式原子持久化', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'danmaku-dashboard-key-'))
    directories.push(directory)
    const filePath = join(directory, 'identity-key')
    const protector = {
      encrypt: (plainText: string) => Buffer.from(`protected:${plainText}`, 'utf8'),
      decrypt: (cipherText: Buffer) => cipherText.toString('utf8').replace(/^protected:/u, ''),
      isAvailable: () => true,
    }

    const first = new IdentityKeyStore(filePath, protector).getOrCreate()
    const second = new IdentityKeyStore(filePath, protector).getOrCreate()

    expect(first).toHaveLength(32)
    expect(second).toEqual(first)
  })
})
