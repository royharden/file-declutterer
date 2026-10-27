import { findDuplicates, quarantineRows } from '../core/duplicates.js'
import { sha256Text, utf8Encode } from '../core/fingerprint.js'
import { InterruptError, type Checkpoint } from '../core/fs-port.js'
import { heuristicProposals } from '../core/heuristic.js'
import { parseJournal } from '../core/journal-codec.js'
import { checkProposedBasename, checkRelativePath } from '../core/paths.js'
import { approvalIsCurrent, approve, buildPlan, parseMovePlan, reconstructOrganizeRows, type Approval, type MovePlan } from '../core/plan.js'
import { parseProposalResponse, parseProposalText, PROPOSAL_LIMITS } from '../core/proposal-schema.js'
import { applyPlan, listRuns, newWorkBlockers, reverseRun, undoBlockers } from '../core/runs.js'
import { scanRoot } from '../core/scan.js'
import { DEFAULT_ROOT_CONFIG } from '../core/scan-policy.js'
import { TRAPS, type TrapDef } from '../core/traps.js'
import type { ScanManifest } from '../core/types.js'
import { buildOrganizeRows, defaultSelection, editOrganizeRow, isBlocked, observeDestinations, validateRows, type PlanRow } from '../core/validate.js'
import { MemoryFs, MemoryJournalStore } from './memory-fs.js'
import { createSandbox, simulatedResponse } from './sandbox-seed.js'

// Sandbox trap runner. Each S/B trap runs against its own fresh MemoryFs and journal store
// (no shared rollback state) and reports what it observed. N traps are "not run": simulated
// locks and in-memory volumes cannot pass native cases. Results are produced only by
// actually executing in the visitor's page; nothing here is a precomputed score.

export type TrapOutcome = 'pass' | 'fail' | 'not-run' | 'error'

export interface TrapResult {
  trap: TrapDef
  sandbox: TrapOutcome
  native: 'not-run'
  observation: string
}

const config = DEFAULT_ROOT_CONFIG
type Check = () => Promise<{ pass: boolean; observation: string }>

async function scanOf(fs: MemoryFs): Promise<ScanManifest> {
  return scanRoot(fs, { scanId: 'trap-scan' })
}

async function validated(fs: MemoryFs, scan: ScanManifest, rows: PlanRow[]): Promise<PlanRow[]> {
  const extOf = (id: string) => scan.files.find((f) => f.id === id)?.ext ?? ''
  return validateRows(rows, { kind: 'organize', config, existing: await observeDestinations(fs, rows), extOf })
}

async function heuristicRows(fs: MemoryFs, scan: ScanManifest): Promise<PlanRow[]> {
  return validated(fs, scan, defaultSelection(await validated(fs, scan, buildOrganizeRows(scan, { accepted: heuristicProposals(scan), rejected: [], fatal: null }, 'heuristic', 'h', config))))
}

async function approved(fs: MemoryFs, planId: string, only?: string[]): Promise<{ plan: MovePlan; approval: Approval }> {
  const scan = await scanOf(fs)
  let rows = await heuristicRows(fs, scan)
  if (only) rows = await validated(fs, scan, rows.map((r) => ({ ...r, included: r.included && only.includes(r.source) })))
  const plan = buildPlan({ planId, kind: 'organize', scan, config, rows })
  return { plan, approval: approve(plan, 'trap') }
}

function interruptAt(n: number): { checkpoint: Checkpoint; reached: string[] } {
  const reached: string[] = []
  return {
    reached,
    checkpoint: (b) => {
      reached.push(b)
      if (reached.length === n) throw new InterruptError(b)
    },
  }
}

const manifest = (fs: MemoryFs): string => JSON.stringify(fs.manifest())

/**
 * T36 fixture: n loose files, each planned into its own new folder chain
 * _Organized/x<i>/<chain...>/f<i>.txt, so every row needs 1 + chain.length new folders
 * (plus the shared _Organized). Rows are built directly to exercise the executor budget.
 */
