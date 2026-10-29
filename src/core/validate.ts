import { ancestorsOf, type FsPort } from './fs-port.js'
import { checkProposedBasename, checkRelativePath, compareKey, splitExtension } from './paths.js'
import { categoryById, hasKnownSuffix, type ParsedProposals } from './proposal-schema.js'
import { destinationProtection, type RootConfig } from './scan-policy.js'
import type { FileRecord, Issue, PlanKind, ProposalSource, ScanManifest } from './types.js'

// Whole-plan validation (PLAN §6). The same policy runs in both profiles. Validation never
// rewrites a destination: it reports blocks and warnings, and the person edits explicitly.

export const LOW_CONFIDENCE = 0.5

export interface PlanRow {
  rowId: string
  fileId: string
  source: string
  size: number
  mtimeMs: number
  sha256: string | null
  identity: string | null
  /** Organize rows: chosen category and basename. Quarantine/restore rows leave these null. */
  categoryId: string | null
  basename: string | null
  destination: string | null
  provenance: ProposalSource | 'duplicate-review' | 'restore-review' | 'imported'
  batchId: string | null
  confidence: number | null
  reason: string
  included: boolean
  /** Issues from the proposal itself (rejection, absence); kept across revalidation. */
  proposalIssues: Issue[]
  /** proposalIssues plus issues computed by the last validation. */
  issues: Issue[]
  noop: boolean
}

export interface Observed {
  path: string
  kind: 'file' | 'dir' | 'link' | 'other'
  identity: string | null
}

/** Existing entries keyed by compareKey. */
export type ExistingIndex = Map<string, Observed>

const block = (code: string, message: string): Issue => ({ code, severity: 'block', message })
const warn = (code: string, message: string): Issue => ({ code, severity: 'warn', message })

export function isBlocked(row: PlanRow): boolean {
  return row.issues.some((issue) => issue.severity === 'block')
}

export function hasWarning(row: PlanRow): boolean {
  return row.issues.some((issue) => issue.severity === 'warn')
}

export function organizeDestination(config: RootConfig, categoryId: string, basename: string, ext: string): string | null {
  const category = categoryById(categoryId)
  if (!category) return null
  return `${config.outputRoot}/${category.folder}/${basename}${ext}`
}

/** One editable row per eligible file. Files without a valid proposal are blocked until edited. */
export function buildOrganizeRows(
  scan: ScanManifest,
  parsed: ParsedProposals,
  source: ProposalSource,
  batchId: string | null,
  config: RootConfig,
): PlanRow[] {
  const byFile = new Map(parsed.accepted.map((item) => [item.fileId, item]))
  const rejectedByFile = new Map<string, string>()
  for (const r of parsed.rejected) if (r.fileId && !rejectedByFile.has(r.fileId)) rejectedByFile.set(r.fileId, r.reason)

  return scan.files.map((file) => {
    const item = byFile.get(file.id)
    const proposalIssues: Issue[] = []
    if (!item) {
      const rejectedReason = rejectedByFile.get(file.id)
      proposalIssues.push(
        rejectedReason
          ? block('proposal-rejected', `Proposal rejected: ${rejectedReason} Edit the row to supply a manual correction.`)
          : block('no-proposal', 'No valid proposal for this file. Edit the row to supply one.'),
      )
    }
    const basename = item?.basename ?? splitExtension(baseName(file.relPath)).stem
    const categoryId = item?.categoryId ?? null
    return {
      rowId: file.id,
      fileId: file.id,
      source: file.relPath,
      size: file.size,
      mtimeMs: file.mtimeMs,
      sha256: file.sha256,
      identity: file.identity,
      categoryId,
      basename,
      destination: categoryId ? organizeDestination(config, categoryId, basename, file.ext) : null,
      provenance: source,
      batchId,
      confidence: item?.confidence ?? null,
      reason: item?.reason ?? '',
      included: false,
      proposalIssues,
      issues: proposalIssues,
      noop: false,
    }
  })
}

