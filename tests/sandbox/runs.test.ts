import { describe, expect, it } from 'vitest'
import { MemoryJournalStore } from '../../src/adapters/memory-fs'
import { utf8Encode } from '../../src/core/fingerprint'
import { InterruptError } from '../../src/core/fs-port'
import { parseJournal } from '../../src/core/journal-codec'
import { applyPlan, listRuns, newWorkBlockers, reverseRun, RunRefused, undoBlockers } from '../../src/core/runs'
import { approvedOrganizePlan, ctxWithInterrupt, manifestOf, smallSandbox } from './helpers'

const FOUR = ['Q3 report.pdf', 'IMG_0412.jpg', 'podcast-ep12.mp3', 'Downloads/song.flac']

describe('apply and commit', () => {
  it('commits, moves bytes intact and journals intent/outcome pairs', async () => {
    const fs = smallSandbox()
    const store = new MemoryJournalStore()
    const { plan, approval } = await approvedOrganizePlan(fs, 'p1', FOUR)
    const before = fs.manifest()
    const report = await applyPlan({ fs, store }, plan, approval)
    expect(report.status).toBe('committed')
    expect(report.counts.applied).toBe(4)
    const after = fs.manifest()
    expect(after.map((m) => m.sha256).sort()).toEqual(before.map((m) => m.sha256).sort())
    expect(after.some((m) => m.path === '_Organized/Documents/Q3 report.pdf')).toBe(true)
    const records = parseJournal((await store.readJournal('p1'))!).records
    expect(records.filter((r) => r.type === 'intent').length).toBe(records.filter((r) => r.type === 'outcome').length)
  })

  it('refuses unapproved or edited plans', async () => {
    const fs = smallSandbox()
    const { plan } = await approvedOrganizePlan(fs, 'p2', FOUR)
    await expect(applyPlan({ fs, store: new MemoryJournalStore() }, plan, null)).rejects.toBeInstanceOf(RunRefused)
  })

  it('halts before touching a file whose bytes changed with the same size (T05)', async () => {
    const fs = smallSandbox()
    const store = new MemoryJournalStore()
    const { plan, approval } = await approvedOrganizePlan(fs, 'p3', FOUR)
    const original = fs.readFile('IMG_0412.jpg')!
    const swapped = original.slice()
    swapped[0] = swapped[0]! ^ 1
    fs.writeFile('IMG_0412.jpg', swapped, (await fs.stat('IMG_0412.jpg'))!.mtimeMs)
    const report = await applyPlan({ fs, store }, plan, approval)
    expect(report.status).toBe('open')
    expect(report.haltReason).toMatch(/changed since approval/)
    expect(fs.readFile('IMG_0412.jpg')).toEqual(swapped)
  })

  it('halts remaining operations when a source is missing (T06)', async () => {
    const fs = smallSandbox()
    const store = new MemoryJournalStore()
    const { plan, approval } = await approvedOrganizePlan(fs, 'p4', FOUR)
    fs.removeExternally('podcast-ep12.mp3')
    const report = await applyPlan({ fs, store }, plan, approval)
    expect(report.haltReason).toMatch(/missing/)
    expect(fs.readFile('Downloads/song.flac')).not.toBeNull()
    const runs = await listRuns(store)
    expect(newWorkBlockers(runs).length).toBe(1)
  })
})

