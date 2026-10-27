import { randomBytes } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { findDuplicates, quarantineRows, restoreCandidates, restoreRows } from '../src/core/duplicates.js'
import { ambiguousFileIds, heuristicProposals } from '../src/core/heuristic.js'
import { approve, buildPlan, computeDigest, parseMovePlan, reconstructOrganizeRows, PLAN_LIMITS, type MovePlan } from '../src/core/plan.js'
import { categoryById, type ParsedProposals } from '../src/core/proposal-schema.js'
import { applyPlan, listRuns, newWorkBlockers, previewReverse, reverseRun, undoBlockers, type ExecContext, type RunReport } from '../src/core/runs.js'
import { scanRoot } from '../src/core/scan.js'
import { DEFAULT_ROOT_CONFIG, POLICY_ID } from '../src/core/scan-policy.js'
import type { ScanManifest } from '../src/core/types.js'
import { buildOrganizeRows, defaultSelection, editOrganizeRow, isBlocked, hasWarning, observeDestinations, validateRows, type PlanRow } from '../src/core/validate.js'
import { disclosureFor, readLocalAiConfig, runLocalAi } from './local-ai.js'
import { acquireRootLock, type RootLock } from './lock.js'
import { NodeFs } from './node-fs.js'
import { isWithin, realLocation } from './within.js'
import { loadPlatformHelper, type PlatformHelper } from './platform/helper.js'
import { qualifyRoot, type Qualification } from './qualify.js'
import { FileJournalStore, ensurePrivateStateDirectory, registerRoot, rootsHintingPath, rootStateDir, stateInsideRoot } from './state.js'

// file-declutterer CLI. The only surface that may change real files. Read-only commands work
// on a qualified root; mutating commands (apply, recover, undo) additionally need platform
// qualification, the root mutex and LOCK, a fresh local reconstruction and the typed digest.

const VERSION = '0.1.0'
const EXIT = { ok: 0, refused: 1, usage: 2, attention: 3 } as const

const USAGE = `file-declutterer ${VERSION}

Usage:
  file-declutterer qualify  <root> [--unmanaged]
  file-declutterer scan     <root> [--unmanaged] [--json <file>]
  file-declutterer propose  <root> [--unmanaged] [--mode heuristic|smart|local]
                                   [--send-to-local-model] [--exclude <path>]... [--include <path>]...
                                   [--edit "<path>=<categoryId>/<basename>"]... [--out <plan.json>]
  file-declutterer validate <root> --plan <plan.json> [--unmanaged]
  file-declutterer apply    <root> --plan <plan.json> --confirm <digest> --unmanaged
  file-declutterer runs     <root> [--unmanaged]
  file-declutterer report   <root> --run <runId> [--unmanaged] [--json <file>]
  file-declutterer recover  <root> --run <runId> --unmanaged
  file-declutterer undo     <root> --run <runId> [--preview] [--yes] --unmanaged
  file-declutterer export   <root> --out <plan.json> [propose options]   (alias of propose --out)
  file-declutterer duplicates <root> [--unmanaged]
  file-declutterer quarantine <root> --select <path>... [--plan-id <id> --confirm <digest> --unmanaged]
  file-declutterer restore    <root> --run <quarantineRunId> --entry <quarantined path>...
                                     [--plan-id <id> --confirm <digest> --unmanaged]
  Without --confirm, quarantine and restore only print the reviewed plan, its id and digest.

Native writes stay disabled until the Windows platform helper is built and qualified.
Local AI needs DECLUTTER_MODEL_URL and DECLUTTER_MODEL_NAME (loopback only).`

class Usage extends Error {}

function out(line = ''): void {
  process.stdout.write(`${line}\n`)
}

function err(line: string): void {
  process.stderr.write(`${line}\n`)
}

interface Opened {
  q: Qualification
  helper: PlatformHelper
  stateDir: string
  store: FileJournalStore
  fs: NodeFs
  ambiguousHistory: string[]
  lock: RootLock | null
}

const commandResources: { helper: PlatformHelper; lock: RootLock | null }[] = []

