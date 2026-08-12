export const benchmarkProfiles = ['smoke', 'million', 'sustained', 'soak'] as const

export type BenchmarkProfile = (typeof benchmarkProfiles)[number]

export type LaunchMode =
  | { kind: 'app' }
  | { kind: 'verify-runtime' }
  | { kind: 'benchmark'; profile: BenchmarkProfile }
  | { kind: 'invalid'; code: 'INVALID_LAUNCH_ARGUMENT' }

const ownedArgumentPrefixes = ['--verify-', '--benchmark-']

export function getDesktopUserAgent(platform: NodeJS.Platform, chromeVersion: string): string {
  const platformToken =
    platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : platform === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : null

  if (platformToken === null) throw new Error('UNSUPPORTED_DESKTOP_PLATFORM')
  return `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
}

export function parseLaunchMode(argv: readonly string[]): LaunchMode {
  const ownedArguments = argv.filter((argument) =>
    ownedArgumentPrefixes.some((prefix) => argument.startsWith(prefix)),
  )

  if (ownedArguments.length === 0) {
    return { kind: 'app' }
  }

  if (ownedArguments.length !== 1) {
    return { kind: 'invalid', code: 'INVALID_LAUNCH_ARGUMENT' }
  }

  const [argument] = ownedArguments
  if (argument === '--verify-runtime') {
    return { kind: 'verify-runtime' }
  }

  const prefix = '--benchmark-profile='
  if (argument?.startsWith(prefix)) {
    const profile = argument.slice(prefix.length)
    if (benchmarkProfiles.some((candidate) => candidate === profile)) {
      return { kind: 'benchmark', profile: profile as BenchmarkProfile }
    }
  }

  return { kind: 'invalid', code: 'INVALID_LAUNCH_ARGUMENT' }
}
