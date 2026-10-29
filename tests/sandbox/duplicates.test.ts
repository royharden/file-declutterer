import { describe, expect, it } from 'vitest'
import { MemoryJournalStore } from '../../src/adapters/memory-fs'
import { createSandbox } from '../../src/adapters/sandbox-seed'
import { findDuplicates, quarantineRows, restoreCandidates, restoreRows } from '../../src/core/duplicates'
import { utf8Encode } from '../../src/core/fingerprint'
import { approve, buildPlan, parseMovePlan } from '../../src/core/plan'
import { applyPlan, listRuns, reverseRun, undoBlockers } from '../../src/core/runs'
import { scanRoot } from '../../src/core/scan'
import { isBlocked, observeDestinations, validateRows } from '../../src/core/validate'
import { config, manifestOf } from './helpers'

async function dupSetup() {
  const fs = createSandbox()
  const store = new MemoryJournalStore()
  const scan = await scanRoot(fs, { scanId: 'dup', mode: 'duplicates' })
  return { fs, store, scan, report: findDuplicates(scan, config) }
}

describe('duplicates (T14)', () => {
  it('finds the three true groups, ignores same-size different bytes, reports empties', async () => {
    const { report } = await dupSetup()
    expect(report.groups.length).toBe(3)
    expect(report.groups.flatMap((g) => g.members.map((m) => m.relPath))).not.toContain('sample-a.dat')
    expect(report.zeroByte).toEqual(['empty.log'])
  })

  it('suggests a keeper without selecting anything and blocks selecting every copy', async () => {
    const { report } = await dupSetup()
    const group = report.groups[0]!
    const rows = quarantineRows(report, new Set(group.members.map((m) => m.id)), 'q1', config)
    expect(rows.every((r) => r.proposalIssues.some((i) => i.code === 'no-keeper'))).toBe(true)
  })
})

describe('quarantine and restore (T28, T29)', () => {
  async function quarantineOne() {
    const ctx = await dupSetup()
    const extra = ctx.report.groups[0]!.members[1]!
    const rows = validateRows(quarantineRows(ctx.report, new Set([extra.id]), 'q1', config), {
      kind: 'quarantine',
      config,
      existing: new Map(),
      extOf: () => '',
    })
    const plan = buildPlan({ planId: 'q1', kind: 'quarantine', scan: ctx.scan, config, rows })
    const report = await applyPlan({ fs: ctx.fs, store: ctx.store }, plan, approve(plan, 'now'))
    return { ...ctx, extra, plan, report }
  }

  it('quarantines into the run folder and restores through a reviewed plan', async () => {
    const { fs, store, extra, plan, report } = await quarantineOne()
    expect(report.status).toBe('committed')
    expect(fs.readFile(`_declutter-quarantine/q1/${extra.relPath}`)).not.toBeNull()
    const runs = await listRuns(store)
    const parsed = parseMovePlan((await store.readPlan('q1'))!)
    expect(parsed.ok).toBe(true)
    const candidates = restoreCandidates(plan, runs[0]!.movedTo)
    const rows = await restoreRows(fs, candidates, new Set(candidates.map((c) => c.quarantined)))
    const checked = validateRows(rows, { kind: 'restore', config, existing: await observeDestinations(fs, rows), extOf: () => '' })
    const restore = buildPlan({ planId: 'r1', kind: 'restore', scan: { scanId: 'x', profile: 'sandbox', policyId: 'p', root: { id: fs.rootId, displayHint: '' } }, config, rows: checked, restoreOf: 'q1' })
    const done = await applyPlan({ fs, store }, restore, approve(restore, 'now'))
    expect(done.status).toBe('committed')
    expect(fs.readFile(extra.relPath)).not.toBeNull()
    expect(undoBlockers(await listRuns(store), 'q1').join(' ')).toMatch(/restore/)
  })

  it('refuses a restore into an occupied original path and keeps both (T29)', async () => {
    const { fs, store, extra, plan } = await quarantineOne()
    fs.createForeign(extra.relPath, utf8Encode('newer file'))
    const runs = await listRuns(store)
    const candidates = restoreCandidates(plan, runs[0]!.movedTo)
    const rows = await restoreRows(fs, candidates, new Set(candidates.map((c) => c.quarantined)))
    const checked = validateRows(rows, { kind: 'restore', config, existing: await observeDestinations(fs, rows), extOf: () => '' })
    expect(isBlocked(checked[0]!)).toBe(true)
    expect(fs.readFile(extra.relPath)).not.toBeNull()
    expect(fs.readFile(`_declutter-quarantine/q1/${extra.relPath}`)).not.toBeNull()
  })

  it('undo of a quarantine run returns the file and removes the run folder', async () => {
    const { fs, store } = await quarantineOne()
    const before = manifestOf(createSandbox())
    const undone = await reverseRun({ fs, store }, 'q1', 'undo')
    expect(undone.status).toBe('undone')
    expect(manifestOf(fs)).toBe(before)
    expect(fs.allPaths().some((p) => p.path.startsWith('_declutter-quarantine/q1'))).toBe(false)
  })
})
