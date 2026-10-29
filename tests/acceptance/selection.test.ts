import { describe, expect, it } from 'vitest'
import { SandboxSession } from '../../src/ui/session'
import { isBlocked } from '../../src/core/validate'

describe('RV explicit review consent (T23/T35)', () => {
  for (const source of ['heuristic', 'simulated'] as const) {
    it(`${source}: proposals and imported plans need explicit fresh inclusion`, async () => {
      // what_bug_this_catches: a generated or replayed plan silently selects files for mutation.
      const s = new SandboxSession()
      await s.runScan()
      await s.propose(source)
      expect(s.error).toBeNull()
      expect(s.rows.length).toBeGreaterThan(0)
      expect(s.rows.every(r => !r.included)).toBe(true)
      s.approveCurrent()
      expect(s.approvalCurrent).toBe(false)
      await s.selectClean()
      expect(s.plan!.rows.length).toBeGreaterThan(0)
      expect(s.rows.filter(isBlocked).every(r => !r.included)).toBe(true)
      s.approveCurrent()
      expect(s.approvalCurrent).toBe(true)
      const exported = s.exportPlanJson()!
      await s.clearSelection()
      expect(s.approvalCurrent).toBe(false)
      await s.importPlan(exported)
      expect(s.error).toBeNull()
      expect(s.approvalCurrent).toBe(false)
      expect(s.rows.every(r => !r.included)).toBe(true)
    })
  }
  it('editing destination or layout revokes consent', async () => {
    // what_bug_this_catches: approval survives a change to the executable destination.
    const s = new SandboxSession()
    await s.runScan()
    await s.propose('heuristic')
    await s.selectClean()
    s.approveCurrent()
    const row = s.rows.find(r => r.included)!
    await s.editRow(row.rowId, 'documents', 'reviewed-name')
    expect(s.error).toBeNull()
    expect(s.approvalCurrent).toBe(false)
    await s.selectClean()
    s.approveCurrent()
    expect(s.approvalCurrent).toBe(true)
    await s.setOutputRoot('_Reviewed')
    expect(s.approvalCurrent).toBe(false)
  })
})