async function openRoot(root: string, unmanaged: boolean, forWrite: boolean): Promise<Opened | null> {
  const helper = loadPlatformHelper()
  const resource = { helper, lock: null as RootLock | null }
  commandResources.push(resource)
  const q = await qualifyRoot(root, helper, { unmanaged })
  for (const reason of q.reasons) err(`refused: ${reason}`)
  for (const note of q.notes) err(`note: ${note}`)
  if (!q.readOk || !q.rootId) return null
  if (forWrite && !q.writeOk) {
    err('refused: native writes are not available for this root (see notes above).')
    return null
  }
  const stateDir = rootStateDir(q.rootId)
  if (stateInsideRoot(q.rootPath, stateDir)) {
    err('refused: the private state directory would be inside the selected root.')
    return null
  }
  const nativeHelper = helper.available ? helper : undefined
  if (nativeHelper) {
    await ensurePrivateStateDirectory(stateDir, nativeHelper)
    resource.lock = await acquireRootLock(stateDir, q.rootId, nativeHelper)
    await resource.lock.assert()
  }
  // Qualified commands hold one root boundary across discovery, registration, scan and apply.
  await registerRoot(q.rootId, q.rootPath, new Date().toISOString(), undefined, nativeHelper)
  const ambiguousHistory = await rootsHintingPath(q.rootPath, q.rootId, undefined, nativeHelper)
  if (ambiguousHistory.length > 0) {
    err(`warning: this path was previously registered under other root identities (${ambiguousHistory.join(', ')}). The folder may have been recreated or remounted; that history is not reassociated.`)
    if (forWrite) {
      err('refused: resolve the ambiguous root history before mutating (see README).')
      return null
    }
  }
  const store = new FileJournalStore(stateDir, nativeHelper)
  const fs = new NodeFs({ root: q.rootPath, rootId: q.rootId, writesEnabled: forWrite && q.writeOk, identityQualified: q.identityQualified, helper: nativeHelper })
  return { q, helper, stateDir, store, fs, ambiguousHistory, lock: resource.lock }
}

/** Output files (exports, reports) must never be written inside the selected root. */
async function outsideRoot(o: Opened, file: string): Promise<string> {
  // Resolve links/junctions on the existing part of the path; rootPath already equals its realpath.
  if (isWithin(await realLocation(file), o.q.rootPath)) throw new Usage(`Refusing to write ${file} inside the selected folder.`)
  return file
}

function newId(prefix: string): string {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  return `${prefix}-${stamp}-${randomBytes(3).toString('hex')}`
}

function printScan(scan: ScanManifest): void {
  out(`scan ${scan.scanId}: ${scan.status}${scan.abortReason ? ` (${scan.abortReason})` : ''}`)
  out(`  eligible ${scan.totals.eligibleFiles} files / ${scan.totals.eligibleBytes} bytes; skipped ${scan.totals.skipped}; blocked ${scan.totals.blocked}; zero-byte ${scan.totals.zeroByte}; project trees ${scan.totals.projectTrees}`)
  for (const s of scan.skipped) out(`  ${s.reason.padEnd(16)} ${s.relPath}${s.kind === 'dir' ? '/' : ''}`)
}

function printRows(rows: PlanRow[]): void {
  for (const row of rows) {
    const mark = row.noop ? 'skip ' : isBlocked(row) ? 'BLOCK' : row.included ? '  +  ' : hasWarning(row) ? 'warn ' : '  -  '
    out(`${mark} ${row.source}  ->  ${row.destination ?? '(none)'}   [${row.provenance}${row.confidence !== null ? ` ${row.confidence.toFixed(2)}` : ''}]`)
    for (const issue of row.issues) out(`        ${issue.severity}: ${issue.message}`)
  }
}

function printReport(report: RunReport): void {
  out(`run ${report.runId} (${report.kind}): ${report.status}${report.phase ? ` after ${report.phase}` : ''}`)
  if (report.haltReason) out(`  halted: ${report.haltReason}`)
  if (report.journalProblem) out(`  journal needs attention: ${report.journalProblem}`)
  const c = report.counts
  out(`  requested ${c.requested}, applied ${c.applied}, reversed ${c.reversed}, unresolved ${c.unresolved}, skipped ${c.skipped}`)
  for (const e of report.entries) out(`  #${e.opIndex} ${e.state.padEnd(10)} ${e.from ? `${e.from} -> ${e.to}` : `folder ${e.to}`}  ${e.detail}`)
}

