import { describe, expect, it } from 'vitest'
import { MemoryFs } from '../../src/adapters/memory-fs'
import { createSandbox, simulatedResponse } from '../../src/adapters/sandbox-seed'
import { utf8Encode } from '../../src/core/fingerprint'
import { heuristicProposals } from '../../src/core/heuristic'
import { approvalIsCurrent, approve, buildPlan, canonicalJson, parseMovePlan, reconstructOrganizeRows } from '../../src/core/plan'
import { parseProposalResponse, parseProposalText } from '../../src/core/proposal-schema'
import { scanRoot } from '../../src/core/scan'
import { DEFAULT_ROOT_CONFIG } from '../../src/core/scan-policy'
import type { ScanManifest } from '../../src/core/types'
import { buildOrganizeRows, defaultSelection, editOrganizeRow, isBlocked, observeDestinations, validateRows, type PlanRow } from '../../src/core/validate'

const config = DEFAULT_ROOT_CONFIG

async function setup(fs: MemoryFs = createSandbox()) {
  const scan = await scanRoot(fs, { scanId: 'scan-t' })
  const extOf = (id: string) => scan.files.find((f) => f.id === id)?.ext ?? ''
  const validate = async (rows: PlanRow[]) =>
    validateRows(rows, { kind: 'organize', config, existing: await observeDestinations(fs, rows), extOf })
  return { fs, scan, validate }
}

function rowFor(rows: PlanRow[], path: string): PlanRow {
  const row = rows.find((r) => r.source === path)
  if (!row) throw new Error(`no row ${path}`)
  return row
}

describe('proposal schema (T11, T30, T33, T10)', () => {
  it('rejects extra fields, unknown categories and encoded traversal', async () => {
    const { scan } = await setup()
    const parsed = parseProposalResponse(simulatedResponse(scan), new Set(scan.files.map((f) => f.id)))
    const codes = parsed.rejected.map((r) => r.code).sort()
    expect(codes).toContain('fields')
    expect(codes).toContain('unknown-category')
    expect(codes).toContain('encoded-path')
    expect(parsed.accepted.some((a) => a.categoryId === 'other' && a.basename.includes('%2e'))).toBe(false)
  })
  it('rejects malformed, extra top-level, unknown and duplicate ids', () => {
    const ids = new Set(['f001', 'f002'])
    expect(parseProposalText('not json', ids).fatal).not.toBeNull()
    expect(parseProposalResponse({ proposals: [], note: 'x' }, ids).fatal).not.toBeNull()
    const item = { fileId: 'f001', categoryId: 'documents', basename: 'a', confidence: 0.9, reason: '' }
    const dup = parseProposalResponse({ proposals: [item, item, { ...item, fileId: 'zzz' }] }, ids)
    expect(dup.accepted).toEqual([])
    expect(dup.rejected.map((r) => r.code).sort()).toEqual(['duplicate-id', 'duplicate-id', 'unknown-file'])
    expect(parseProposalResponse({ proposals: [{ ...item, confidence: 2 }] }, ids).accepted).toEqual([])
    // A valid item must not win over a malformed second proposal for the same file.
    const mixed = parseProposalResponse({ proposals: [item, { ...item, categoryId: 'other', path: '../..' }] }, ids)
    expect(mixed.accepted).toEqual([])
    expect(mixed.rejected.map((r) => r.code).sort()).toEqual(['duplicate-id', 'fields'])
  })
  it('never fabricates proposals for a failed response (T30)', async () => {
    const { scan } = await setup()
    const rows = buildOrganizeRows(scan, parseProposalText('', new Set()), 'local-ai', null, config)
    expect(rows.every((r) => r.proposalIssues.some((i) => i.severity === 'block'))).toBe(true)
  })
})