describe('interruption and recovery (T15, T20)', () => {
  it('recovers the exact manifest from every apply boundary', async () => {
    const probe = smallSandbox()
    const probeCtx = ctxWithInterrupt(probe, new MemoryJournalStore())
    const { plan: probePlan, approval: probeApproval } = await approvedOrganizePlan(probe, 'probe', FOUR)
    await applyPlan(probeCtx, probePlan, probeApproval)
    const total = probeCtx.reached.length
    expect(total).toBeGreaterThan(10)
    for (let n = 1; n <= total; n++) {
      const fs = smallSandbox()
      const store = new MemoryJournalStore()
      const before = manifestOf(fs)
      const { plan, approval } = await approvedOrganizePlan(fs, `run-${n}`, FOUR)
      await expect(applyPlan(ctxWithInterrupt(fs, store, n), plan, approval)).rejects.toBeInstanceOf(InterruptError)
      const report = await reverseRun({ fs, store }, `run-${n}`, 'rollback')
      expect(report.status, `boundary ${n}`).toBe('rolled_back')
      expect(manifestOf(fs), `boundary ${n}`).toBe(before)
    }
  })

  it('retries recovery interrupted at every reverse boundary', async () => {
    for (let k = 1; k <= 80; k++) {
      const fs = smallSandbox()
      const store = new MemoryJournalStore()
      const before = manifestOf(fs)
      const { plan, approval } = await approvedOrganizePlan(fs, 'r', FOUR)
      expect((await applyPlan({ fs, store }, plan, approval)).status).toBe('committed')
      const interrupted = await reverseRun(ctxWithInterrupt(fs, store, k), 'r', 'undo').then(
        () => false,
        (e) => e instanceof InterruptError,
      )
      if (!interrupted) {
        expect(manifestOf(fs)).toBe(before)
        break
      }
      const runs = await listRuns(store)
      expect(runs[0]!.status).toBe('needs_attention')
      expect(newWorkBlockers(runs).length).toBe(1)
      const retry = await reverseRun({ fs, store }, 'r', 'undo')
      expect(retry.status, `reverse boundary ${k}`).toBe('undone')
      expect(manifestOf(fs), `reverse boundary ${k}`).toBe(before)
    }
  })
})

describe('conflicts (T16-T19)', () => {
  it('linked-only unlink failure halts and recovery removes only the extra link (T16)', async () => {
    const fs = smallSandbox()
    const store = new MemoryJournalStore()
    const before = manifestOf(fs)
    const { plan, approval } = await approvedOrganizePlan(fs, 'l', FOUR)
    fs.injectFault({ op: 'unlink', nth: 2 })
    const report = await applyPlan({ fs, store }, plan, approval)
    expect(report.status).toBe('needs_attention')
    expect(report.haltReason).toMatch(/Both names refer to one file/)
    const recovered = await reverseRun({ fs, store }, 'l', 'rollback')
    expect(recovered.status).toBe('rolled_back')
    expect(manifestOf(fs)).toBe(before)
  })

  it('preserves a foreign file that appears at the destination after intent (T17)', async () => {
    const fs = smallSandbox()
    const store = new MemoryJournalStore()
    const { plan, approval } = await approvedOrganizePlan(fs, 'f', ['Q3 report.pdf'])
    // Boundaries: after-begin (1), mkdir _Organized (2-5), mkdir Documents (6-9), move before-intent (10), after-intent (11).
    const ctx = ctxWithInterrupt(fs, store, 11)
    await expect(applyPlan(ctx, plan, approval)).rejects.toBeInstanceOf(InterruptError)
    expect(ctx.reached[10]).toMatch(/after-intent/)
    fs.createForeign('_Organized/Documents/Q3 report.pdf', utf8Encode('someone else'))
    const report = await reverseRun({ fs, store }, 'f', 'rollback')
    expect(report.status).toBe('rolled_back')
    expect(new TextDecoder().decode(fs.readFile('_Organized/Documents/Q3 report.pdf')!)).toBe('someone else')
    expect(fs.readFile('Q3 report.pdf')).not.toBeNull()
  })

  it('refuses to reverse a changed destination or reoccupied original, then retries exactly once (T18, T19)', async () => {
    const fs = smallSandbox()
    const store = new MemoryJournalStore()
    const { plan, approval } = await approvedOrganizePlan(fs, 'u', FOUR)
    await applyPlan({ fs, store }, plan, approval)
    fs.createForeign('IMG_0412.jpg', utf8Encode('new file at the old path'))
    const first = await reverseRun({ fs, store }, 'u', 'undo')
    expect(first.status).toBe('needs_attention')
    expect(first.counts.unresolved).toBe(1)
    expect(fs.readFile('_Organized/Images/IMG_0412.jpg')).not.toBeNull()
    fs.removeExternally('IMG_0412.jpg')
    const second = await reverseRun({ fs, store }, 'u', 'undo')
    expect(second.status).toBe('undone')
    expect(second.counts.reversed).toBe(1)
    await expect(reverseRun({ fs, store }, 'u', 'undo')).rejects.toBeInstanceOf(RunRefused)
    expect(fs.manifest().filter((m) => m.path === 'IMG_0412.jpg').length).toBe(1)
  })
})

