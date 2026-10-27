import { joinPath, type FsPort } from './fs-port.js'
import { checkRelativePath, splitExtension } from './paths.js'
import { DEFAULT_BOUNDS, DEFAULT_ROOT_CONFIG, POLICY_ID, isProjectMarker, protectionReason, type RootConfig } from './scan-policy.js'
import type { FileRecord, Provenance, ScanBounds, ScanManifest, ScanMode, SkipRecord } from './types.js'

export interface ScanOptions {
  scanId: string
  mode?: ScanMode
  bounds?: ScanBounds
  config?: RootConfig
  /** Bounded hashing concurrency. Native adapters stream; the sandbox hashes in memory. */
  hashConcurrency?: number
}

class BoundExceeded extends Error {}

/**
 * Bounded scan of one explicit root (PLAN §5). Project markers are discovered before any file
 * in a directory is chosen; a project root is refused and descendant project subtrees are left
 * whole. Any bound overflow aborts with no approvable partial result.
 */
export async function scanRoot(fs: FsPort, options: ScanOptions): Promise<ScanManifest> {
  const mode = options.mode ?? 'organize'
  const bounds = options.bounds ?? DEFAULT_BOUNDS
  const config = options.config ?? DEFAULT_ROOT_CONFIG
  const provenance: Provenance = fs.profile === 'native' ? 'computed-native' : 'computed-synthetic'

  const candidates: { relPath: string; size: number; mtimeMs: number; identity: string | null }[] = []
  const skipped: SkipRecord[] = []
  const projectRoots: string[] = []
  let encountered = 0
  let eligibleBytes = 0
  let abortReason: string | null = null

  const manifest = (status: 'complete' | 'aborted', files: FileRecord[]): ScanManifest => ({
    schema: 'scan-manifest',
    version: 1,
    scanId: options.scanId,
    profile: fs.profile,
    mode,
    policyId: POLICY_ID,
    root: { id: fs.rootId, displayHint: fs.rootDisplay },
    bounds,
    status,
    abortReason,
    files: status === 'complete' ? files : [],
    skipped,
    projectRoots,
    totals: {
      eligibleFiles: status === 'complete' ? files.length : 0,
      eligibleBytes: status === 'complete' ? eligibleBytes : 0,
      encounteredEntries: encountered,
      skipped: skipped.filter((s) => s.reason !== 'unhashable' && s.reason !== 'link-or-reparse' && s.reason !== 'multiply-linked').length,
      blocked: skipped.filter((s) => s.reason === 'unhashable' || s.reason === 'link-or-reparse' || s.reason === 'multiply-linked').length,
      zeroByte: status === 'complete' ? files.filter((f) => f.size === 0).length : 0,
      projectTrees: projectRoots.length,
    },
  })

  const rootListing = await fs.list('')
  if (rootListing.some((entry) => isProjectMarker(entry.name))) {
    abortReason = 'The selected root is itself a project (it contains a project marker). Organize is refused.'
    projectRoots.push('')
    return manifest('aborted', [])
  }

  const allow = mode === 'duplicates' ? 'output' : 'none'
  const queue: { dir: string; depth: number; listing: typeof rootListing }[] = [{ dir: '', depth: 0, listing: rootListing }]
  try {
    while (queue.length > 0) {
      const { dir, depth, listing } = queue.shift()!
      const sorted = [...listing].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      for (const entry of sorted) {
        encountered++
        if (encountered > bounds.maxEntries) throw new BoundExceeded(`More than ${bounds.maxEntries} entries encountered.`)
        const relPath = joinPath(dir, entry.name)
        const nameCheck = checkRelativePath(relPath)
        if (entry.kind === 'link' || entry.kind === 'other') {
          skipped.push({
            relPath,
            kind: 'other',
            reason: entry.kind === 'link' ? 'link-or-reparse' : 'not-regular',
            detail: entry.kind === 'link' ? 'Links and reparse points are never followed or moved.' : 'Not a regular file or directory.',
          })
          continue
        }
        if (entry.hidden || entry.system) {
          skipped.push({ relPath, kind: entry.kind, reason: 'hidden', detail: 'Hidden or system attributes are protected; bytes and subtrees were not read.' })
          continue
        }
        const reason = protectionReason(relPath, config, allow)
        if (entry.kind === 'dir') {
          if (reason) {
            skipped.push({ relPath, kind: 'dir', reason, detail: describe(reason) })
            continue
          }
          if (depth + 1 > bounds.maxDepth) throw new BoundExceeded(`Folder depth exceeds ${bounds.maxDepth} at ${relPath}.`)
          const childListing = await fs.list(relPath)
          if (childListing.some((child) => isProjectMarker(child.name))) {
            projectRoots.push(relPath)
            skipped.push({ relPath, kind: 'dir', reason: 'project-tree', detail: 'Project subtree left untouched as a whole.' })
            continue
          }
          queue.push({ dir: relPath, depth: depth + 1, listing: childListing })
          continue
        }
        if (reason) {
          skipped.push({ relPath, kind: 'file', reason, detail: describe(reason) })
          continue
        }
        if (!nameCheck.ok) {
          skipped.push({ relPath, kind: 'file', reason: 'invalid-name', detail: `Name not supported: ${nameCheck.reason}.` })
          continue
        }
        const info = await fs.stat(relPath)
        if (!info || info.kind !== 'file') {
          skipped.push({ relPath, kind: 'file', reason: 'not-regular', detail: 'Changed or vanished during scan.' })
          continue
        }
        if (info.linkCount > 1) {
          skipped.push({ relPath, kind: 'file', reason: 'multiply-linked', detail: 'Pre-existing hard links are skipped.' })
          continue
        }
        candidates.push({ relPath, size: info.size, mtimeMs: info.mtimeMs, identity: info.identity })
        eligibleBytes += info.size
        if (candidates.length > bounds.maxFiles) throw new BoundExceeded(`More than ${bounds.maxFiles} eligible files.`)
        if (eligibleBytes > bounds.maxBytes) throw new BoundExceeded(`Eligible bytes exceed ${bounds.maxBytes}.`)
      }
    }
  } catch (error) {
    if (error instanceof BoundExceeded) {
      abortReason = error.message
      return manifest('aborted', [])
    }
    throw error
  }

  const hashes = await hashAll(fs, candidates.map((c) => c.relPath), options.hashConcurrency ?? 4)
  const files: FileRecord[] = []
  candidates.forEach((candidate, index) => {
    const sha = hashes[index]
    if (sha === undefined || sha === null) {
      skipped.push({ relPath: candidate.relPath, kind: 'file', reason: 'unhashable', detail: 'Could not read the bytes to hash.' })
      eligibleBytes -= candidate.size
      return
    }
    const base = candidate.relPath.slice(candidate.relPath.lastIndexOf('/') + 1)
    files.push({
      id: `f${String(files.length + 1).padStart(3, '0')}`,
      relPath: candidate.relPath,
      ext: splitExtension(base).ext,
      size: candidate.size,
      mtimeMs: candidate.mtimeMs,
      sha256: sha,
      identity: candidate.identity,
      provenance,
    })
  })
  return manifest('complete', files)
}

async function hashAll(fs: FsPort, paths: string[], concurrency: number): Promise<(string | null)[]> {
  const out: (string | null)[] = new Array(paths.length).fill(null)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < paths.length) {
      const index = next++
      try {
        out[index] = await fs.sha256(paths[index]!)
      } catch {
        out[index] = null
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, paths.length)) }, worker))
  return out
}

export function describe(reason: string): string {
  switch (reason) {
    case 'protected':
      return 'Protected name (notice, package/lock, credential or tool folder).'
    case 'hidden':
      return 'Hidden or dot-prefixed path.'
    case 'output-root':
      return 'Output folder is excluded from ordinary scans.'
    case 'quarantine-root':
      return 'Quarantine folder is excluded from scans.'
    case 'app-state':
      return 'Operating-system or app state file.'
    default:
      return reason
  }
}
