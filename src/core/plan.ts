import { sha256Text, SHA256_HEX } from './fingerprint.js'
import { EXTENSION_POLICY, splitExtension } from './paths.js'
import { CATEGORIES } from './proposal-schema.js'
import type { RootConfig } from './scan-policy.js'
import type { PlanKind, Profile, ScanManifest } from './types.js'
import type { PlanRow } from './validate.js'

// MovePlan v1 and its digest (PLAN §5). The digest binds the exact accepted rows, config and
// root. Any change produces a new digest, which clears approval. A digest binds bytes, not
// authorship or permission: imported plans are reconstructed locally and approved afresh.

export interface PlanOp {
  fileId: string
  from: string
  to: string
  size: number
  sha256: string
  identity: string | null
  provenance: string
  batchId: string | null
}

export interface PlanConfig {
  outputRoot: string
  quarantineRoot: string
  extensionPolicy: string
  categories: { id: string; folder: string }[]
}

export interface MovePlan {
  schema: 'move-plan'
  version: 1
  planId: string
  kind: PlanKind
  profile: Profile
  scanId: string
  rootId: string
  policyId: string
  config: PlanConfig
  /** Quarantine run being restored, for restore plans. */
  restoreOf: string | null
  rows: PlanOp[]
  digest: string
}

export interface Approval {
  planId: string
  digest: string
  approvedAt: string
}

export const PLAN_LIMITS = {
  maxBytes: 4 * 1024 * 1024,
  maxFileRows: 500,
  maxOperationRows: 2000,
}

/**
 * Deterministic UTF-8 serialization: object keys sorted by code unit, arrays in their given
 * (explicitly stable) order, integers only, no undefined. Throws on anything else.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isSafeInteger(value)) throw new Error(`Non-integer number in canonical JSON: ${value}`)
      return String(value)
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
      const record = value as Record<string, unknown>
      const keys = Object.keys(record).sort()
      const parts: string[] = []
      for (const key of keys) {
        if (record[key] === undefined) throw new Error(`Undefined field in canonical JSON: ${key}`)
        parts.push(`${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      }
      return `{${parts.join(',')}}`
    }
    default:
      throw new Error(`Unsupported value in canonical JSON: ${typeof value}`)
  }
}

export function computeDigest(plan: Omit<MovePlan, 'digest'> | MovePlan): string {
  const { digest: _ignored, ...body } = plan as MovePlan
  return sha256Text(canonicalJson(body))
}

export function planConfig(config: RootConfig): PlanConfig {
  return {
    outputRoot: config.outputRoot,
    quarantineRoot: config.quarantineRoot,
    extensionPolicy: EXTENSION_POLICY,
    categories: CATEGORIES.map((c) => ({ id: c.id, folder: c.folder })),
  }
}

export interface BuildPlanInput {
  planId: string
  kind: PlanKind
  scan: Pick<ScanManifest, 'scanId' | 'profile' | 'policyId' | 'root'>
  config: RootConfig
  rows: PlanRow[]
  restoreOf?: string | null
}

/** Build the executable plan from included, non-noop, unblocked rows in table order. */
export function buildPlan(input: BuildPlanInput): MovePlan {
  const ops: PlanOp[] = input.rows
    .filter((row) => row.included && !row.noop && row.destination !== null && !row.issues.some((i) => i.severity === 'block'))
    .map((row) => {
      if (!row.sha256) throw new Error(`Row ${row.rowId} has no computed hash; it cannot be planned.`)
      return {
        fileId: row.fileId,
        from: row.source,
        to: row.destination!,
        size: row.size,
        sha256: row.sha256,
        identity: row.identity,
        provenance: row.provenance,
        batchId: row.batchId,
      }
    })
  const body: Omit<MovePlan, 'digest'> = {
    schema: 'move-plan',
    version: 1,
    planId: input.planId,
    kind: input.kind,
    profile: input.scan.profile,
    scanId: input.scan.scanId,
    rootId: input.scan.root.id,
    policyId: input.scan.policyId,
    config: planConfig(input.config),
    restoreOf: input.restoreOf ?? null,
    rows: ops,
  }
  return { ...body, digest: computeDigest(body) }
}

export function approve(plan: MovePlan, now: string): Approval {
  return { planId: plan.planId, digest: computeDigest(plan), approvedAt: now }
}

/** Approval is current only if it names this plan and the recomputed digest still matches. */
export function approvalIsCurrent(plan: MovePlan | null, approval: Approval | null): boolean {
  if (!plan || !approval) return false
  const digest = computeDigest(plan)
  return approval.planId === plan.planId && approval.digest === digest && plan.digest === digest
}

// ---- strict import (T23) ----

type ParseResult = { ok: true; plan: MovePlan } | { ok: false; error: string }

const PLAN_KEYS = ['config', 'digest', 'kind', 'planId', 'policyId', 'profile', 'restoreOf', 'rootId', 'rows', 'scanId', 'schema', 'version']
const OP_KEYS = ['batchId', 'fileId', 'from', 'identity', 'provenance', 'sha256', 'size', 'to']
const CONFIG_KEYS = ['categories', 'extensionPolicy', 'outputRoot', 'quarantineRoot']

function keysExactly(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  return actual.length === keys.length && actual.every((k, i) => k === keys[i])
}

const isStr = (v: unknown, max = 512): v is string => typeof v === 'string' && v.length <= max
const isStrOrNull = (v: unknown): v is string | null => v === null || isStr(v)