describe('journal integrity (T21, T39)', () => {
  it('tolerates a torn tail but flags a corrupt complete record', async () => {
    const fs = smallSandbox()
    const store = new MemoryJournalStore()
    const { plan, approval } = await approvedOrganizePlan(fs, 't', FOUR)
    await expect(applyPlan(ctxWithInterrupt(fs, store, 12), plan, approval)).rejects.toBeInstanceOf(InterruptError)
    store.tearAppend('t', '{"schema":"declutter-jour')
    expect(parseJournal((await store.readJournal('t'))!).tornTail).not.toBeNull()
    expect(parseJournal((await store.readJournal('t'))!).corrupt).toBeNull()
    const text = (await store.readJournal('t'))!
    const lines = text.split('\n')
    lines[1] = lines[1]!.replace('"seq":1', '"seq":7')
    expect(parseJournal(lines.join('\n')).corrupt).not.toBeNull()
  })

  it('continues after a torn tail with preserved evidence, across another crash (T39)', async () => {
    const fs = smallSandbox()
    const store = new MemoryJournalStore()
    const before = manifestOf(fs)
    const { plan, approval } = await approvedOrganizePlan(fs, 'c', FOUR)
    await expect(applyPlan(ctxWithInterrupt(fs, store, 15), plan, approval)).rejects.toBeInstanceOf(InterruptError)
    store.tearAppend('c', '{"partial":')
    // Crash again during the recovery that continues the journal.
    await expect(reverseRun(ctxWithInterrupt(fs, store, 2), 'c', 'rollback')).rejects.toBeInstanceOf(InterruptError)
    expect(store.preserved.size).toBe(1)
    const parsed = parseJournal((await store.readJournal('c'))!)
    expect(parsed.corrupt).toBeNull()
    expect(parsed.records.some((r) => r.type === 'continuation')).toBe(true)
    const done = await reverseRun({ fs, store }, 'c', 'rollback')
    expect(done.status).toBe('rolled_back')
    expect(manifestOf(fs)).toBe(before)
  })
})

describe('folders and budget (T36, T37)', () => {
  it('removes only folders this run created and that are empty (T37)', async () => {
    const fs = smallSandbox()
    fs.mkdirp('_Organized/Images')
    const store = new MemoryJournalStore()
    const { plan, approval } = await approvedOrganizePlan(fs, 'd', FOUR)
    await applyPlan({ fs, store }, plan, approval)
    fs.createForeign('_Organized/Audio/keep-me.txt', utf8Encode('foreign'))
    const report = await reverseRun({ fs, store }, 'd', 'undo')
    expect(report.status).toBe('undone')
    const paths = fs.allPaths().map((p) => p.path)
    expect(paths).toContain('_Organized/Images')
    expect(paths).toContain('_Organized/Audio/keep-me.txt')
    expect(paths).not.toContain('_Organized/Documents')
  })

  it('counts folder operations in the plan budget (T36)', async () => {
    const fs = smallSandbox()
    const store = new MemoryJournalStore()
    const { plan, approval } = await approvedOrganizePlan(fs, 'b')
    const report = await applyPlan({ fs, store }, plan, approval)
    const records = parseJournal((await store.readJournal('b'))!).records
    const mkdirs = records.filter((r) => r.type === 'intent' && r.op === 'mkdir').length
    expect(mkdirs).toBeGreaterThan(0)
    expect(report.counts.applied).toBe(plan.rows.length)
  })
})

describe('run dependencies (T28 core)', () => {
  it('blocks undo of an older run while a newer committed run exists', async () => {
    const fs = smallSandbox()
    const store = new MemoryJournalStore()
    const a = await approvedOrganizePlan(fs, 'older', ['Q3 report.pdf'])
    await applyPlan({ fs, store }, a.plan, a.approval)
    const b = await approvedOrganizePlan(fs, 'newer', ['IMG_0412.jpg'])
    await applyPlan({ fs, store }, b.plan, b.approval)
    const runs = await listRuns(store)
    expect(undoBlockers(runs, 'older').join(' ')).toMatch(/newer/)
    expect(undoBlockers(runs, 'newer')).toEqual([])
  })
})
