import { createHash } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import type { PlatformHelper } from './platform/helper.js'
import { isWithin } from './within.js'

// Non-writing root qualification (PLAN §6). Runs before any hashing. Never writes a probe.
// Read-only commands need the portable checks; native writes additionally need the platform
// helper's volume, component and identity facts. Heuristics cannot detect every sync agent:
// the user must also state the root is unmanaged (--unmanaged), and that limit is disclosed.

export interface Qualification {
  rootPath: string
  rootId: string | null
  readOk: boolean
  writeOk: boolean
  identityQualified: boolean
  reasons: string[]
  notes: string[]
}

export function qualifiedRootId(fileId: string): string {
  return `r-${createHash('sha256').update(`win32:${fileId}`).digest('hex')}`
}

const SYNC_SEGMENT = /^(onedrive( - .*)?|dropbox|google drive|googledrive|my drive|icloud ?drive|box|box sync|pcloud ?drive|mega)$/i

function syncRootsFromEnv(env: NodeJS.ProcessEnv): string[] {
  return ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']
    .map((name) => env[name])
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .map((v) => path.resolve(v).toLowerCase())
}

export async function qualifyRoot(input: string, helper: PlatformHelper, options: { unmanaged: boolean; env?: NodeJS.ProcessEnv }): Promise<Qualification> {
  const env = options.env ?? process.env
  const reasons: string[] = []
  const notes: string[] = []
  const rootPath = path.resolve(input)
  const result = (rootId: string | null, readOk: boolean, writeOk: boolean, identityQualified: boolean): Qualification => ({
    rootPath,
    rootId,
    readOk,
    writeOk,
    identityQualified,
    reasons,
    notes,
  })

  if (rootPath.startsWith('\\\\') || input.startsWith('\\\\') || input.startsWith('//')) {
    reasons.push('UNC/network roots are not supported.')
    return result(null, false, false, false)
  }
  if (path.parse(rootPath).root === rootPath) reasons.push('A drive or volume root cannot be the selected folder.')

  let info
  try {
    info = await fsp.lstat(rootPath, { bigint: true })
  } catch {
    reasons.push('The folder does not exist or cannot be read.')
    return result(null, false, false, false)
  }
  if (info.isSymbolicLink()) reasons.push('The folder itself is a link or junction.')
  if (!info.isDirectory()) reasons.push('The selected path is not a folder.')

  // Link/junction ancestry: every existing component must be a plain directory, and the real
  // path must equal the requested path (case-insensitively on Windows).
  const parsed = path.parse(rootPath)
  let acc = parsed.root
  for (const part of rootPath.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    acc = path.join(acc, part)
    try {
      const c = await fsp.lstat(acc)
      if (c.isSymbolicLink()) reasons.push(`Ancestor ${acc} is a link or junction.`)
    } catch {
      reasons.push(`Ancestor ${acc} cannot be inspected.`)
    }
    if (SYNC_SEGMENT.test(part)) reasons.push(`Ancestor folder "${part}" looks like a cloud-sync root.`)
  }
  try {
    const real = await fsp.realpath(rootPath)
    const same = process.platform === 'win32' ? real.toLowerCase() === rootPath.toLowerCase() : real === rootPath
    if (!same) reasons.push(`The real path differs (${real}); a link or alias is in the ancestry.`)
  } catch {
    reasons.push('The real path cannot be resolved.')
  }
  for (const syncRoot of syncRootsFromEnv(env)) {
    if (isWithin(rootPath.toLowerCase(), syncRoot)) reasons.push(`The folder is inside a OneDrive root (${syncRoot}).`)
  }

  const readOk = reasons.length === 0
  // Root identity from the volume serial and file index Node reports. Path is only a hint.
  let rootId = readOk ? `r-${createHash('sha256').update(`${info.dev}:${info.ino}`).digest('hex').slice(0, 16)}` : null
  notes.push('Cloud-sync detection is heuristic; the folder must also be explicitly unmanaged (--unmanaged).')

  let writeOk = readOk
  let identityQualified = false
  if (process.platform !== 'win32') {
    writeOk = false
    notes.push('Native writes are qualified for Windows NTFS only.')
  }
  if (!options.unmanaged) {
    writeOk = false
    notes.push('Pass --unmanaged to state that no sync, backup or indexing agent manages this folder.')
  }
  if (!helper.available) {
    writeOk = false
    notes.push(helper.unavailableReason ?? 'Platform helper unavailable.')
  } else if (readOk) {
    try {
      const volume = await helper.volume(rootPath)
      if (volume.fileSystem.toUpperCase() !== 'NTFS') reasons.push(`Volume file system ${volume.fileSystem} is not supported.`)
      if (volume.remote) reasons.push('Mapped network volumes are not supported.')
      if (volume.removable) reasons.push('Removable volumes are not supported.')
      const components = await helper.components(rootPath)
      for (const c of components) {
        if (c.reparse) reasons.push(`Component ${c.path} is a reparse point.`)
        if (c.cloudPlaceholder) reasons.push(`Component ${c.path} is a cloud placeholder.`)
      }
      const rootFileId = await helper.fileId(rootPath)
      if (!/^[0-9a-f]{16}:[0-9a-f]{32}$/i.test(rootFileId)) throw new Error('Qualified root identity is unavailable.')
      rootId = qualifiedRootId(rootFileId)
      identityQualified = reasons.length === 0
      writeOk = writeOk && identityQualified
    } catch (error) {
      writeOk = false
      reasons.push(`Platform qualification failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return result(rootId, readOk && reasons.length === 0, writeOk && reasons.length === 0, identityQualified)
}
