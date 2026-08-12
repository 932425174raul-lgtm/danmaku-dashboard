import { readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outRoot = join(projectRoot, 'out')

function requireUnique(kind, paths) {
  if (paths.length !== 1) {
    throw new Error(`${kind}_ARTIFACT_COUNT_${paths.length}`)
  }

  return paths[0]
}

async function listAppCandidates() {
  const candidates = []
  for (const entry of await readdir(outRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith('-darwin-arm64')) {
      continue
    }

    const packageRoot = join(outRoot, entry.name)
    for (const child of await readdir(packageRoot, { withFileTypes: true })) {
      if (child.isDirectory() && child.name.endsWith('.app')) {
        candidates.push(join(packageRoot, child.name))
      }
    }
  }

  return candidates
}

async function listDmgCandidates(directory = outRoot) {
  const candidates = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const childPath = join(directory, entry.name)
    if (entry.isDirectory() && !entry.name.endsWith('.app')) {
      candidates.push(...(await listDmgCandidates(childPath)))
    } else if (entry.isFile() && entry.name.endsWith('.dmg')) {
      candidates.push(childPath)
    }
  }

  return candidates
}

export async function resolveMacosArtifacts({ requireDmg = true } = {}) {
  const appPath = requireUnique('APP', await listAppCandidates())
  const dmgCandidates = await listDmgCandidates()
  const dmgPath = requireDmg ? requireUnique('DMG', dmgCandidates) : dmgCandidates[0]

  return { appPath, dmgPath }
}
