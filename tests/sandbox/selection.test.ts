import { expect, it } from 'vitest'
import { SandboxSession } from '../../src/ui/session'
it('requires explicit proposal selection before approval', async () => {
  // what_bug_this_catches: proposing preselected every clean move without user inclusion.
  const session = new SandboxSession()
  await session.runScan()
  await session.propose('heuristic')
  expect(session.error).toBeNull()
  expect(session.rows.length).toBeGreaterThan(0)
  expect(session.rows.every(row => !row.included)).toBe(true)
  expect(session.plan?.rows).toHaveLength(0)
  await session.selectClean()
  expect(session.plan!.rows.length).toBeGreaterThan(0)
  session.approveCurrent()
  expect(session.approvalCurrent).toBe(true)
  await session.clearSelection()
  expect(session.approvalCurrent).toBe(false)
})
