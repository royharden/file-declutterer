import { expect, it } from 'vitest'
import { MemoryFs, MemoryJournalStore } from '../../src/adapters/memory-fs'
import { InterruptError } from '../../src/core/fs-port'
import { scanRoot } from '../../src/core/scan'
import { heuristicProposals } from '../../src/core/heuristic'
import { DEFAULT_ROOT_CONFIG as config } from '../../src/core/scan-policy'
import { buildOrganizeRows, observeDestinations, validateRows } from '../../src/core/validate'
import { approve, buildPlan } from '../../src/core/plan'
import { applyPlan, listRuns, newWorkBlockers, reverseRun } from '../../src/core/runs'

it.each([null, '', '{"incomplete":', '\n'])('keeps a run blocked when its journal is lost (%j), PLAN T22', async lost => {
  // what_bug_this_catches: null/empty history gets a fresh genesis and a false rolled_back status.
  const fs = new MemoryFs('rv-lost-journal')
  const bytes = new Uint8Array([0, 255, 128, 17])
  fs.writeFile('report.pdf', bytes)
  const store = new MemoryJournalStore()
  const scan = await scanRoot(fs, { scanId: 'rv-scan' })
  const raw = buildOrganizeRows(scan, { accepted: heuristicProposals(scan), rejected: [], fatal: null }, 'heuristic', 'rv', config)
  const rows = validateRows(raw.map(row => ({ ...row, included: true })), { kind: 'organize', config, existing: await observeDestinations(fs, raw), extOf: () => '.pdf' })
  const plan = buildPlan({ planId: 'rv-lost-history', kind: 'organize', scan, config, rows })
  await expect(applyPlan({ fs, store, checkpoint: boundary => {
    if (boundary.endsWith(':after-link')) throw new InterruptError(boundary)
  } }, plan, approve(plan, 'rv'))).rejects.toBeInstanceOf(InterruptError)
  // Model a missing/zeroed persistence file, retaining the approved plan and user-file state.
  let journal: string | null = lost
  store.readJournal = async () => journal
  store.appendJournal = async (_runId, line) => { journal = (journal ?? '') + line }
  store.replaceJournal = async (_runId, text) => { journal = text }
  const result = await reverseRun({ fs, store }, plan.planId, 'rollback')
  expect.soft(result.status).toBe('needs_attention')
  expect.soft(newWorkBlockers(await listRuns(store)).length).toBe(1)
  expect(journal).toBe(lost)
  expect(fs.readFile('report.pdf')).toEqual(bytes)
  expect(fs.readFile('_Organized/Documents/report.pdf')).toEqual(bytes)
})
