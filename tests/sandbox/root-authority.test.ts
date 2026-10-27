import { expect, it } from 'vitest'
import { MemoryFs, MemoryJournalStore } from '../../src/adapters/memory-fs'
import { applyPlan, reverseRun, previewReverse, listRuns, newWorkBlockers } from '../../src/core/runs'
import { approvedOrganizePlan } from './helpers'
it('refuses reversal authority from another root even when local bytes and inode labels match', async () => {
  // what_bug_this_catches: reversal checked plan/journal agreement but not the active filesystem root.
  const source = new MemoryFs('authority-A')
  const other = new MemoryFs('authority-B')
  const storeA = new MemoryJournalStore();const storeB = new MemoryJournalStore()
  for (const fs of [source,other]) fs.writeFile('report.pdf',new Uint8Array([1,2,3]),1700000000000)
  const a=await approvedOrganizePlan(source,'a');const b=await approvedOrganizePlan(other,'b')
  expect((await applyPlan({fs:source,store:storeA},a.plan,a.approval)).status).toBe('committed')
  expect((await applyPlan({fs:other,store:storeB},b.plan,b.approval)).status).toBe('committed')
  const before=other.manifest()
  await expect(previewReverse({fs:other,store:storeA},'a')).rejects.toThrow(/root/)
  await expect(reverseRun({fs:other,store:storeA},'a','undo')).rejects.toThrow(/root/)
  expect(newWorkBlockers(await listRuns(storeA,other)).length).toBeGreaterThan(0)
  expect(other.manifest()).toEqual(before)
})
