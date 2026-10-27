import { expect, it } from 'vitest'
import { MemoryFs, MemoryJournalStore } from '../../src/adapters/memory-fs'
import { InterruptError, type FsPort } from '../../src/core/fs-port'
import { scanRoot } from '../../src/core/scan'
import { heuristicProposals } from '../../src/core/heuristic'
import { DEFAULT_ROOT_CONFIG as config } from '../../src/core/scan-policy'
import { buildOrganizeRows, observeDestinations, validateRows } from '../../src/core/validate'
import { approve, buildPlan } from '../../src/core/plan'
import { applyPlan, listRuns, newWorkBlockers, previewReverse, reverseRun } from '../../src/core/runs'

const bytes = new Uint8Array([0, 255, 127, 9])
function seeded(id: string) { const fs = new MemoryFs(id); fs.writeFile('report.pdf', bytes.slice(), 1700000000000); return fs }
async function planFor(fs: MemoryFs, id: string) {
  const scan = await scanRoot(fs, { scanId: `scan-${id}` })
  const raw = buildOrganizeRows(scan, { accepted: heuristicProposals(scan), rejected: [], fatal: null }, 'heuristic', 'rv', config)
  const rows = validateRows(raw.map(row => ({ ...row, included: true })), { kind: 'organize', config, existing: await observeDestinations(fs, raw), extOf: () => '.pdf' })
  const plan = buildPlan({ planId: id, kind: 'organize', scan, config, rows })
  return { plan, approval: approve(plan, 'rv-authority') }
}
function snapshot(fs: MemoryFs) {
  return fs.allPaths().filter(entry => entry.kind === 'file').map(entry => [entry.path, Array.from(fs.readFile(entry.path)!)])
}
async function history(store: MemoryJournalStore) {
  return Promise.all((await store.listRuns()).map(async id => [id, await store.readPlan(id), await store.readJournal(id)]))
}
function observed(fs: MemoryFs, profile: 'sandbox' | 'native' = 'sandbox') {
  const calls: string[] = []
  const port = new Proxy(fs, { get(target, key) {
    if (key === 'profile') return profile
    const value = Reflect.get(target, key)
    if (typeof value !== 'function') return value
    return (...args: unknown[]) => { calls.push(String(key)); return value.apply(target, args) }
  } }) as unknown as FsPort
  return { port, calls }
}

it.each(['root', 'profile'] as const)('refuses approved apply with mismatched active %s before any FS or journal mutation', async mismatch => {
  // what_bug_this_catches: approval digest is treated as authority for another root/profile.
  const a = seeded('rv-A')
  const b = seeded(mismatch === 'root' ? 'rv-B' : 'rv-A')
  const store = new MemoryJournalStore()
  const prepared = await planFor(a, 'rv-apply')
  const spy = observed(b, mismatch === 'profile' ? 'native' : 'sandbox')
  const before = snapshot(b)
  await expect(applyPlan({ fs: spy.port, store }, prepared.plan, prepared.approval)).rejects.toThrow(/root/)
  expect(spy.calls).toEqual([])
  expect(snapshot(b)).toEqual(before)
  expect(await history(store)).toEqual([])
})

it.each(['root', 'profile'] as const)('rejects foreign %s preview/reversal/index without consuming matching inode labels', async mismatch => {
  // what_bug_this_catches: local inode labels and hashes match while the active authority does not.
  const a = seeded('rv-A')
  const b = seeded(mismatch === 'root' ? 'rv-B' : 'rv-A')
  const storeA = new MemoryJournalStore(), storeB = new MemoryJournalStore()
  const pa = await planFor(a, 'run-A'), pb = await planFor(b, 'run-B')
  await applyPlan({ fs: a, store: storeA }, pa.plan, pa.approval)
  await applyPlan({ fs: b, store: storeB }, pb.plan, pb.approval)
  expect((await a.stat('_Organized/Documents/report.pdf'))!.identity).toBe((await b.stat('_Organized/Documents/report.pdf'))!.identity)
  const spy = observed(b, mismatch === 'profile' ? 'native' : 'sandbox')
  const before = snapshot(b), priorHistory = await history(storeA)
  await expect(previewReverse({ fs: spy.port, store: storeA }, pa.plan.planId)).rejects.toThrow(/root/)
  await expect(reverseRun({ fs: spy.port, store: storeA }, pa.plan.planId, 'undo')).rejects.toThrow(/root/)
  const runs = await listRuns(storeA, spy.port)
  expect(runs[0]!.status).toBe('needs_attention')
  expect(newWorkBlockers(runs)).toHaveLength(1)
  expect(spy.calls).toEqual([])
  expect(await history(storeA)).toEqual(priorHistory)
  expect(snapshot(b)).toEqual(before)
  expect((await reverseRun({ fs: a, store: storeA }, pa.plan.planId, 'undo')).status).toBe('undone')
  expect(a.readFile('report.pdf')).toEqual(bytes)
  expect(snapshot(b)).toEqual(before)
})

it('refuses foreign-root interrupted rollback without reading or changing that filesystem', async () => {
  // what_bug_this_catches: a guard is added to undo but omitted from rollback.
  const a = seeded('rv-A'), b = seeded('rv-B')
  const store = new MemoryJournalStore()
  const prepared = await planFor(a, 'rv-interrupted')
  await expect(applyPlan({ fs: a, store, checkpoint: boundary => { if (boundary.endsWith(':after-link')) throw new InterruptError(boundary) } }, prepared.plan, prepared.approval)).rejects.toBeInstanceOf(InterruptError)
  const spy = observed(b), before = snapshot(b), priorHistory = await history(store)
  await expect(reverseRun({ fs: spy.port, store }, prepared.plan.planId, 'rollback')).rejects.toThrow(/root/)
  expect(spy.calls).toEqual([])
  expect(snapshot(b)).toEqual(before)
  expect(await history(store)).toEqual(priorHistory)
  expect((await reverseRun({ fs: a, store }, prepared.plan.planId, 'rollback')).status).toBe('rolled_back')
})

it('blocks an otherwise valid apply when a mixed store contains committed foreign-root history', async () => {
  // what_bug_this_catches: only the CLI supplies foreign-history blockers; core apply can bypass them.
  const a = seeded('rv-A'), b = seeded('rv-B')
  const storeA = new MemoryJournalStore(), storeB = new MemoryJournalStore()
  const pb = await planFor(b, 'foreign-committed')
  await applyPlan({ fs: b, store: storeB }, pb.plan, pb.approval)
  await storeA.writePlan(pb.plan.planId, (await storeB.readPlan(pb.plan.planId))!)
  await storeA.replaceJournal(pb.plan.planId, (await storeB.readJournal(pb.plan.planId))!)
  const pa = await planFor(a, 'fresh-correct-root')
  const spy = observed(a), before = snapshot(a), priorHistory = await history(storeA)
  await expect(applyPlan({ fs: spy.port, store: storeA }, pa.plan, pa.approval, [])).rejects.toThrow(/unresolved/)
  expect(spy.calls).toEqual([])
  expect(snapshot(a)).toEqual(before)
  expect(await history(storeA)).toEqual(priorHistory)
})