/** Strict, bounded parse. The result is review material only; execution needs reconstruction. */
export function parseMovePlan(text: string): ParseResult {
  if (text.length > PLAN_LIMITS.maxBytes) return { ok: false, error: 'Plan file is larger than 4 MiB.' }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: 'Plan file is not valid JSON.' }
  }
  if (!keysExactly(raw, PLAN_KEYS)) return { ok: false, error: 'Plan has missing or unknown top-level fields.' }
  if (raw.schema !== 'move-plan' || raw.version !== 1) return { ok: false, error: 'Unsupported plan schema or version.' }
  if (!['organize', 'quarantine', 'restore'].includes(raw.kind as string)) return { ok: false, error: 'Unknown plan kind.' }
  if (!['sandbox', 'native'].includes(raw.profile as string)) return { ok: false, error: 'Unknown profile.' }
  for (const field of ['planId', 'scanId', 'rootId', 'policyId'] as const) {
    if (!isStr(raw[field], 200)) return { ok: false, error: `Field ${field} must be a short string.` }
  }
  if (!isStrOrNull(raw.restoreOf)) return { ok: false, error: 'restoreOf must be a string or null.' }
  if (!isStr(raw.digest) || !SHA256_HEX.test(raw.digest)) return { ok: false, error: 'Digest must be a SHA-256 hex string.' }
  const config = raw.config
  if (!keysExactly(config, CONFIG_KEYS)) return { ok: false, error: 'Plan config has missing or unknown fields.' }
  if (!isStr(config.outputRoot, 120) || !isStr(config.quarantineRoot, 120) || !isStr(config.extensionPolicy, 60)) {
    return { ok: false, error: 'Plan config fields must be short strings.' }
  }
  if (!Array.isArray(config.categories) || config.categories.length > 50) return { ok: false, error: 'Plan categories must be a short array.' }
  for (const c of config.categories) {
    if (!keysExactly(c, ['folder', 'id']) || !isStr(c.id, 60) || !isStr(c.folder, 120)) return { ok: false, error: 'Malformed category entry.' }
  }
  if (!Array.isArray(raw.rows)) return { ok: false, error: 'rows must be an array.' }
  if (raw.rows.length > PLAN_LIMITS.maxFileRows) return { ok: false, error: `More than ${PLAN_LIMITS.maxFileRows} file rows.` }
  const ids = new Set<string>()
  for (const op of raw.rows) {
    if (!keysExactly(op, OP_KEYS)) return { ok: false, error: 'A row has missing or unknown fields.' }
    if (!isStr(op.fileId, 200) || !isStr(op.from) || !isStr(op.to) || !isStr(op.provenance, 40)) return { ok: false, error: 'A row has malformed text fields.' }
    if (!isStr(op.sha256) || !SHA256_HEX.test(op.sha256)) return { ok: false, error: 'A row has a malformed hash.' }
    if (typeof op.size !== 'number' || !Number.isSafeInteger(op.size) || op.size < 0) return { ok: false, error: 'A row has a malformed size.' }
    if (!isStrOrNull(op.identity) || !isStrOrNull(op.batchId)) return { ok: false, error: 'A row has malformed identity or batch fields.' }
    if (ids.has(op.fileId)) return { ok: false, error: `Duplicate file id ${op.fileId}.` }
    ids.add(op.fileId)
  }
  const plan = raw as unknown as MovePlan
  if (computeDigest(plan) !== plan.digest) return { ok: false, error: 'Digest does not match the plan contents.' }
  return { ok: true, plan }
}

/**
 * Reconstruct editable organize rows from an imported plan against the current local scan.
 * Rows match by literal path and current computed hash; everything else is reported. The
 * result has provenance "imported", starts unselected and needs fresh validation and approval.
 */
export function reconstructOrganizeRows(
  plan: MovePlan,
  scan: ScanManifest,
  config: RootConfig,
): { rows: PlanRow[]; unmatched: { from: string; reason: string }[] } {
  const unmatched: { from: string; reason: string }[] = []
  const byPath = new Map(scan.files.map((f) => [f.relPath, f]))
  const used = new Set<string>()
  const rows: PlanRow[] = []
  if (plan.kind !== 'organize') return { rows, unmatched: [{ from: '*', reason: 'Only organize plans can be reconstructed for review here.' }] }
  for (const op of plan.rows) {
    const file = byPath.get(op.from)
    if (!file) {
      unmatched.push({ from: op.from, reason: 'Source is not in the current scan.' })
      continue
    }
    if (file.sha256 !== op.sha256) {
      unmatched.push({ from: op.from, reason: 'Source bytes differ from the plan.' })
      continue
    }
    if (used.has(file.id)) continue
    used.add(file.id)
    const prefix = `${config.outputRoot}/`
    const rest = op.to.startsWith(prefix) ? op.to.slice(prefix.length) : ''
    const slash = rest.indexOf('/')
    const folder = slash > 0 ? rest.slice(0, slash) : ''
    const leaf = slash > 0 ? rest.slice(slash + 1) : ''
    const category = CATEGORIES.find((c) => c.folder === folder)
    const { stem, ext } = splitExtension(leaf)
    const ok = category !== undefined && !leaf.includes('/') && ext === file.ext
    rows.push({
      rowId: file.id,
      fileId: file.id,
      source: file.relPath,
      size: file.size,
      sha256: file.sha256,
      identity: file.identity,
      categoryId: ok ? category.id : null,
      basename: ok ? stem : null,
      destination: ok ? op.to : null,
      provenance: 'imported',
      batchId: op.batchId,
      confidence: null,
      reason: `Imported from plan ${plan.planId}.`,
      included: false,
      proposalIssues: ok ? [] : [{ code: 'imported-destination', severity: 'block', message: 'Imported destination is outside the current output layout. Edit the row.' }],
      issues: [],
      noop: false,
    })
  }
  return { rows, unmatched }
}
