import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface IdentityKeyProtector {
  isAvailable(): boolean
  encrypt(plainText: string): Buffer
  decrypt(cipherText: Buffer): string
}

export class IdentityKeyStore {
  constructor(
    private readonly filePath: string,
    private readonly protector: IdentityKeyProtector,
  ) {}

  getOrCreate(): Uint8Array {
    if (!this.protector.isAvailable()) throw new Error('IDENTITY_KEY_PROTECTION_UNAVAILABLE')

    try {
      const decrypted = this.protector.decrypt(readFileSync(this.filePath))
      const key = Buffer.from(decrypted, 'base64')
      if (key.byteLength !== 32) throw new Error('INVALID_IDENTITY_KEY')
      return Uint8Array.from(key)
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') {
        throw error
      }
    }

    const key = randomBytes(32)
    const encrypted = this.protector.encrypt(key.toString('base64'))
    const directory = dirname(this.filePath)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`
    writeFileSync(temporaryPath, encrypted, { mode: 0o600, flag: 'wx' })
    renameSync(temporaryPath, this.filePath)
    return Uint8Array.from(key)
  }
}