async function deepPlan(planId: string, n: number, chain: string[]): Promise<{ fs: MemoryFs; plan: MovePlan; before: string }> {
  const fs = new MemoryFs()
  for (let i = 0; i < n; i++) fs.writeFile(`f${i}.txt`, utf8Encode(`file ${i}`))
  const before = manifest(fs)
  const rows: PlanRow[] = []
  for (let i = 0; i < n; i++) {
    const source = `f${i}.txt`
    const info = (await fs.stat(source))!
    rows.push({
      rowId: `r${i}`, fileId: `r${i}`, source, size: info.size, mtimeMs: info.mtimeMs, sha256: await fs.sha256(source), identity: info.identity,
      categoryId: null, basename: null, destination: ['_Organized', `x${i}`, ...chain, source].join('/'),
      provenance: 'manual-edit', batchId: null, confidence: null, reason: '', included: true, proposalIssues: [], issues: [], noop: false,
    })
  }
  const scan = { scanId: `scan-${planId}`, profile: 'sandbox' as const, policyId: 'scan-policy-v1', root: { id: fs.rootId, displayHint: fs.rootDisplay } }
  return { fs, plan: buildPlan({ planId, kind: 'organize', scan, config, rows }), before }
}
const FEW = ['Q3 report.pdf', 'IMG_0412.jpg', 'Downloads/song.flac']
const codesFor = (rows: PlanRow[], path: string): string[] => rows.find((r) => r.source === path)?.issues.map((i) => i.code) ?? []