async function scanFor(fs: NodeFs, scanId: string = newId('scan')): Promise<ScanManifest> {
  return scanRoot(fs, { scanId, mode: 'organize', config: DEFAULT_ROOT_CONFIG })
}

async function validated(fs: NodeFs, scan: ScanManifest, rows: PlanRow[]): Promise<PlanRow[]> {
  const extOf = (id: string): string => scan.files.find((f) => f.id === id)?.ext ?? ''
  return validateRows(rows, { kind: 'organize', config: DEFAULT_ROOT_CONFIG, existing: await observeDestinations(fs, rows), extOf })
}

/** Read at most the import byte cap, including when the input grows after opening. */
async function readPlanInput(file: string): Promise<string> {
  const handle = await fsp.open(file, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > PLAN_LIMITS.maxBytes) throw new Usage('Plan must be a regular file no larger than 4 MiB.')
    const buffer = Buffer.alloc(PLAN_LIMITS.maxBytes + 1)
    let total = 0
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null)
      if (bytesRead === 0) break
      total += bytesRead
    }
    if (total > PLAN_LIMITS.maxBytes) throw new Usage('Plan file is larger than 4 MiB.')
    return buffer.subarray(0, total).toString('utf8')
  } finally { await handle.close() }
}

/** Reconstruct an exported native plan against a fresh local scan; the plan's rows are the selection. */
async function reconstruct(o: Opened, planText: string): Promise<{ plan: MovePlan; rows: PlanRow[]; fresh: MovePlan } | null> {
  const parsed = parseMovePlan(planText)
  if (!parsed.ok) {
    err(`refused: ${parsed.error}`)
    return null
  }
  const plan = parsed.plan
  if (plan.profile !== 'native') {
    err('refused: sandbox plans cannot run on a native root.')
    return null
  }
  if (plan.rootId !== o.q.rootId) {
    err('refused: the plan belongs to a different root identity.')
    return null
  }
  if (plan.kind !== 'organize') {
    err('refused: only organize plans can be imported for apply in this version.')
    return null
  }
  // Deterministic scan id so the digest printed by validate equals the one apply recomputes.
  const scan = await scanFor(o.fs, `scan-${plan.planId}`)
  if (scan.status !== 'complete') {
    printScan(scan)
    return null
  }
  const { rows, unmatched } = reconstructOrganizeRows(plan, scan, DEFAULT_ROOT_CONFIG)
  for (const u of unmatched) err(`unmatched: ${u.from}: ${u.reason}`)
  const checked = await validated(o.fs, scan, rows.map((r) => ({ ...r, included: true })))
  const fresh = buildPlan({ planId: plan.planId, kind: 'organize', scan, config: DEFAULT_ROOT_CONFIG, rows: checked })
  if (unmatched.length > 0 || checked.some(isBlocked)) {
    printRows(checked)
    err('refused: the plan no longer matches this folder; propose again.')
    return null
  }
  return { plan, rows: checked, fresh }
}

async function withWrite(o: Opened, action: (ctx: ExecContext) => Promise<RunReport>): Promise<number> {
  const lock = o.lock ?? await acquireRootLock(o.stateDir, o.q.rootId!, o.helper)
  try {
    if (lock.retired) out(`retired abandoned LOCK of process ${lock.retired.pid} (${lock.retired.acquiredAt}); inspect unresolved runs below.`)
    const report = await action({ fs: o.fs, store: o.store, assertOwnership: lock.assert })
    printReport(report)
    return report.status === 'committed' || report.status === 'rolled_back' || report.status === 'undone' ? EXIT.ok : EXIT.attention
  } finally {
    if (!o.lock) await lock.release()
  }
}

