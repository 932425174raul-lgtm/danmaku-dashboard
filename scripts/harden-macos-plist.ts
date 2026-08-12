import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const UNUSED_PERMISSION_KEYS = [
  'NSAudioCaptureUsageDescription',
  'NSBluetoothAlwaysUsageDescription',
  'NSBluetoothPeripheralUsageDescription',
  'NSCameraUsageDescription',
  'NSMicrophoneUsageDescription',
  'NSAppTransportSecurity',
] as const

export async function hardenMacosPlist(buildPath: string): Promise<void> {
  const plistPath = resolve(buildPath, '../../Info.plist')

  for (const key of UNUSED_PERMISSION_KEYS) {
    try {
      await execFileAsync('/usr/bin/plutil', ['-remove', key, plistPath])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('Could not modify plist')) {
        throw error
      }
    }
  }
}
