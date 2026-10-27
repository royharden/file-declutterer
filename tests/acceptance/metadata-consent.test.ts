import { expect, it } from 'vitest'
import { MemoryFs, MemoryJournalStore } from '../../src/adapters/memory-fs'
import { scanRoot } from '../../src/core/scan'
import { heuristicProposals } from '../../src/core/heuristic'
import { DEFAULT_ROOT_CONFIG as config } from '../../src/core/scan-policy'
import { buildOrganizeRows, observeDestinations, validateRows } from '../../src/core/validate'
import { approvalIsCurrent, approve, buildPlan, parseMovePlan, reconstructOrganizeRows } from '../../src/core/plan'
import { applyPlan, previewReverse } from '../../src/core/runs'

async function fixture() {
  const fs = new MemoryFs('rv-metadata')
  fs.writeFile('report.pdf', new Uint8Array([0, 255, 128, 0]), 1700000000000)
  const store = new MemoryJournalStore()
  const scan = await scanRoot(fs, { scanId: 'rv-metadata-scan' })
  const raw = buildOrganizeRows(scan, { accepted: heuristicProposals(scan), rejected: [], fatal: null }, 'heuristic', 'rv', config)
  const rows = validateRows(raw.map(row => ({ ...row, included: true })), { kind: 'organize', config, existing: await observeDestinations(fs, raw), extOf: () => '.pdf' })
  const plan = buildPlan({ planId: 'rv-metadata-plan', kind: 'organize', scan, config, rows })
  return { fs, store, scan, rows, plan }
}

it('refuses undo after a same-byte, same-identity external metadata change (PLAN section 8)', async () => {
  // what_bug_this_catches: undo ignores changed metadata because executable plans omit mtime.
  const { fs, store, plan } = await fixture()
  expect((await applyPlan({ fs, store }, plan, approve(plan, 'rv'))).status).toBe('committed')
  const destination = '_Organized/Documents/report.pdf'
  const before = (await fs.stat(destination))!
  fs.writeFile(destination, fs.readFile(destination)!.slice(), before.mtimeMs + 1000)
  const after = (await fs.stat(destination))!
  expect(after.identity).toBe(before.identity)
  expect(after.size).toBe(before.size)
  expect(after.mtimeMs).not.toBe(before.mtimeMs)
  const preview = await previewReverse({ fs, store }, plan.planId)
  expect(preview.find(entry => entry.to === destination)?.action).toBe('refuse')
})

it('binds modification time in approval and refuses legacy metadata-free plans', async () => {
  // what_bug_this_catches: a fix checks mtime at undo but fails to bind the original approved value.
  const { plan } = await fixture()
  const approval = approve(plan, 'rv')
  expect(plan.rows[0]!.mtimeMs).toBe(1700000000000)
  const edited = { ...plan, rows: plan.rows.map(row => ({ ...row, mtimeMs: row.mtimeMs + 1000 })) }
  expect(approvalIsCurrent(edited, approval)).toBe(false)
  const withoutMetadata = { ...plan, rows: plan.rows.map(({ mtimeMs: _ignored, ...row }) => row) }
  expect(parseMovePlan(JSON.stringify(withoutMetadata)).ok).toBe(false)
})

it('refuses apply when only the approved source modification time changes', async () => {
  // what_bug_this_catches: apply checks byte equality but silently acts after external metadata edits.
  const { fs, store, plan } = await fixture()
  const original = fs.readFile('report.pdf')!.slice()
  fs.writeFile('report.pdf', original.slice(), 1700000001000)
  const report = await applyPlan({ fs, store }, plan, approve(plan, 'rv'))
  expect(report.status).not.toBe('committed')
  expect(fs.readFile('report.pdf')).toEqual(original)
  expect(fs.readFile('_Organized/Documents/report.pdf')).toBeNull()
})

it('rejects imported rows when the fresh scan has same bytes but changed metadata', async () => {
  // what_bug_this_catches: import reconstructs a stale fingerprint as a newly valid plan.
  const { fs, plan } = await fixture()
  fs.writeFile('report.pdf', fs.readFile('report.pdf')!.slice(), 1700000001000)
  const fresh = await scanRoot(fs, { scanId: 'rv-fresh-metadata' })
  expect(fresh.files[0]!.sha256).toBe(plan.rows[0]!.sha256)
  const reconstructed = reconstructOrganizeRows(plan, fresh, config)
  expect(reconstructed.rows).toEqual([])
  expect(reconstructed.unmatched).toHaveLength(1)
})
