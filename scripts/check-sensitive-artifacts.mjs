import { readFile, readdir } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'

const projectRoot = resolve(import.meta.dirname, '..')
const scanRoots = ['src', 'scripts', 'tests']
const allowedExtensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.json'])
const forbiddenPatterns = [
  { code: 'COOKIE_VALUE', pattern: /(?:SESSDATA|bili_jct|DedeUserID)\s*[=:]\s*['"][^'"]+/giu },
  {
    code: 'AUTHORIZATION_VALUE',
    pattern: /authorization\s*[=:]\s*['"](?:bearer|basic)\s+[^'"]+/giu,
  },
  {
    code: 'RAW_FRAME_LOGGING',
    pattern: /console\.(?:log|error|warn)\([^\n]*(?:raw|frame|packet|body)/giu,
  },
]

async function collect(directory) {
  const output = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) output.push(...(await collect(path)))
    else if (allowedExtensions.has(extname(entry.name))) output.push(path)
  }
  return output
}

const findings = []
for (const root of scanRoots) {
  for (const path of await collect(join(projectRoot, root))) {
    const content = await readFile(path, 'utf8')
    for (const { code, pattern } of forbiddenPatterns) {
      pattern.lastIndex = 0
      if (pattern.test(content)) findings.push({ code, file: relative(projectRoot, path) })
    }
  }
}

if (findings.length > 0) {
  process.stderr.write(`${JSON.stringify({ status: 'error', findings })}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`${JSON.stringify({ status: 'ok', filesScanned: scanRoots.length })}\n`)
}