describe('validation (T01-T04, T08, T32, T35)', () => {
  it('blocks case and Unicode destination collisions until edited (T01, T02)', async () => {
    const { scan, validate } = await setup()
    const rows = await validate(buildOrganizeRows(scan, { accepted: heuristicProposals(scan), rejected: [], fatal: null }, 'heuristic', 'b1', config))
    expect(isBlocked(rowFor(rows, 'Downloads/Report Final.pdf'))).toBe(true)
    expect(isBlocked(rowFor(rows, 'Downloads/old/report final.pdf'))).toBe(true)
    expect(isBlocked(rowFor(rows, 'Downloads/café.txt'))).toBe(true)
    expect(isBlocked(rowFor(rows, 'Downloads/old/café.txt'))).toBe(true)
    const file = scan.files.find((f) => f.relPath === 'Downloads/old/report final.pdf')!
    const edited = await validate(rows.map((r) => (r.fileId === file.id ? editOrganizeRow(r, file, 'documents', 'report final (old)', config) : r)))
    expect(isBlocked(rowFor(edited, 'Downloads/Report Final.pdf'))).toBe(false)
  })

  it('blocks occupied destinations and parent-is-file (T03, T08)', async () => {
    const fs = createSandbox()
    fs.writeFile('_Organized/Documents/notes.txt', utf8Encode('someone else'))
    fs.writeFile('_Organized/Images', utf8Encode('a file where a folder should be'))
    const { scan, validate } = await setup(fs)
    const rows = await validate(buildOrganizeRows(scan, { accepted: heuristicProposals(scan), rejected: [], fatal: null }, 'heuristic', 'b1', config))
    expect(rowFor(rows, 'notes.txt').issues.map((i) => i.code)).toContain('occupied')
    expect(rowFor(rows, 'IMG_0412.jpg').issues.map((i) => i.code)).toContain('parent-is-file')
  })

  it('blocks swaps, dependent and case-only moves (T04)', async () => {
    const fs = new MemoryFs()
    fs.writeFile('a.txt', utf8Encode('a'))
    fs.writeFile('b.txt', utf8Encode('b'))
    const { scan, validate } = await setup(fs)
    const a = scan.files.find((f) => f.relPath === 'a.txt')!
    const b = scan.files.find((f) => f.relPath === 'b.txt')!
    const base = buildOrganizeRows(scan, { accepted: [], rejected: [], fatal: null }, 'manual-edit', null, config)
    const swapped = base.map((r) => ({ ...r, proposalIssues: [], destination: r.fileId === a.id ? 'b.txt' : 'a.txt', included: true }))
    const result = await validate(swapped)
    expect(result.every((r) => r.issues.some((i) => i.code === 'dependent-move'))).toBe(true)
    const caseOnly = await validate([{ ...base.find((r) => r.fileId === b.id)!, proposalIssues: [], destination: 'B.txt', included: true }])
    expect(caseOnly[0]!.issues.map((i) => i.code)).toContain('case-only')
  })

  it('blocks a misleading known suffix (T32) and protected destinations', async () => {
    const { scan, validate } = await setup()
    const parsed = parseProposalResponse(simulatedResponse(scan), new Set(scan.files.map((f) => f.id)))
    const rows = await validate(buildOrganizeRows(scan, parsed, 'simulated', 'sim', config))
    expect(rowFor(rows, 'setup-tool.exe').issues.map((i) => i.code)).toContain('suffix-in-basename')
    const file = scan.files.find((f) => f.relPath === 'notes.txt')!
    const edited = await validate(rows.map((r) => (r.fileId === file.id ? editOrganizeRow(r, file, 'documents', 'README', config) : r)))
    expect(rowFor(edited, 'notes.txt').issues.map((i) => i.code)).toContain('protected-destination')
  })

  it('starts warnings unselected and never selects blocked rows', async () => {
    const { scan, validate } = await setup()
    const rows = await validate(defaultSelection(await validate(buildOrganizeRows(scan, { accepted: heuristicProposals(scan), rejected: [], fatal: null }, 'heuristic', 'b', config))))
    expect(rowFor(rows, 'mystery.xyz').included).toBe(false)
    expect(rows.filter(isBlocked).every((r) => !r.included)).toBe(true)
    expect(rowFor(rows, 'Q3 report.pdf').included).toBe(true)
  })
})

describe('digest and approval (T35, T23)', () => {
  async function approvedPlan() {
    const { scan, validate } = await setup()
    const rows = await validate(defaultSelection(await validate(buildOrganizeRows(scan, { accepted: heuristicProposals(scan), rejected: [], fatal: null }, 'heuristic', 'b', config))))
    const plan = buildPlan({ planId: 'plan-1', kind: 'organize', scan, config, rows })
    return { scan, rows, plan, approval: approve(plan, '2026-10-23T00:00:00Z'), validate }
  }

  it('canonical JSON sorts keys and rejects non-integers', () => {
    expect(canonicalJson({ b: 1, a: [2, 'x'] })).toBe('{"a":[2,"x"],"b":1}')
    expect(() => canonicalJson({ a: 0.5 })).toThrow()
  })

  it('selection, category and output edits invalidate approval', async () => {
    const { scan, rows, plan, approval, validate } = await approvedPlan()
    expect(approvalIsCurrent(plan, approval)).toBe(true)
    const deselected = rows.map((r, i) => (i === 0 ? { ...r, included: false } : r))
    expect(approvalIsCurrent(buildPlan({ planId: 'plan-1', kind: 'organize', scan, config, rows: deselected }), approval)).toBe(false)
    const otherOutput = buildPlan({ planId: 'plan-1', kind: 'organize', scan, config: { ...config, outputRoot: 'Sorted' }, rows })
    expect(approvalIsCurrent(otherOutput, approval)).toBe(false)
    const file = scan.files.find((f) => f.relPath === 'Q3 report.pdf')!
    const recat = await validate(rows.map((r) => (r.fileId === file.id ? { ...editOrganizeRow(r, file, 'other', 'Q3 report', config), included: true } : r)))
    expect(approvalIsCurrent(buildPlan({ planId: 'plan-1', kind: 'organize', scan, config, rows: recat }), approval)).toBe(false)
  })

  it('imports strictly and reconstructs rows needing fresh approval (T23)', async () => {
    const { scan, plan } = await approvedPlan()
    const parsed = parseMovePlan(JSON.stringify(plan))
    expect(parsed.ok).toBe(true)
    expect(parseMovePlan(JSON.stringify({ ...plan, extra: 1 })).ok).toBe(false)
    expect(parseMovePlan(JSON.stringify({ ...plan, rows: plan.rows.slice(1) })).ok).toBe(false)
    const { rows } = reconstructOrganizeRows(plan, scan, config)
    expect(rows.length).toBe(plan.rows.length)
    expect(rows.every((r) => r.provenance === 'imported' && !r.included)).toBe(true)
  })
})

export type { ScanManifest }
