import type { FsPort } from './fs-port.js'
import { compareKey } from './paths.js'
import type { MovePlan } from './plan.js'
import { isUnder, type RootConfig } from './scan-policy.js'
import type { FileRecord, Issue, ScanManifest } from './types.js'
import type { PlanRow } from './validate.js'

// Exact duplicates and the separately reviewed quarantine/restore plans (PLAN §8). Groups need
// equal nonzero size and a complete computed SHA-256; imported hash labels stay unverified.
// The keeper is only a highlighted suggestion; nothing is selected by default.

export interface DuplicateGroup {
  sha256: string
  size: number
  members: FileRecord[]
  keeperSuggestion: string
}

export interface DuplicateReport {
  groups: DuplicateGroup[]
  zeroByte: string[]
  unhashable: string[]
  unverified: string[]
}

export function findDuplicates(scan: ScanManifest, config: RootConfig): DuplicateReport {
  const zeroByte: string[] = []
  const unverified: string[] = []
  const buckets = new Map<string, FileRecord[]>()
  for (const file of scan.files) {
    if (file.size === 0) {
      zeroByte.push(file.relPath)
      continue
    }
    if (file.provenance === 'imported-unverified' || file.sha256 === null) {
      unverified.push(file.relPath)
      continue
    }
    const key = `${file.size}:${file.sha256}`
    const list = buckets.get(key) ?? []
    list.push(file)
    buckets.set(key, list)
  }
  const groups: DuplicateGroup[] = []
  for (const members of buckets.values()) {
    if (members.length < 2) continue
    const sorted = [...members].sort((a, b) => {
      const ao = isUnder(a.relPath, config.outputRoot) ? 0 : 1
      const bo = isUnder(b.relPath, config.outputRoot) ? 0 : 1
      if (ao !== bo) return ao - bo
      return a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0
    })
    groups.push({ sha256: sorted[0]!.sha256!, size: sorted[0]!.size, members: sorted, keeperSuggestion: sorted[0]!.id })
  }
  groups.sort((a, b) => (a.members[0]!.relPath < b.members[0]!.relPath ? -1 : 1))
  const unhashable = scan.skipped.filter((s) => s.reason === 'unhashable').map((s) => s.relPath)
  return { groups, zeroByte, unhashable, unverified }
}

/**
 * Rows for a quarantine plan of the selected extras. Each lands at
 * <quarantineRoot>/<runId>/<original relative path>. Selecting every member of a group is
 * blocked: at least one copy must stay in place.
 */
export function quarantineRows(report: DuplicateReport, selectedIds: ReadonlySet<string>, runId: string, config: RootConfig): PlanRow[] {
  const rows: PlanRow[] = []
  for (const group of report.groups) {
    const allSelected = group.members.every((m) => selectedIds.has(m.id))
    for (const file of group.members) {
      if (!selectedIds.has(file.id)) continue
      const proposalIssues: Issue[] = allSelected
        ? [{ code: 'no-keeper', severity: 'block', message: 'Every copy in this group is selected. Leave at least one in place.' }]
        : []
      rows.push({
        rowId: file.id,
        fileId: file.id,
        source: file.relPath,
        size: file.size,
        mtimeMs: file.mtimeMs,
        sha256: file.sha256,
        identity: file.identity,
        categoryId: null,
        basename: null,
        destination: `${config.quarantineRoot}/${runId}/${file.relPath}`,
        provenance: 'duplicate-review',
        batchId: null,
        confidence: null,
        reason: `Exact duplicate of ${group.members.find((m) => m.id === group.keeperSuggestion)?.relPath ?? 'another file'} (SHA-256 ${group.sha256.slice(0, 12)}…).`,
        included: true,
        proposalIssues,
        issues: proposalIssues,
        noop: false,
      })
    }
  }
  return rows
}

export interface RestoreCandidate {
  /** Path inside quarantine now. */
  quarantined: string
  /** Original path to restore to. */
  original: string
  size: number
  mtimeMs: number
  sha256: string
  identity: string | null
}

/** Entries a committed quarantine run moved, with the expected fingerprints from its plan. */
export function restoreCandidates(plan: MovePlan, moved: { from: string; to: string }[]): RestoreCandidate[] {
  const byFrom = new Map(plan.rows.map((r) => [r.from, r]))
  return moved.flatMap((m) => {
    const row = byFrom.get(m.from)
    return row ? [{ quarantined: m.to, original: m.from, size: row.size, mtimeMs: row.mtimeMs, sha256: row.sha256, identity: row.identity }] : []
  })
}

/**
 * Restore rows for the chosen entries. Current bytes are rehashed now; a changed file is
 * blocked. Destination occupancy is reported by normal validation (never overwritten).
 */
export async function restoreRows(fs: FsPort, candidates: RestoreCandidate[], chosen: ReadonlySet<string>): Promise<PlanRow[]> {
  const rows: PlanRow[] = []
  for (const c of candidates) {
    if (!chosen.has(c.quarantined)) continue
    const info = await fs.stat(c.quarantined)
    let current: string | null = null
    if (info && info.kind === 'file') {
      try {
        current = await fs.sha256(c.quarantined)
      } catch {
        current = null
      }
    }
    const proposalIssues: Issue[] = []
    if (!info) proposalIssues.push({ code: 'missing', severity: 'block', message: 'The quarantined file is no longer there.' })
    else if (current !== c.sha256 || info.size !== c.size || info.mtimeMs !== c.mtimeMs || (c.identity !== null && info.identity !== c.identity)) proposalIssues.push({ code: 'changed', severity: 'block', message: 'The quarantined file changed; it will not be restored.' })
    rows.push({
      rowId: compareKey(c.quarantined),
      fileId: `restore:${c.quarantined}`,
      source: c.quarantined,
      size: c.size,
      mtimeMs: c.mtimeMs,
      sha256: c.sha256,
      identity: c.identity,
      categoryId: null,
      basename: null,
      destination: c.original,
      provenance: 'restore-review',
      batchId: null,
      confidence: null,
      reason: 'Return to the original path.',
      included: true,
      proposalIssues,
      issues: proposalIssues,
      noop: false,
    })
  }
  return rows
}