async function run(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      unmanaged: { type: 'boolean', default: false },
      json: { type: 'string' },
      mode: { type: 'string', default: 'heuristic' },
      'send-to-local-model': { type: 'boolean', default: false },
      exclude: { type: 'string', multiple: true },
      include: { type: 'string', multiple: true },
      edit: { type: 'string', multiple: true },
      out: { type: 'string' },
      plan: { type: 'string' },
      confirm: { type: 'string' },
      run: { type: 'string' },
      select: { type: 'string', multiple: true },
      entry: { type: 'string', multiple: true },
      'plan-id': { type: 'string' },
      preview: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', default: false },
    },
  })
  if (values.version) {
    out(VERSION)
    return EXIT.ok
  }
  const [command, root] = positionals
  if (values.help || !command || command === 'help') {
    out(USAGE)
    return command || values.help ? EXIT.ok : EXIT.usage
  }
  if (!root) throw new Usage('A root folder is required.')
  const unmanaged = values.unmanaged ?? false

  switch (command) {
    case 'qualify': {
      const helper = loadPlatformHelper()
      commandResources.push({ helper, lock: null })
      const q = await qualifyRoot(root, helper, { unmanaged })
      out(`root ${q.rootPath}`)
      out(`  root id: ${q.rootId ?? '(none)'}; read-only: ${q.readOk ? 'yes' : 'no'}; native writes: ${q.writeOk ? 'yes' : 'no'}; identity qualified: ${q.identityQualified ? 'yes' : 'no'}`)
      for (const r of q.reasons) out(`  refused: ${r}`)
      for (const n of q.notes) out(`  note: ${n}`)
      return q.readOk ? EXIT.ok : EXIT.refused
    }
    case 'scan': {
      const o = await openRoot(root, unmanaged, false)
      if (!o) return EXIT.refused
      const scan = await scanFor(o.fs)
      printScan(scan)
      if (values.json) await fsp.writeFile(await outsideRoot(o, values.json), JSON.stringify(scan, null, 2), { encoding: 'utf8', flag: 'wx' })
      return scan.status === 'complete' ? EXIT.ok : EXIT.refused
    }
    case 'propose':
    case 'export': {
      if (command === 'export' && !values.out) throw new Usage('export needs --out <plan.json>.')
      const o = await openRoot(root, unmanaged, false)
      if (!o) return EXIT.refused
      const scan = await scanFor(o.fs)
      if (scan.status !== 'complete') {
        printScan(scan)
        return EXIT.refused
      }
      const mode = values.mode
      if (mode !== 'heuristic' && mode !== 'smart' && mode !== 'local') throw new Usage('--mode must be heuristic, smart or local.')
      const heuristic: ParsedProposals = { accepted: heuristicProposals(scan), rejected: [], fatal: null }
      let rows = buildOrganizeRows(scan, heuristic, 'heuristic', newId('heur'), DEFAULT_ROOT_CONFIG)
      if (mode !== 'heuristic') {
        const config = readLocalAiConfig()
        if (!config.ok) {
          err(`${config.reason}. Showing heuristic proposals instead (rerun with --mode heuristic to silence this).`)
        } else {
          const targetIds = new Set(mode === 'smart' ? ambiguousFileIds(scan) : scan.files.map((f) => f.id))
          const items = disclosureFor(scan.files.filter((f) => targetIds.has(f.id)))
          out(`Local model disclosure (${config.config.endpoint.href}, model ${config.config.model}): exactly these ${items.length} item(s), no bytes, no absolute paths:`)
          for (const item of items) out(`  ${item.fileId}  basename=${JSON.stringify(item.basename)} ext=${JSON.stringify(item.extension)} folder=${JSON.stringify(item.folder)}`)
          if (!values['send-to-local-model']) {
            err('Not sent. Add --send-to-local-model to send exactly the items above.')
          } else if (items.length > 0) {
            const batchId = newId('ai')
            const result = await runLocalAi(config.config, items)
            for (const b of result.batches) out(`  batch ${b.index}: ${b.status} (${b.rows} rows) ${b.detail}`)
            if (result.partial) err('Local AI pass is partial: rows from failed or unattempted batches have no AI proposal.')
            const aiRows = buildOrganizeRows(scan, result.parsed, 'local-ai', batchId, DEFAULT_ROOT_CONFIG)
            rows = rows.map((row) => (targetIds.has(row.fileId) ? aiRows.find((a) => a.fileId === row.fileId)! : row))
          }
        }
      }
      for (const spec of values.edit ?? []) {
        const match = /^(.+)=([a-z]+)\/(.+)$/.exec(spec)
        if (!match) throw new Usage(`--edit expects "<path>=<categoryId>/<basename>", got ${spec}`)
        const [, path, categoryId, basename] = match
        const file = scan.files.find((f) => f.relPath === path)
        if (!file || !categoryById(categoryId!)) throw new Usage(`--edit: unknown path or category in ${spec}`)
        rows = rows.map((r) => (r.fileId === file.id ? editOrganizeRow(r, file, categoryId!, basename!, DEFAULT_ROOT_CONFIG) : r))
      }
      rows = await validated(o.fs, scan, rows)
      rows = defaultSelection(rows)
      const include = new Set(values.include ?? [])
      const exclude = new Set(values.exclude ?? [])
      rows = rows.map((r) => (exclude.has(r.source) ? { ...r, included: false } : include.has(r.source) ? { ...r, included: !isBlocked(r) && !r.noop } : r))
      rows = await validated(o.fs, scan, rows)
      printRows(rows)
      const plan = buildPlan({ planId: newId('plan'), kind: 'organize', scan, config: DEFAULT_ROOT_CONFIG, rows })
      out(`accepted ${plan.rows.length} move(s); digest ${plan.digest}`)
      if (values.out) {
        await fsp.writeFile(await outsideRoot(o, values.out), JSON.stringify(plan, null, 2), { encoding: 'utf8', flag: 'wx' })
        out(`plan written to ${values.out} (not approved; apply revalidates and asks for the fresh digest)`)
      }
      return EXIT.ok
    }
    case 'validate': {
      if (!values.plan) throw new Usage('validate needs --plan <plan.json>.')
      const o = await openRoot(root, unmanaged, false)
      if (!o) return EXIT.refused
      const r = await reconstruct(o, await readPlanInput(values.plan))
      if (!r) return EXIT.refused
      printRows(r.rows)
      out(`fresh digest ${r.fresh.digest}`)
      out('This digest is recomputed from the current folder (imported rows, fresh scan); it intentionally differs from the exported file. Review the rows above, then confirm it.')
      out(`to apply: file-declutterer apply "${root}" --plan "${values.plan}" --confirm ${r.fresh.digest} --unmanaged`)
      return EXIT.ok
    }
    case 'apply': {
      if (!values.plan || !values.confirm) throw new Usage('apply needs --plan <plan.json> and --confirm <digest>.')
      const o = await openRoot(root, unmanaged, true)
      if (!o) return EXIT.refused
      const planText = await readPlanInput(values.plan)
      return withWrite(o, async (ctx) => {
        const r = await reconstruct(o, planText)
        if (!r) throw new Error('Plan reconstruction failed.')
        if (values.confirm !== r.fresh.digest || computeDigest(r.fresh) !== r.fresh.digest) throw new Error(`Typed digest does not match the fresh digest ${r.fresh.digest}.`)
        const blockers = newWorkBlockers(await listRuns(o.store, o.fs))
        return applyPlan(ctx, r.fresh, approve(r.fresh, new Date().toISOString()), blockers)
      })
    }
    case 'runs': {
      const o = await openRoot(root, unmanaged, false)
      if (!o) return EXIT.refused
      const runs = await listRuns(o.store, o.fs)
      if (runs.length === 0) out('no runs')
      for (const r of runs) out(`${r.runId}  ${r.kind.padEnd(10)} ${r.status}${r.phase ? ` (${r.phase})` : ''}  rows=${r.rows}${r.problem ? `  problem: ${r.problem}` : ''}${r.torn ? '  torn-tail' : ''}`)
      for (const b of newWorkBlockers(runs)) out(`blocked: ${b}`)
      return EXIT.ok
    }
    case 'report': {
      if (!values.run) throw new Usage('report needs --run <runId>.')
      const o = await openRoot(root, unmanaged, false)
      if (!o) return EXIT.refused
      const runs = await listRuns(o.store, o.fs)
      const summary = runs.find((r) => r.runId === values.run)
      if (!summary) {
        err(`unknown run ${values.run}`)
        return EXIT.refused
      }
      const preview = summary.problem ? [] : await previewReverse({ fs: o.fs, store: o.store }, values.run)
      const report = { profile: 'native', platform: process.platform, version: VERSION, rootId: o.q.rootId, run: summary, currentState: preview }
      out(JSON.stringify(report, null, 2))
      if (values.json) await fsp.writeFile(await outsideRoot(o, values.json), JSON.stringify(report, null, 2), { encoding: 'utf8', flag: 'wx' })
      return EXIT.ok
    }
    case 'recover': {
      if (!values.run) throw new Usage('recover needs --run <runId>.')
      const o = await openRoot(root, unmanaged, true)
      if (!o) return EXIT.refused
      return withWrite(o, (ctx) => reverseRun(ctx, values.run!, 'rollback'))
    }
    case 'undo': {
      if (!values.run) throw new Usage('undo needs --run <runId>.')
      const o = await openRoot(root, unmanaged, !values.preview)
      if (!o) return EXIT.refused
      const runs = await listRuns(o.store, o.fs)
      const blockers = undoBlockers(runs, values.run)
      for (const b of blockers) err(`blocked: ${b}`)
      const preview = await previewReverse({ fs: o.fs, store: o.store }, values.run)
      for (const p of preview) out(`  ${p.action.padEnd(17)} ${p.from} <- ${p.to}  ${p.detail}`)
      if (values.preview) return blockers.length ? EXIT.refused : EXIT.ok
      if (blockers.length) return EXIT.refused
      if (!values.yes) {
        err('Not undone. Review the preview above and rerun with --yes to confirm.')
        return EXIT.refused
      }
      return withWrite(o, async (ctx) => reverseRun(ctx, values.run!, 'undo', undoBlockers(await listRuns(o.store, o.fs), values.run!)))
    }
    case 'duplicates': {
      const o = await openRoot(root, unmanaged, false)
      if (!o) return EXIT.refused
      const scan = await scanRoot(o.fs, { scanId: newId('dscan'), mode: 'duplicates', config: DEFAULT_ROOT_CONFIG })
      if (scan.status !== 'complete') {
        printScan(scan)
        return EXIT.refused
      }
      const report = findDuplicates(scan, DEFAULT_ROOT_CONFIG)
      out(`${report.groups.length} group(s); empty ${report.zeroByte.length}; unhashable ${report.unhashable.length}; unverified ${report.unverified.length}`)
      for (const g of report.groups) {
        out(`group ${g.sha256.slice(0, 16)}… (${g.size} bytes)`)
        for (const m of g.members) out(`  ${m.id === g.keeperSuggestion ? 'keeper?' : '       '} ${m.relPath}`)
      }
      out('Nothing is selected. Choose extras with: quarantine <root> --select <path> ...')
      return EXIT.ok
    }
    case 'quarantine': {
      const selected = new Set(values.select ?? [])
      if (selected.size === 0) throw new Usage('quarantine needs at least one --select <path>.')
      const writing = values.confirm !== undefined
      if (writing && !values['plan-id']) throw new Usage('--confirm needs the --plan-id printed by the review run.')
      const o = await openRoot(root, unmanaged, writing)
      if (!o) return EXIT.refused
      const planId = values['plan-id'] ?? newId('quar')
      const build = async (): Promise<MovePlan | null> => {
        const scan = await scanRoot(o.fs, { scanId: `dscan-${planId}`, mode: 'duplicates', config: DEFAULT_ROOT_CONFIG })
        if (scan.status !== 'complete') {
          printScan(scan)
          return null
        }
        const report = findDuplicates(scan, DEFAULT_ROOT_CONFIG)
        const ids = new Set(report.groups.flatMap((g) => g.members.filter((m) => selected.has(m.relPath)).map((m) => m.id)))
        if (ids.size !== selected.size) {
          err('refused: every --select path must be a member of a current duplicate group.')
          return null
        }
        const rows = quarantineRows(report, ids, planId, DEFAULT_ROOT_CONFIG)
        const checked = validateRows(rows, { kind: 'quarantine', config: DEFAULT_ROOT_CONFIG, existing: await observeDestinations(o.fs, rows), extOf: () => '' })
        printRows(checked)
        if (checked.some(isBlocked)) {
          err('refused: blocked rows above.')
          return null
        }
        return buildPlan({ planId, kind: 'quarantine', scan, config: DEFAULT_ROOT_CONFIG, rows: checked })
      }
      if (!writing) {
        const plan = await build()
        if (!plan) return EXIT.refused
        out(`plan id ${plan.planId}; digest ${plan.digest}`)
        out(`to apply: add --plan-id ${plan.planId} --confirm ${plan.digest} --unmanaged`)
        return EXIT.ok
      }
      return withWrite(o, async (ctx) => {
        const plan = await build()
        if (!plan) throw new Error('Quarantine plan could not be rebuilt.')
        if (plan.digest !== values.confirm) throw new Error(`Typed digest does not match the fresh digest ${plan.digest}.`)
        return applyPlan(ctx, plan, approve(plan, new Date().toISOString()), newWorkBlockers(await listRuns(o.store, o.fs)))
      })
    }
    case 'restore': {
      if (!values.run) throw new Usage('restore needs --run <quarantineRunId>.')
      const writing = values.confirm !== undefined
      if (writing && !values['plan-id']) throw new Usage('--confirm needs the --plan-id printed by the review run.')
      const o = await openRoot(root, unmanaged, writing)
      if (!o) return EXIT.refused
      const runId = values.run
      const planId = values['plan-id'] ?? newId('rest')
      const build = async (): Promise<MovePlan | null> => {
        const runs = await listRuns(o.store, o.fs)
        const source = runs.find((r) => r.runId === runId)
        const planText = await o.store.readPlan(runId)
        if (!source || source.kind !== 'quarantine' || source.status !== 'committed' || !planText) {
          err('refused: --run must name a committed quarantine run.')
          return null
        }
        const parsed = parseMovePlan(planText)
        if (!parsed.ok) {
          err(`refused: ${parsed.error}`)
          return null
        }
        const candidates = restoreCandidates(parsed.plan, source.movedTo)
        for (const c of candidates) out(`  available: ${c.quarantined} -> ${c.original}`)
        const chosen = new Set(values.entry ?? [])
        if (chosen.size === 0) {
          err('Choose entries with --entry <quarantined path> (repeatable).')
          return null
        }
        const rows = await restoreRows(o.fs, candidates, chosen)
        const checked = validateRows(rows, { kind: 'restore', config: DEFAULT_ROOT_CONFIG, existing: await observeDestinations(o.fs, rows), extOf: () => '' })
        printRows(checked)
        if (checked.length !== chosen.size || checked.some(isBlocked)) {
          err('refused: unknown or blocked entries above; both paths are preserved.')
          return null
        }
        const scanLike = { scanId: `restore-${planId}`, profile: 'native' as const, policyId: POLICY_ID, root: { id: o.q.rootId!, displayHint: o.q.rootPath } }
        return buildPlan({ planId, kind: 'restore', scan: scanLike, config: DEFAULT_ROOT_CONFIG, rows: checked, restoreOf: runId })
      }
      if (!writing) {
        const plan = await build()
        if (!plan) return EXIT.refused
        out(`plan id ${plan.planId}; digest ${plan.digest}`)
        out(`to apply: add --plan-id ${plan.planId} --confirm ${plan.digest} --unmanaged`)
        return EXIT.ok
      }
      return withWrite(o, async (ctx) => {
        const plan = await build()
        if (!plan) throw new Error('Restore plan could not be rebuilt.')
        if (plan.digest !== values.confirm) throw new Error(`Typed digest does not match the fresh digest ${plan.digest}.`)
        return applyPlan(ctx, plan, approve(plan, new Date().toISOString()), newWorkBlockers(await listRuns(o.store, o.fs)))
      })
    }
    default:
      throw new Usage(`Unknown command ${command}.`)
  }
}

async function closeCommandResources(): Promise<void> {
  for (const resource of commandResources.reverse()) {
    try { await resource.lock?.release() } finally {
      await (resource.helper as PlatformHelper & { close?: () => Promise<void> }).close?.()
    }
  }
}

run(process.argv.slice(2)).finally(closeCommandResources).then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    if (error instanceof Usage) {
      err(error.message)
      err(USAGE)
      process.exitCode = EXIT.usage
    } else {
      err(`error: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = EXIT.refused
    }
  },
)