const CHECKS: Record<string, Check> = {
  async T01() {
    const fs = createSandbox()
    const rows = await heuristicRows(fs, await scanOf(fs))
    const codes = codesFor(rows, 'Downloads/Report Final.pdf')
    return { pass: codes.includes('duplicate-destination'), observation: `Report Final.pdf issues: ${codes.join(', ') || 'none'}` }
  },
  async T02() {
    const fs = createSandbox()
    const rows = await heuristicRows(fs, await scanOf(fs))
    const a = codesFor(rows, 'Downloads/caf\u00e9.txt')
    const b = codesFor(rows, 'Downloads/old/cafe\u0301.txt')
    return { pass: a.includes('duplicate-destination') && b.includes('duplicate-destination'), observation: `NFC/NFD café rows blocked: ${a.includes('duplicate-destination')}/${b.includes('duplicate-destination')}` }
  },
  async T03() {
    const fs = createSandbox()
    fs.writeFile('_Organized/Documents/notes.txt', utf8Encode('existing'))
    const rows = await heuristicRows(fs, await scanOf(fs))
    const kept = new TextDecoder().decode(fs.readFile('_Organized/Documents/notes.txt')!)
    return { pass: codesFor(rows, 'notes.txt').includes('occupied') && kept === 'existing', observation: `notes.txt: ${codesFor(rows, 'notes.txt').join(', ')}` }
  },
  async T04() {
    const fs = new MemoryFs()
    fs.writeFile('a.txt', utf8Encode('a'))
    fs.writeFile('b.txt', utf8Encode('b'))
    const scan = await scanOf(fs)
    const base = buildOrganizeRows(scan, { accepted: [], rejected: [], fatal: null }, 'manual-edit', null, config)
    const swap = await validated(fs, scan, base.map((r) => ({ ...r, proposalIssues: [], destination: r.source === 'a.txt' ? 'b.txt' : 'a.txt', included: true })))
    const caseOnly = await validated(fs, scan, [{ ...base[0]!, proposalIssues: [], destination: base[0]!.source.toUpperCase(), included: true }])
    const pass = swap.every(isBlocked) && caseOnly.every(isBlocked)
    return { pass, observation: `swap blocked: ${swap.every(isBlocked)}, case-only blocked: ${caseOnly.every(isBlocked)}` }
  },
  async T05() {
    const fs = createSandbox()
    const { plan, approval } = await approved(fs, 't05', FEW)
    const info = (await fs.stat('IMG_0412.jpg'))!
    const bytes = fs.readFile('IMG_0412.jpg')!.slice()
    bytes[0] = bytes[0]! ^ 1
    fs.writeFile('IMG_0412.jpg', bytes, info.mtimeMs)
    const report = await applyPlan({ fs, store: new MemoryJournalStore() }, plan, approval)
    return { pass: report.status === 'open' && /changed/.test(report.haltReason ?? ''), observation: report.haltReason ?? 'no halt' }
  },
  async T06() {
    const fs = createSandbox()
    const { plan, approval } = await approved(fs, 't06', FEW)
    fs.removeExternally('Q3 report.pdf')
    const report = await applyPlan({ fs, store: new MemoryJournalStore() }, plan, approval)
    return { pass: /missing/.test(report.haltReason ?? '') && fs.readFile('Downloads/song.flac') !== null, observation: report.haltReason ?? 'no halt' }
  },
  async T07() {
    const scan = await scanOf(createSandbox())
    const paths = scan.files.map((f) => f.relPath)
    const leaked = paths.filter((p) => /^(README|LICENSE|\.env)/.test(p) || p.startsWith('Projects/webapp') || p.startsWith('Projects/tool'))
    return { pass: leaked.length === 0 && scan.projectRoots.length === 2, observation: `project trees ${scan.projectRoots.join(', ')}; leaked ${leaked.length}` }
  },
  async T08() {
    const fs = createSandbox()
    fs.writeFile('_Organized/Images', utf8Encode('file in the way'))
    const scan = await scanOf(fs)
    let rows = await heuristicRows(fs, scan)
    const notes = scan.files.find((f) => f.relPath === 'notes.txt')!
    rows = await validated(fs, scan, rows.map((r) => (r.fileId === notes.id ? editOrganizeRow(r, notes, 'documents', 'LICENSE', config) : r)))
    const pass = codesFor(rows, 'IMG_0412.jpg').includes('parent-is-file') && codesFor(rows, 'notes.txt').includes('protected-destination')
    return { pass, observation: `parent-file: ${codesFor(rows, 'IMG_0412.jpg').join(', ')}; protected: ${codesFor(rows, 'notes.txt').join(', ')}` }
  },
  async T09() {
    const bad = ['../x', '/abs', 'C:/x', '//srv/share', 'a:ads', 'CON.txt', 'a/b.', 'x'.repeat(121), 'a/\u0001']
    const accepted = bad.filter((p) => checkRelativePath(p).ok)
    return { pass: accepted.length === 0, observation: accepted.length ? `accepted: ${accepted.join(' ')}` : `${bad.length} unsafe paths rejected` }
  },
  async T10() {
    const scan = await scanOf(createSandbox())
    const literal = scan.files.some((f) => f.relPath === '%41.txt')
    const encoded = checkProposedBasename('%2e%2e%2fescape').ok
    return { pass: literal && !encoded && checkProposedBasename('%41').ok, observation: `literal %41.txt kept: ${literal}; encoded traversal accepted: ${encoded}` }
  },
  async T11() {
    const ids = new Set(['f001'])
    const item = { fileId: 'f001', categoryId: 'documents', basename: 'a', confidence: 0.9, reason: '' }
    const cases = [
      parseProposalResponse({ proposals: [{ ...item, extra: 1 }] }, ids),
      parseProposalResponse({ proposals: [{ ...item, fileId: 'nope' }] }, ids),
      parseProposalResponse({ proposals: [item, item] }, ids),
      parseProposalResponse({ proposals: [{ ...item, categoryId: 'taxes' }] }, ids),
      parseProposalResponse({ proposals: [], extra: true }, ids),
    ]
    const leaked = cases.filter((c) => c.accepted.length > 0).length
    return { pass: leaked === 0, observation: `${cases.length - leaked}/${cases.length} malformed responses produced no proposals` }
  },
  async T12() {
    const fs = new MemoryFs()
    fs.writeFile('<img src=x onerror=alert(1)>.txt', utf8Encode('x'))
    fs.writeFile('ok.txt', utf8Encode('y'))
    const scan = await scanOf(fs)
    const skipped = scan.skipped.some((s) => s.reason === 'invalid-name')
    const parsed = parseProposalResponse({ proposals: [{ fileId: scan.files[0]!.id, categoryId: 'documents', basename: 'ok', confidence: 1, reason: '<script>alert(1)</script>; rm -rf /' }] }, new Set(scan.files.map((f) => f.id)))
    const reasonIsData = parsed.accepted[0]?.reason === '<script>alert(1)</script>; rm -rf /'
    return { pass: skipped && reasonIsData, observation: `markup name skipped: ${skipped}; reason kept verbatim as data (rendered as text): ${reasonIsData}` }
  },
  async T13() {
    const fs = createSandbox()
    const scan = await scanRoot(fs, { scanId: 'small', bounds: { maxFiles: 3, maxBytes: 1e9, maxDepth: 4, maxEntries: 2000 } })
    const big = parseProposalResponse({ proposals: new Array(PROPOSAL_LIMITS.maxItems + 1).fill({}) }, new Set())
    return { pass: scan.status === 'aborted' && scan.files.length === 0 && big.fatal !== null, observation: `scan: ${scan.status} (${scan.abortReason}); oversize response: ${big.fatal}` }
  },
  async T14() {
    const fs = createSandbox()
    fs.injectFault({ op: 'sha256', nth: 1, path: 'clip.mp4' })
    const scan = await scanRoot(fs, { scanId: 'd', mode: 'duplicates', hashConcurrency: 1 })
    const report = findDuplicates(scan, config)
    const sameSize = report.groups.some((g) => g.members.some((m) => m.relPath === 'sample-a.dat'))
    const pass = !sameSize && report.zeroByte.includes('empty.log') && report.unhashable.includes('clip.mp4') && report.groups.length === 3
    return { pass, observation: `${report.groups.length} groups; same-size different bytes grouped: ${sameSize}; zero-byte ${report.zeroByte.length}; unhashable ${report.unhashable.length}` }
  },
  async T15() {
    const probe = createSandbox()
    const p = await approved(probe, 'probe', FEW)
    const counter = interruptAt(0)
    await applyPlan({ fs: probe, store: new MemoryJournalStore(), checkpoint: counter.checkpoint }, p.plan, p.approval)
    let failures = 0
    for (let n = 1; n <= counter.reached.length; n++) {
      const fs = createSandbox()
      const store = new MemoryJournalStore()
      const before = manifest(fs)
      const { plan, approval } = await approved(fs, `r${n}`, FEW)
      try {
        await applyPlan({ fs, store, checkpoint: interruptAt(n).checkpoint }, plan, approval)
      } catch (e) {
        if (!(e instanceof InterruptError)) throw e
      }
      const report = await reverseRun({ fs, store }, `r${n}`, 'rollback')
      if (report.status !== 'rolled_back' || manifest(fs) !== before) failures++
    }
    return { pass: failures === 0, observation: `${counter.reached.length} apply boundaries interrupted; ${failures} failed to restore the exact manifest` }
  },
  async T16() {
    const fs = createSandbox()
    const store = new MemoryJournalStore()
    const before = manifest(fs)
    const { plan, approval } = await approved(fs, 't16', FEW)
    fs.injectFault({ op: 'unlink', nth: 1 })
    const report = await applyPlan({ fs, store }, plan, approval)
    const recovered = await reverseRun({ fs, store }, 't16', 'rollback')
    return { pass: report.status === 'needs_attention' && recovered.status === 'rolled_back' && manifest(fs) === before, observation: `apply ${report.status}; recovery ${recovered.status}` }
  },
  async T17() {
    const fs = createSandbox()
    const store = new MemoryJournalStore()
    const { plan, approval } = await approved(fs, 't17', ['Q3 report.pdf'])
    try {
      await applyPlan({ fs, store, checkpoint: interruptAt(11).checkpoint }, plan, approval)
    } catch (e) {
      if (!(e instanceof InterruptError)) throw e
    }
    fs.createForeign('_Organized/Documents/Q3 report.pdf', utf8Encode('foreign'))
    const report = await reverseRun({ fs, store }, 't17', 'rollback')
    const foreign = new TextDecoder().decode(fs.readFile('_Organized/Documents/Q3 report.pdf') ?? new Uint8Array())
    return { pass: foreign === 'foreign' && fs.readFile('Q3 report.pdf') !== null, observation: `recovery ${report.status}; foreign file preserved: ${foreign === 'foreign'}` }
  },
  async T18() {
    const fs = createSandbox()
    const store = new MemoryJournalStore()
    const { plan, approval } = await approved(fs, 't18', FEW)
    await applyPlan({ fs, store }, plan, approval)
    fs.writeFile('_Organized/Images/IMG_0412.jpg', utf8Encode('edited elsewhere'))
    const report = await reverseRun({ fs, store }, 't18', 'undo')
    const kept = new TextDecoder().decode(fs.readFile('_Organized/Images/IMG_0412.jpg') ?? new Uint8Array())
    return { pass: report.status === 'needs_attention' && kept === 'edited elsewhere', observation: `undo ${report.status}; unresolved ${report.counts.unresolved}; edited file preserved: ${kept === 'edited elsewhere'}` }
  },
  async T19() {
    const fs = createSandbox()
    const store = new MemoryJournalStore()
    const before = manifest(fs)
    const { plan, approval } = await approved(fs, 't19', FEW)
    await applyPlan({ fs, store }, plan, approval)
    fs.createForeign('IMG_0412.jpg', utf8Encode('squatter'))
    const first = await reverseRun({ fs, store }, 't19', 'undo')
    fs.removeExternally('IMG_0412.jpg')
    const second = await reverseRun({ fs, store }, 't19', 'undo')
    let third = 'refused'
    try {
      third = (await reverseRun({ fs, store }, 't19', 'undo')).status
    } catch {
      third = 'refused'
    }
    return { pass: first.status === 'needs_attention' && second.status === 'undone' && third === 'refused' && manifest(fs) === before, observation: `first ${first.status}, second ${second.status}, third ${third}` }
  },
  async T20() {
    let failures = 0
    let tried = 0
    for (let k = 1; k <= 60; k++) {
      const fs = createSandbox()
      const store = new MemoryJournalStore()
      const before = manifest(fs)
      const { plan, approval } = await approved(fs, 't20', FEW)
      await applyPlan({ fs, store }, plan, approval)
      let interrupted = false
      try {
        await reverseRun({ fs, store, checkpoint: interruptAt(k).checkpoint }, 't20', 'undo')
      } catch (e) {
        if (!(e instanceof InterruptError)) throw e
        interrupted = true
      }
      if (!interrupted) break
      tried++
      const retry = await reverseRun({ fs, store }, 't20', 'undo')
      if (retry.status !== 'undone' || manifest(fs) !== before) failures++
    }
    return { pass: tried > 0 && failures === 0, observation: `${tried} reverse boundaries interrupted and retried; ${failures} failures` }
  },
  async T21() {
    const fs = createSandbox()
    const store = new MemoryJournalStore()
    const { plan, approval } = await approved(fs, 't21', FEW)
    await applyPlan({ fs, store }, plan, approval)
    const text = (await store.readJournal('t21'))!
    const torn = parseJournal(`${text}{"schema":"decl`)
    const lines = text.split('\n')
    lines[2] = lines[2]!.replace('"type":"', '"type":"x')
    const corrupt = parseJournal(lines.join('\n'))
    return { pass: torn.corrupt === null && torn.tornTail !== null && corrupt.corrupt !== null, observation: `torn tail tolerated: ${torn.corrupt === null}; corrupt complete record flagged at line ${corrupt.corrupt?.line}` }
  },
  async T22() {
    const fs = createSandbox()
    const store = new MemoryJournalStore()
    const { plan, approval } = await approved(fs, 't22', FEW)
    await applyPlan({ fs, store }, plan, approval)
    const snapshot = JSON.stringify([await store.readJournal('t22'), await store.readPlan('t22')])
    await listRuns(store)
    const unchanged = snapshot === JSON.stringify([await store.readJournal('t22'), await store.readPlan('t22')])
    const text = (await store.readJournal('t22'))!
    await store.replaceJournal('t22', text.replace('"seq":3', '"seq":9'))
    const blocked = newWorkBlockers(await listRuns(store)).length > 0
    const lost = new MemoryJournalStore()
    await lost.writePlan('p-lost', JSON.stringify(plan))
    const lostBlocks = newWorkBlockers(await listRuns(lost)).length > 0
    return { pass: unchanged && blocked && lostBlocks, observation: `index read-only: ${unchanged}; corrupt history blocks: ${blocked}; missing journal blocks: ${lostBlocks}` }
  },
  async T23() {
    const fs = createSandbox()
    const { plan } = await approved(fs, 't23', FEW)
    const tampered = parseMovePlan(JSON.stringify({ ...plan, rows: plan.rows.map((r, i) => (i === 0 ? { ...r, to: '_Organized/Other/x.pdf' } : r)) }))
    const { rows } = reconstructOrganizeRows(plan, await scanOf(fs), config)
    const pass = !tampered.ok && rows.every((r) => !r.included && r.provenance === 'imported')
    return { pass, observation: `tampered plan accepted: ${tampered.ok}; reconstructed rows start unselected: ${rows.every((r) => !r.included)}` }
  },
  async T28() {
    const fs = createSandbox()
    const store = new MemoryJournalStore()
    const a = await approved(fs, 't28-org', FEW)
    await applyPlan({ fs, store }, a.plan, a.approval)
    const scan = await scanRoot(fs, { scanId: 'dup', mode: 'duplicates' })
    const report = findDuplicates(scan, config)
    const extra = report.groups[0]!.members[1]!
    const qRows = validateRows(quarantineRows(report, new Set([extra.id]), 't28-q', config), { kind: 'quarantine', config, existing: new Map(), extOf: () => '' })
    const qPlan = buildPlan({ planId: 't28-q', kind: 'quarantine', scan, config, rows: qRows })
    await applyPlan({ fs, store }, qPlan, approve(qPlan, 'trap'))
    const reasons = undoBlockers(await listRuns(store), 't28-org')
    return { pass: reasons.some((r) => /quarantine/.test(r)), observation: reasons.join(' ') || 'no blocker' }
  },
  async T29() {
    const fs = createSandbox()
    const store = new MemoryJournalStore()
    const scan = await scanRoot(fs, { scanId: 'dup', mode: 'duplicates' })
    const report = findDuplicates(scan, config)
    const extra = report.groups[0]!.members[1]!
    const qRows = validateRows(quarantineRows(report, new Set([extra.id]), 't29-q', config), { kind: 'quarantine', config, existing: new Map(), extOf: () => '' })
    const qPlan = buildPlan({ planId: 't29-q', kind: 'quarantine', scan, config, rows: qRows })
    await applyPlan({ fs, store }, qPlan, approve(qPlan, 'trap'))
    fs.createForeign(extra.relPath, utf8Encode('new file at original path'))
    const rRow: PlanRow = { ...qRows[0]!, source: qPlan.rows[0]!.to, destination: extra.relPath, provenance: 'restore-review', included: true, proposalIssues: [], issues: [] }
    const checked = validateRows([rRow], { kind: 'restore', config, existing: await observeDestinations(fs, [rRow]), extOf: () => '' })
    const bothKept = fs.readFile(extra.relPath) !== null && fs.readFile(qPlan.rows[0]!.to) !== null
    return { pass: isBlocked(checked[0]!) && bothKept, observation: `restore row: ${checked[0]!.issues.map((i) => i.code).join(', ')}; both paths preserved: ${bothKept}` }
  },
  async T30() {
    const fs = createSandbox()
    const scan = await scanOf(fs)
    const failed = parseProposalText('{"proposals": [', new Set(scan.files.map((f) => f.id)))
    const rows = await validated(fs, scan, defaultSelection(await validated(fs, scan, buildOrganizeRows(scan, failed, 'local-ai', null, config))))
    return { pass: failed.fatal !== null && rows.every((r) => !r.included), observation: `fatal: ${failed.fatal}; rows selected: ${rows.filter((r) => r.included).length}` }
  },
  async T32() {
    const fs = createSandbox()
    const scan = await scanOf(fs)
    const parsed = parseProposalResponse(simulatedResponse(scan), new Set(scan.files.map((f) => f.id)))
    const rows = await validated(fs, scan, buildOrganizeRows(scan, parsed, 'simulated', 's', config))
    const codes = codesFor(rows, 'setup-tool.exe')
    return { pass: codes.includes('suffix-in-basename'), observation: `setup-tool.exe as invoice.pdf: ${codes.join(', ')}` }
  },
  async T33() {
    const fs = createSandbox()
    const scan = await scanOf(fs)
    const parsed = parseProposalResponse(simulatedResponse(scan), new Set(scan.files.map((f) => f.id)))
    const zip = scan.files.find((f) => f.relPath === 'archive-old.zip')!
    const mapped = parsed.accepted.some((a) => a.fileId === zip.id)
    return { pass: !mapped && parsed.rejected.some((r) => r.code === 'unknown-category'), observation: `off-list category rejected, not mapped: ${!mapped}` }
  },
  async T34() {
    const fs = createSandbox()
    const store = new MemoryJournalStore()
    const { plan, approval } = await approved(fs, 't34', FEW)
    await applyPlan({ fs, store }, plan, approval)
    // Also quarantine one duplicate so both reserved roots really hold files.
    const dscan = await scanRoot(fs, { scanId: 'dup', mode: 'duplicates' })
    const dup = findDuplicates(dscan, config)
    const extra = dup.groups[0]!.members[1]!
    const qRows = validateRows(quarantineRows(dup, new Set([extra.id]), 't34-q', config), { kind: 'quarantine', config, existing: new Map(), extOf: () => '' })
    const qPlan = buildPlan({ planId: 't34-q', kind: 'quarantine', scan: dscan, config, rows: qRows })
    await applyPlan({ fs, store }, qPlan, approve(qPlan, 'trap'))
    const paths = fs.allPaths().filter((p) => p.kind === 'file').map((p) => p.path)
    const populated = paths.some((p) => p.startsWith('_Organized/')) && paths.some((p) => p.startsWith('_declutter-quarantine/'))
    const again = await scanOf(fs)
    const leaked = again.files.filter((f) => f.relPath.startsWith('_Organized') || f.relPath.startsWith('_declutter-quarantine'))
    return { pass: populated && leaked.length === 0, observation: `both reserved roots populated: ${populated}; ${leaked.length} of their files in a later ordinary scan` }
  },
  async T35() {
    const fs = createSandbox()
    const scan = await scanOf(fs)
    const rows = await heuristicRows(fs, scan)
    const plan = buildPlan({ planId: 'p', kind: 'organize', scan, config, rows })
    const approval = approve(plan, 'trap')
    const deselect = buildPlan({ planId: 'p', kind: 'organize', scan, config, rows: rows.map((r, i) => (i === 0 ? { ...r, included: false } : r)) })
    const output = buildPlan({ planId: 'p', kind: 'organize', scan, config: { ...config, outputRoot: 'Sorted' }, rows })
    const pass = approvalIsCurrent(plan, approval) && !approvalIsCurrent(deselect, approval) && !approvalIsCurrent(output, approval)
    return { pass, observation: `approval survives selection edit: ${approvalIsCurrent(deselect, approval)}; output edit: ${approvalIsCurrent(output, approval)}` }
  },
  async T36() {
    // A: 500 moves (the file-row maximum) into 4 new folders each: 500 + 2001 operations exceed
    // the 2000-operation budget only because folders count, so apply must refuse up front.
    const a = await deepPlan('t36a', 500, ['a', 'b', 'c'])
    let refused = ''
    try {
      await applyPlan({ fs: a.fs, store: new MemoryJournalStore() }, a.plan, approve(a.plan, 'trap'))
    } catch (error) {
      refused = error instanceof Error ? error.message : String(error)
    }
    const untouched = manifest(a.fs) === a.before
    // B: 150 moves into 3 new folders each: 601 operations, above any fixed 500 ceiling.
    const b = await deepPlan('t36b', 150, ['a', 'b'])
    const store = new MemoryJournalStore()
    const applied = await applyPlan({ fs: b.fs, store }, b.plan, approve(b.plan, 'trap'))
    const records = parseJournal((await store.readJournal('t36b'))!).records
    const ops = records.filter((r) => r.type === 'intent' && r.phase === 'apply').length
    const undone = await reverseRun({ fs: b.fs, store }, 't36b', 'undo')
    const restored = manifest(b.fs) === b.before
    const pass = /2501 operations/.test(refused) && untouched && applied.status === 'committed' && ops === 601 && undone.status === 'undone' && restored
    return { pass, observation: `A refused: ${refused || 'no'}; B ${ops} operations ${applied.status}, undo ${undone.status}, manifest restored: ${restored}` }
  },
  async T37() {
    const fs = createSandbox()
    fs.mkdirp('_Organized/Images')
    const store = new MemoryJournalStore()
    const { plan, approval } = await approved(fs, 't37', FEW)
    await applyPlan({ fs, store }, plan, approval)
    fs.createForeign('_Organized/Audio/keep.txt', utf8Encode('foreign'))
    await reverseRun({ fs, store }, 't37', 'undo')
    const paths = fs.allPaths().map((p) => p.path)
    const pass = paths.includes('_Organized/Images') && paths.includes('_Organized/Audio/keep.txt') && !paths.includes('_Organized/Documents')
    return { pass, observation: `pre-existing folder kept: ${paths.includes('_Organized/Images')}; foreign content kept: ${paths.includes('_Organized/Audio/keep.txt')}` }
  },
  async T39() {
    const fs = createSandbox()
    const store = new MemoryJournalStore()
    const before = manifest(fs)
    const { plan, approval } = await approved(fs, 't39', FEW)
    try {
      await applyPlan({ fs, store, checkpoint: interruptAt(15).checkpoint }, plan, approval)
    } catch (e) {
      if (!(e instanceof InterruptError)) throw e
    }
    store.tearAppend('t39', '{"partial":')
    try {
      await reverseRun({ fs, store, checkpoint: interruptAt(2).checkpoint }, 't39', 'rollback')
    } catch (e) {
      if (!(e instanceof InterruptError)) throw e
    }
    const mid = parseJournal((await store.readJournal('t39'))!)
    const done = await reverseRun({ fs, store }, 't39', 'rollback')
    const pass = store.preserved.size === 1 && mid.corrupt === null && done.status === 'rolled_back' && manifest(fs) === before
    return { pass, observation: `preserved ${store.preserved.size} torn journal; continuation clean: ${mid.corrupt === null}; final ${done.status}` }
  },
}

export function sandboxCheckIds(): string[] {
  return Object.keys(CHECKS)
}

export async function runSandboxTraps(onProgress?: (done: number, total: number) => void): Promise<TrapResult[]> {
  const results: TrapResult[] = []
  let done = 0
  for (const trap of TRAPS) {
    const check = trap.profile === 'N' ? undefined : CHECKS[trap.id]
    if (!check) {
      results.push({ trap, sandbox: 'not-run', native: 'not-run', observation: trap.profile === 'N' ? 'Native-only case; needs the qualified native harness.' : 'No sandbox check registered.' })
    } else {
      try {
        const { pass, observation } = await check()
        results.push({ trap, sandbox: pass ? 'pass' : 'fail', native: 'not-run', observation })
      } catch (error) {
        results.push({ trap, sandbox: 'error', native: 'not-run', observation: error instanceof Error ? error.message : String(error) })
      }
    }
    onProgress?.(++done, TRAPS.length)
  }
  return results
}

export const RUNNER_PROFILE = `sandbox / MemoryFs adapter / in-page / digest ${sha256Text('trap-runner-v1').slice(0, 8)}`
