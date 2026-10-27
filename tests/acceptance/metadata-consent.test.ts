import { expect, it } from 'vitest'
import { MemoryFs, MemoryJournalStore } from '../../src/adapters/memory-fs'
import { scanRoot } from '../../src/core/scan'
import { heuristicProposals } from '../../src/core/heuristic'
import { DEFAULT_ROOT_CONFIG as config } from '../../src/core/scan-policy'
import { buildOrganizeRows, observeDestinations, validateRows } from '../../src/core/validate'
import { approve, buildPlan } from '../../src/core/plan'
import { applyPlan, previewReverse } from '../../src/core/runs'

it('refuses undo after a same-byte, same-identity external metadata change (PLAN section 8)', async () => {
  // what_bug_this_catches: undo ignores changed metadata because executable plans omit mtime.
  const fs = new MemoryFs('rv-metadata')
  fs.writeFile('report.pdf', new Uint8Array([0, 255, 128, 0]), 1700000000000)
  const store = new MemoryJournalStore()
  const scan = await scanRoot(fs, { scanId: 'rv-metadata-scan' })
  const raw = buildOrganizeRows(scan, { accepted: heuristicProposals(scan), rejected: [], fatal: null }, 'heuristic', 'rv', config)
  const rows = validateRows(raw.map(row => ({ ...row, included: true })), { kind: 'organize', config, existing: await observeDestinations(fs, raw), extOf: () => '.pdf' })
  const plan = buildPlan({ planId: 'rv-metadata-plan', kind: 'organize', scan, config, rows })
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
