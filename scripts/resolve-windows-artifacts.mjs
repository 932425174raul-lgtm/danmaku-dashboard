import { readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outRoot = join(projectRoot, 'out')

function requireUnique(kind, paths) {
  if (paths.length !== 1) throw new Error(`${kind}_ARTIFACT_COUNT_${paths.length}`)
  return paths[0]
}

async function listFiles(directory, extension) {
  const candidates = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const childPath = join(directory, entry.name)
    if (entry.isDirectory()) candidates.push(...(await listFiles(childPath, extension)))
    else if (entry.isFile() && entry.name.endsWith(extension)) candidates.push(childPath)
  }
  return candidates
}

export async function resolveWindowsArtifacts() {
  const packageRoot = join(outRoot, '弹幕看板-win32-x64')
  const executablePath = join(packageRoot, '弹幕看板.exe')
  const zipPath = requireUnique(
    'WINDOWS_ZIP',
    await listFiles(join(outRoot, 'make', 'zip', 'win32', 'x64'), '.zip'),
  )
  return { packageRoot, executablePath, zipPath }
}