/** Explicit manual correction of one organize row. Clears proposal issues; provenance changes. */
export function editOrganizeRow(row: PlanRow, file: FileRecord, categoryId: string, basename: string, config: RootConfig): PlanRow {
  return {
    ...row,
    categoryId,
    basename,
    destination: organizeDestination(config, categoryId, basename, file.ext),
    provenance: 'manual-edit',
    confidence: null,
    reason: 'Edited by the reviewer.',
    included: false,
    proposalIssues: [],
  }
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** Stat every destination and its ancestors so validation can see what already exists. */
export async function observeDestinations(fs: FsPort, rows: PlanRow[]): Promise<ExistingIndex> {
  const index: ExistingIndex = new Map()
  const seen = new Set<string>()
  for (const row of rows) {
    if (!row.destination || !checkRelativePath(row.destination).ok) continue
    for (const path of [...ancestorsOf(row.destination), row.destination]) {
      const key = compareKey(path)
      if (seen.has(key)) continue
      seen.add(key)
      const info = await fs.stat(path)
      if (info) index.set(key, { path, kind: info.kind, identity: info.identity })
    }
  }
  return index
}

export interface ValidateContext {
  kind: PlanKind
  config: RootConfig
  existing: ExistingIndex
  /** Original extension per fileId, for organize rows. */
  extOf: (fileId: string) => string
}

/**
 * Recompute issues for every row. Set-level checks (duplicate destinations, dependent moves,
 * prefix conflicts) run over every candidate row, selected or not, so the result does not
 * flip as the selection changes: two colliding rows stay blocked until one is edited.
 * Blocked rows are forced out of the selection.
 */
export function validateRows(rows: PlanRow[], ctx: ValidateContext): PlanRow[] {
  const perRow = rows.map((row) => ({ row, issues: [...row.proposalIssues] as Issue[], noop: false }))

  for (const entry of perRow) {
    const { row, issues } = entry
    if (ctx.kind === 'organize') {
      if (row.categoryId !== null && !categoryById(row.categoryId)) issues.push(block('unknown-category', 'Category is not on the trusted list.'))
      if (row.basename !== null) {
        const nameCheck = checkProposedBasename(row.basename)
        if (!nameCheck.ok) issues.push(block(nameCheck.code, `Name rejected: ${nameCheck.reason}.`))
        else if (hasKnownSuffix(row.basename)) {
          issues.push(block('suffix-in-basename', `The name carries a file-type suffix; the real extension "${ctx.extOf(row.fileId)}" is reattached by code. Edit the name.`))
        }
      }
      if (row.confidence !== null && row.confidence < LOW_CONFIDENCE) {
        issues.push(warn('low-confidence', `Low confidence (${row.confidence.toFixed(2)}). Include only if you agree.`))
      }
    }
    const dest = row.destination
    if (dest === null) {
      if (!issues.some((i) => i.severity === 'block')) issues.push(block('no-destination', 'No destination.'))
      continue
    }
    const pathCheck = checkRelativePath(dest)
    if (!pathCheck.ok) {
      issues.push(block(pathCheck.code, `Destination rejected: ${pathCheck.reason}.`))
      continue
    }
    const protection = destinationProtection(dest, ctx.kind, ctx.config)
    if (protection) issues.push(block('protected-destination', `Destination is protected (${protection}).`))
    if (dest === row.source) {
      entry.noop = true
      continue
    }
    if (compareKey(dest) === compareKey(row.source)) {
      issues.push(block('case-only', 'Case-only or Unicode-only renames are not supported.'))
    }
    if (ctx.kind === 'organize' && splitExtension(baseName(dest)).ext !== ctx.extOf(row.fileId)) {
      issues.push(block('extension-changed', 'The destination must keep the exact original extension.'))
    }
    for (const ancestor of ancestorsOf(dest)) {
      const seen = ctx.existing.get(compareKey(ancestor))
      if (seen && seen.kind !== 'dir') issues.push(block('parent-is-file', `A parent of the destination is not a folder: ${seen.path}.`))
    }
    const occupant = ctx.existing.get(compareKey(dest))
    if (occupant) {
      const movingAway = perRow.some((other) => other.row !== row && compareKey(other.row.source) === compareKey(occupant.path))
      issues.push(
        movingAway
          ? block('dependent-move', `Destination is vacated only by another proposed move (${occupant.path}). Dependent moves and swaps are not supported.`)
          : block('occupied', `Destination already exists (${occupant.path}). Nothing is ever overwritten.`),
      )
    }
  }

  // Whole-set checks over every candidate row with a well-formed destination.
  const active = perRow.filter((e) => !e.noop && e.row.destination !== null && checkRelativePath(e.row.destination).ok)
  const sourceKeys = new Map<string, number>()
  const destKeys = new Map<string, number>()
  for (const { row } of active) {
    sourceKeys.set(compareKey(row.source), (sourceKeys.get(compareKey(row.source)) ?? 0) + 1)
    destKeys.set(compareKey(row.destination!), (destKeys.get(compareKey(row.destination!)) ?? 0) + 1)
  }
  for (const entry of active) {
    const dest = entry.row.destination!
    const destKey = compareKey(dest)
    if ((sourceKeys.get(compareKey(entry.row.source)) ?? 0) > 1) entry.issues.push(block('repeated-source', 'The same source appears in more than one row.'))
    if ((destKeys.get(destKey) ?? 0) > 1) entry.issues.push(block('duplicate-destination', 'Another row has the same destination (ignoring case and Unicode form). Edit one of them.'))
    if (sourceKeys.has(destKey) && compareKey(entry.row.source) !== destKey) {
      if (!entry.issues.some((i) => i.code === 'dependent-move')) {
        entry.issues.push(block('dependent-move', "Destination is another row's source. Swaps and dependent moves are not supported."))
      }
    }
    for (const other of active) {
      if (other === entry) continue
      const otherDest = compareKey(other.row.destination!)
      if (otherDest.startsWith(`${destKey}/`) || destKey.startsWith(`${otherDest}/`)) {
        entry.issues.push(block('prefix-conflict', 'One destination would be a folder of another.'))
        break
      }
    }
    for (const ancestor of ancestorsOf(dest)) {
      if (sourceKeys.has(compareKey(ancestor))) entry.issues.push(block('parent-is-file', 'A parent of the destination is a file in this plan.'))
    }
  }

  return perRow.map(({ row, issues, noop }) => {
    const blocked = issues.some((i) => i.severity === 'block')
    return { ...row, issues: dedupe(issues), noop, included: row.included && !blocked && !noop }
  })
}

function dedupe(issues: Issue[]): Issue[] {
  const seen = new Set<string>()
  return issues.filter((issue) => {
    const key = `${issue.code}|${issue.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Default selection: rows with no issues at all. Warnings start unselected; blocks cannot be selected. */
export function defaultSelection(rows: PlanRow[]): PlanRow[] {
  return rows.map((row) => ({ ...row, included: !row.noop && row.issues.length === 0 }))
}
