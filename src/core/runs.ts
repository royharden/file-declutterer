import { ancestorsOf, baseOf, noCheckpoint, parentOf, type Checkpoint, type FsPort, type JournalStore, type StatInfo } from './fs-port.js'
import { currentStatus, JournalWriter, parseJournal, type Expected, type JournalPhase, type JournalRecord, type RunIdentity } from './journal-codec.js'
import { compareKey } from './paths.js'
import { approvalIsCurrent, computeDigest, parseMovePlan, PLAN_LIMITS, type Approval, type MovePlan } from './plan.js'
import type { PlanKind, RunStatus } from './types.js'

// Apply, rollback and undo executors (PLAN §8), shared by the sandbox and the native CLI.
//
// Apply: per move, flushed intent -> exclusive link(src, dst) -> verify identity and bytes ->
// guarded unlink(src) -> flushed outcome. No overwrite, rename or copy fallback. A failed
// precondition halts the remaining operations; a failed unlink halts as linked-only.
//
// Reversal decides every action from freshly observed state, never from log labels:
//   source only, expected          -> nothing to do (not started or already reversed)
//   both names, same identity      -> remove the verified extra destination link
//   destination only, original free-> link back, verify, unlink destination
//   missing / changed / foreign    -> preserve all paths; needs_attention
// Directories are removed only when this run proved it created them, they keep that identity
// and are empty.

export interface ExecContext {
  fs: FsPort
  store: JournalStore
  /** Interruption injection point (sandbox/tests); a no-op natively. */
  checkpoint?: Checkpoint
  /** Native ownership assertion before every mutation; throws if the root lock/guard is lost. */
  assertOwnership?: () => Promise<void>
}

export type CompiledOp =
  | { index: number; op: 'mkdir'; path: string }
  | { index: number; op: 'move'; from: string; to: string; expected: Expected }

export type EntryState = 'applied' | 'reversed' | 'unchanged' | 'unresolved' | 'skipped' | 'retained'

export interface RunEntry {
  opIndex: number
  op: 'mkdir' | 'move'
  from: string | null
  to: string
  state: EntryState
  detail: string
}

export interface RunReport {
  runId: string
  kind: PlanKind
  status: RunStatus
  phase: JournalPhase | null
  haltReason: string | null
  counts: { requested: number; applied: number; reversed: number; unresolved: number; skipped: number }
  entries: RunEntry[]
  journalProblem: string | null
}

export class RunRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RunRefused'
  }
}

class Halt extends Error {}

function identityOf(plan: MovePlan): RunIdentity {
  return { runId: plan.planId, rootId: plan.rootId, planId: plan.planId, planDigest: plan.digest }
}

async function matches(fs: FsPort, path: string, info: StatInfo | null, expected: Expected): Promise<boolean> {
  if (!info || info.kind !== 'file') return false
  if (expected.size !== null && info.size !== expected.size) return false
  if (!Number.isSafeInteger(expected.mtimeMs) || info.mtimeMs !== expected.mtimeMs) return false
  if (expected.identity !== null && info.identity !== expected.identity) return false
  if (expected.sha256 === null) return false
  try {
    return (await fs.sha256(path)) === expected.sha256
  } catch {
    return false
  }
}

/** True when both paths currently name one file with a known identity. */
async function sameIdentity(fs: FsPort, a: string, b: string): Promise<boolean> {
  const x = await fs.stat(a)
  const y = await fs.stat(b)
  return x !== null && y !== null && x.kind === 'file' && y.kind === 'file' && x.identity !== null && x.identity === y.identity
}

/** Compile mkdir + move operations; directories that already exist are observed, not claimed. */
export async function compileOps(fs: FsPort, plan: MovePlan): Promise<CompiledOp[]> {
  const ops: CompiledOp[] = []
  const planned = new Set<string>()
  for (const row of plan.rows) {
    for (const dir of ancestorsOf(row.to)) {
      const key = compareKey(dir)
      if (planned.has(key)) continue
      planned.add(key)
      const info = await fs.stat(dir)
      if (info && info.kind === 'dir') continue
      if (info) throw new RunRefused(`A parent of ${row.to} exists and is not a folder: ${info.kind} at ${dir}.`)
      ops.push({ index: ops.length, op: 'mkdir', path: dir })
    }
    ops.push({ index: ops.length, op: 'move', from: row.from, to: row.to, expected: { sha256: row.sha256, identity: row.identity, size: row.size, mtimeMs: row.mtimeMs } })
  }
  if (ops.length > PLAN_LIMITS.maxOperationRows) {
    throw new RunRefused(`Plan needs ${ops.length} operations including folders; the limit is ${PLAN_LIMITS.maxOperationRows}.`)
  }
  return ops
}

/** Ops as recorded in the journal (intents of the apply phase), for reversal. */
function appliedOps(records: JournalRecord[]): Map<number, { intent: JournalRecord; outcome: JournalRecord | null }> {
  const out = new Map<number, { intent: JournalRecord; outcome: JournalRecord | null }>()
  for (const rec of records) {
    if (rec.phase !== 'apply' || rec.opIndex === null) continue
    if (rec.type === 'intent') out.set(rec.opIndex, { intent: rec, outcome: null })
    else if (rec.type === 'outcome') {
      const entry = out.get(rec.opIndex)
      if (entry) entry.outcome = rec
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Apply

export async function applyPlan(ctx: ExecContext, plan: MovePlan, approval: Approval | null, blockers: string[] = []): Promise<RunReport> {
  if (!approvalIsCurrent(plan, approval)) throw new RunRefused('The plan is not approved, or it changed after approval.')
  // Callers may pass blockers, but the core also derives them so no caller can skip them.
  const allBlockers = [...new Set([...blockers, ...newWorkBlockers(await listRuns(ctx.store))])]
  if (allBlockers.length > 0) throw new RunRefused(allBlockers.join(' '))
  if (plan.rows.length === 0) throw new RunRefused('The plan has no accepted rows.')
  if (plan.profile !== ctx.fs.profile) throw new RunRefused(`A ${plan.profile} plan cannot run on a ${ctx.fs.profile} root.`)
  if (plan.rootId !== ctx.fs.rootId) throw new RunRefused('The plan belongs to a different root.')
  const checkpoint = ctx.checkpoint ?? noCheckpoint
  const assert = ctx.assertOwnership ?? (async () => {})

  const ops = await compileOps(ctx.fs, plan)
  await assert()
  await ctx.store.writePlan(plan.planId, JSON.stringify(plan))
  const journal = await JournalWriter.create(ctx.store, identityOf(plan))
  await journal.append({ type: 'begin', phase: 'apply', detail: `${plan.kind} plan with ${plan.rows.length} row(s), ${ops.length} operation(s).` })
  checkpoint('after-begin')

  const entries: RunEntry[] = []
  let haltReason: string | null = null
  const halt = { linkedOnly: false }

  try {
    for (const op of ops) {
      await assert()
      if (op.op === 'mkdir') {
        const info = await ctx.fs.stat(op.path)
        if (info && info.kind === 'dir') {
          await journal.append({ type: 'observe', phase: 'apply', opIndex: op.index, op: 'mkdir', to: op.path, result: 'existing', observedIdentity: info.identity, detail: 'Folder already exists; observed, not claimed.' })
          entries.push({ opIndex: op.index, op: 'mkdir', from: null, to: op.path, state: 'skipped', detail: 'Existing folder observed.' })
          continue
        }
        if (info) throw new Halt(`${op.path} appeared as a ${info.kind}; expected a missing folder.`)
        const parent = parentOf(op.path)
        if (parent !== '' && (await ctx.fs.stat(parent))?.kind !== 'dir') throw new Halt(`Parent folder of ${op.path} is missing.`)
        checkpoint(`apply:${op.index}:before-intent`)
        await journal.append({ type: 'intent', phase: 'apply', opIndex: op.index, op: 'mkdir', to: op.path })
        checkpoint(`apply:${op.index}:after-intent`)
        try {
          await ctx.fs.mkdir(op.path)
        } catch (error) {
          await journal.append({ type: 'outcome', phase: 'apply', opIndex: op.index, op: 'mkdir', to: op.path, result: 'failed', detail: message(error) })
          throw new Halt(`Could not create ${op.path}: ${message(error)}`)
        }
        checkpoint(`apply:${op.index}:after-mutation`)
        const created = await ctx.fs.stat(op.path)
        await journal.append({ type: 'outcome', phase: 'apply', opIndex: op.index, op: 'mkdir', to: op.path, result: 'ok', observedIdentity: created?.identity ?? null })
        checkpoint(`apply:${op.index}:after-outcome`)
        entries.push({ opIndex: op.index, op: 'mkdir', from: null, to: op.path, state: 'applied', detail: 'Folder created.' })
        continue
      }

      // Move preconditions: exact approved bytes at the source, vacant destination, folder parent.
      const src = await ctx.fs.stat(op.from)
      if (!src) throw new Halt(`Source ${op.from} is missing.`)
      if (!(await matches(ctx.fs, op.from, src, op.expected))) throw new Halt(`Source ${op.from} changed since approval.`)
      if (await ctx.fs.stat(op.to)) throw new Halt(`Destination ${op.to} is now occupied.`)
      if ((await ctx.fs.stat(parentOf(op.to)))?.kind !== 'dir') throw new Halt(`Destination folder for ${op.to} is missing.`)

      checkpoint(`apply:${op.index}:before-intent`)
      await journal.append({ type: 'intent', phase: 'apply', opIndex: op.index, op: 'move', from: op.from, to: op.to, expected: op.expected })
      checkpoint(`apply:${op.index}:after-intent`)
      try {
        await ctx.fs.link(op.from, op.to)
      } catch (error) {
        await journal.append({ type: 'outcome', phase: 'apply', opIndex: op.index, op: 'move', from: op.from, to: op.to, result: 'failed', detail: `link: ${message(error)}` })
        throw new Halt(`Could not link ${op.to}: ${message(error)}. The source is untouched.`)
      }
      checkpoint(`apply:${op.index}:after-link`)
      const linked = await ctx.fs.stat(op.to)
      const srcNow = await ctx.fs.stat(op.from)
      const sameFile = linked !== null && srcNow !== null && linked.identity !== null && linked.identity === srcNow.identity
      if (!sameFile || !(await matches(ctx.fs, op.to, linked, op.expected))) {
        throw new Halt(`Verification of ${op.to} failed after linking. Recovery is required.`)
      }
      await assert()
      if (!(await matches(ctx.fs, op.from, await ctx.fs.stat(op.from), op.expected))) {
        throw new Halt(`Source ${op.from} changed before unlink. Recovery is required.`)
      }
      // Last check before removing a name: both names must still be the same file.
      if (!(await sameIdentity(ctx.fs, op.from, op.to))) {
        throw new Halt(`Destination ${op.to} no longer names the same file; the source is kept. Recovery is required.`)
      }
      try {
        await ctx.fs.unlink(op.from)
      } catch (error) {
        await journal.append({ type: 'outcome', phase: 'apply', opIndex: op.index, op: 'move', from: op.from, to: op.to, result: 'linked-only', observedIdentity: linked.identity, detail: `unlink: ${message(error)}` })
        halt.linkedOnly = true
        throw new Halt(`Could not remove the original name ${op.from}: ${message(error)}. Both names refer to one file; no retry was attempted.`)
      }
      checkpoint(`apply:${op.index}:after-mutation`)
      await journal.append({ type: 'outcome', phase: 'apply', opIndex: op.index, op: 'move', from: op.from, to: op.to, result: 'ok', observedIdentity: linked.identity })
      checkpoint(`apply:${op.index}:after-outcome`)
      entries.push({ opIndex: op.index, op: 'move', from: op.from, to: op.to, state: 'applied', detail: 'Moved and verified.' })
    }
    await journal.append({ type: 'status', phase: 'apply', status: 'committed', detail: 'All operations resolved.' })
  } catch (error) {
    if (!(error instanceof Halt)) throw error
    haltReason = error.message
    await journal.append({ type: 'halt', phase: 'apply', detail: haltReason })
    if (halt.linkedOnly) {
      await journal.append({ type: 'status', phase: 'apply', status: 'needs_attention', detail: haltReason })
    }
  }
  return summarize(plan, journal.records, entries, haltReason, null)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---------------------------------------------------------------------------------------------
// Reversal (rollback of an interrupted/halted apply, or undo of a committed run)

export interface ReversePreviewEntry {
  opIndex: number
  from: string
  to: string
  action: 'nothing' | 'remove-extra-link' | 'move-back' | 'refuse'
  detail: string
}

async function classifyMove(fs: FsPort, intent: JournalRecord): Promise<ReversePreviewEntry> {
  const from = intent.from!
  const to = intent.to!
  const expected = intent.expected!
  const src = await fs.stat(from)
  const dst = await fs.stat(to)
  const srcOk = await matches(fs, from, src, expected)
  const dstOk = await matches(fs, to, dst, expected)
  const base = { opIndex: intent.opIndex!, from, to }
  if (srcOk && !dst) return { ...base, action: 'nothing', detail: 'Original is in place; nothing to reverse.' }
  if (srcOk && dstOk && src!.identity !== null && src!.identity === dst!.identity) {
    return { ...base, action: 'remove-extra-link', detail: 'Both names refer to the verified file; remove the destination name.' }
  }
  if (srcOk && dst) return { ...base, action: 'nothing', detail: 'Original is in place; a different file at the destination is not ours and is preserved.' }
  if (!src && dstOk) return { ...base, action: 'move-back', detail: 'Move the verified file back to its original path.' }
  if (src && dstOk) return { ...base, action: 'refuse', detail: 'The original path is occupied by another file; both are preserved.' }
  if (!src && dst) return { ...base, action: 'refuse', detail: 'The file at the destination changed; it is preserved.' }
  if (src && !srcOk) return { ...base, action: 'refuse', detail: 'The original path holds different bytes; it is preserved.' }
  return { ...base, action: 'refuse', detail: 'The file is missing from both paths.' }
}

async function loadRun(store: JournalStore, runId: string): Promise<{ plan: MovePlan; records: JournalRecord[]; problem: string | null; torn: boolean }> {
  const planText = await store.readPlan(runId)
  if (planText === null) throw new RunRefused(`Run ${runId} has no stored plan.`)
  const parsedPlan = parseMovePlan(planText)
  if (!parsedPlan.ok) throw new RunRefused(`Stored plan for ${runId} is unreadable: ${parsedPlan.error}`)
  const journalText = await store.readJournal(runId)
  if (journalText === null || journalText === '') return { plan: parsedPlan.plan, records: [], problem: 'Journal is missing or empty; recovery evidence is unavailable.', torn: false }
  const parsed = parseJournal(journalText, { runId })
  const first = parsed.records[0]
  const problem = parsed.corrupt ? `Journal line ${parsed.corrupt.line}: ${parsed.corrupt.reason}.` : !first ? 'Journal has no verified records; recovery evidence is unavailable.' : first.rootId !== parsedPlan.plan.rootId || first.planId !== parsedPlan.plan.planId || first.planDigest !== parsedPlan.plan.digest ? 'Journal belongs to a different root or plan.' : null
  return { plan: parsedPlan.plan, records: parsed.records, problem, torn: parsed.tornTail !== null }
}

/** Read-only preview of what a reversal would do now. */
export async function previewReverse(ctx: ExecContext, runId: string): Promise<ReversePreviewEntry[]> {
  const { records, problem } = await loadRun(ctx.store, runId)
  if (problem) throw new RunRefused(`Journal needs attention: ${problem}`)
  const ops = appliedOps(records)
  const out: ReversePreviewEntry[] = []
  for (const index of [...ops.keys()].sort((a, b) => b - a)) {
    const { intent } = ops.get(index)!
    if (intent.op === 'move') out.push(await classifyMove(ctx.fs, intent))
  }
  return out
}

export async function reverseRun(ctx: ExecContext, runId: string, mode: 'rollback' | 'undo', blockers: string[] = []): Promise<RunReport> {
  const { plan, records, problem } = await loadRun(ctx.store, runId)
  if (problem) {
    return { ...summarize(plan, records, [], null, problem), status: 'needs_attention' }
  }
  const state = currentStatus(records)
  if (mode === 'rollback' && !(state.status === 'open' || (state.status === 'needs_attention' && state.phase !== 'undo'))) {
    throw new RunRefused(`Run ${runId} is ${state.status}; only an open or interrupted run can be rolled back.`)
  }
  if (mode === 'undo' && !(state.status === 'committed' || (state.status === 'needs_attention' && state.phase === 'undo'))) {
    throw new RunRefused(`Run ${runId} is ${state.status}; only a committed run can be undone.`)
  }
  const derived = mode === 'undo' ? undoBlockers(await listRuns(ctx.store), runId) : []
  const allBlockers = [...new Set([...blockers, ...derived])]
  if (allBlockers.length > 0) throw new RunRefused(allBlockers.join(' '))
  if (computeDigest(plan) !== plan.digest) throw new RunRefused('Stored plan digest does not match its contents.')

  const checkpoint = ctx.checkpoint ?? noCheckpoint
  const assert = ctx.assertOwnership ?? (async () => {})
  await assert()
  const { writer, parsed } = await JournalWriter.open(ctx.store, identityOf(plan))
  if (!writer) {
    return { ...summarize(plan, parsed.records, [], null, parsed.corrupt ? `Journal line ${parsed.corrupt.line}: ${parsed.corrupt.reason}.` : 'Journal could not be opened.'), status: 'needs_attention' }
  }
  const journal = writer
  const phase: JournalPhase = mode
  await journal.append({ type: 'begin', phase, detail: `${mode} started.` })

  const ops = appliedOps(journal.records)
  const order = [...ops.keys()].sort((a, b) => b - a)
  const entries: RunEntry[] = []
  let unresolved = 0

  for (const index of order) {
    const { intent, outcome } = ops.get(index)!
    await assert()
    if (intent.op === 'move') {
      const decision = await classifyMove(ctx.fs, intent)
      const from = intent.from!
      const to = intent.to!
      if (decision.action === 'nothing') {
        entries.push({ opIndex: index, op: 'move', from, to, state: 'unchanged', detail: decision.detail })
        continue
      }
      if (decision.action === 'refuse') {
        await journal.append({ type: 'observe', phase, opIndex: index, op: 'move', from: to, to: from, result: 'refused', detail: decision.detail })
        entries.push({ opIndex: index, op: 'move', from, to, state: 'unresolved', detail: decision.detail })
        unresolved++
        continue
      }
      if (decision.action === 'remove-extra-link') {
        checkpoint(`${mode}:${index}:before-intent`)
        await journal.append({ type: 'intent', phase, opIndex: index, op: 'unlink-extra', from: to, to: from, expected: intent.expected })
        checkpoint(`${mode}:${index}:after-intent`)
        await assert()
        const again = await classifyMove(ctx.fs, intent)
        if (again.action !== 'remove-extra-link') {
          await journal.append({ type: 'outcome', phase, opIndex: index, op: 'unlink-extra', from: to, to: from, result: 'refused', detail: again.detail })
          entries.push({ opIndex: index, op: 'move', from, to, state: 'unresolved', detail: again.detail })
          unresolved++
          continue
        }
        try {
          await ctx.fs.unlink(to)
        } catch (error) {
          await journal.append({ type: 'outcome', phase, opIndex: index, op: 'unlink-extra', from: to, to: from, result: 'failed', detail: message(error) })
          entries.push({ opIndex: index, op: 'move', from, to, state: 'unresolved', detail: `Could not remove the extra name: ${message(error)}` })
          unresolved++
          continue
        }
        checkpoint(`${mode}:${index}:after-mutation`)
        await journal.append({ type: 'outcome', phase, opIndex: index, op: 'unlink-extra', from: to, to: from, result: 'ok' })
        checkpoint(`${mode}:${index}:after-outcome`)
        entries.push({ opIndex: index, op: 'move', from, to, state: 'reversed', detail: 'Extra destination name removed.' })
        continue
      }
      // move-back: exclusive link to the original path, verify, guarded unlink of the destination.
      checkpoint(`${mode}:${index}:before-intent`)
      await journal.append({ type: 'intent', phase, opIndex: index, op: 'move', from: to, to: from, expected: intent.expected })
      checkpoint(`${mode}:${index}:after-intent`)
      try {
        await ctx.fs.link(to, from)
      } catch (error) {
        await journal.append({ type: 'outcome', phase, opIndex: index, op: 'move', from: to, to: from, result: 'failed', detail: `link: ${message(error)}` })
        entries.push({ opIndex: index, op: 'move', from, to, state: 'unresolved', detail: `Could not link back: ${message(error)}` })
        unresolved++
        continue
      }
      checkpoint(`${mode}:${index}:after-link`)
      const back = await ctx.fs.stat(from)
      const still = await ctx.fs.stat(to)
      const verified = back !== null && still !== null && back.identity !== null && back.identity === still.identity && (await matches(ctx.fs, from, back, intent.expected!))
      if (!verified) {
        await journal.append({ type: 'outcome', phase, opIndex: index, op: 'move', from: to, to: from, result: 'refused', detail: 'Verification after linking back failed; both names preserved.' })
        entries.push({ opIndex: index, op: 'move', from, to, state: 'unresolved', detail: 'Verification after linking back failed.' })
        unresolved++
        continue
      }
      await assert()
      if (!(await sameIdentity(ctx.fs, from, to))) {
        await journal.append({ type: 'outcome', phase, opIndex: index, op: 'move', from: to, to: from, result: 'refused', detail: 'The two names diverged before unlink; both preserved.' })
        entries.push({ opIndex: index, op: 'move', from, to, state: 'unresolved', detail: 'The two names diverged before unlink.' })
        unresolved++
        continue
      }
      try {
        await ctx.fs.unlink(to)
      } catch (error) {
        await journal.append({ type: 'outcome', phase, opIndex: index, op: 'move', from: to, to: from, result: 'linked-only', detail: `unlink: ${message(error)}` })
        entries.push({ opIndex: index, op: 'move', from, to, state: 'unresolved', detail: 'Linked back but could not remove the destination name; retry will finish it.' })
        unresolved++
        continue
      }
      checkpoint(`${mode}:${index}:after-mutation`)
      await journal.append({ type: 'outcome', phase, opIndex: index, op: 'move', from: to, to: from, result: 'ok', observedIdentity: back.identity })
      checkpoint(`${mode}:${index}:after-outcome`)
      entries.push({ opIndex: index, op: 'move', from, to, state: 'reversed', detail: 'Moved back and verified.' })
      continue
    }

    // mkdir: remove only folders proven created by this run, still the same identity, empty.
    const path = intent.to!
    if (!outcome || outcome.result !== 'ok' || outcome.observedIdentity === null) {
      entries.push({ opIndex: index, op: 'mkdir', from: null, to: path, state: 'retained', detail: 'Creation was not proven; folder left in place if present.' })
      continue
    }
    const info = await ctx.fs.stat(path)
    if (!info) {
      entries.push({ opIndex: index, op: 'mkdir', from: null, to: path, state: 'unchanged', detail: 'Folder already gone.' })
      continue
    }
    if (info.kind !== 'dir' || info.identity !== outcome.observedIdentity) {
      entries.push({ opIndex: index, op: 'mkdir', from: null, to: path, state: 'retained', detail: 'A different item is at this path now; preserved.' })
      continue
    }
    if ((await ctx.fs.list(path)).length > 0) {
      entries.push({ opIndex: index, op: 'mkdir', from: null, to: path, state: 'retained', detail: 'Folder is not empty; preserved.' })
      continue
    }
    checkpoint(`${mode}:${index}:before-intent`)
    await journal.append({ type: 'intent', phase, opIndex: index, op: 'rmdir', to: path, observedIdentity: info.identity })
    checkpoint(`${mode}:${index}:after-intent`)
    await assert()
    try {
      await ctx.fs.rmdir(path)
    } catch (error) {
      await journal.append({ type: 'outcome', phase, opIndex: index, op: 'rmdir', to: path, result: 'failed', detail: message(error) })
      entries.push({ opIndex: index, op: 'mkdir', from: null, to: path, state: 'retained', detail: `Could not remove folder: ${message(error)}` })
      continue
    }
    checkpoint(`${mode}:${index}:after-mutation`)
    await journal.append({ type: 'outcome', phase, opIndex: index, op: 'rmdir', to: path, result: 'ok' })
    entries.push({ opIndex: index, op: 'mkdir', from: null, to: path, state: 'reversed', detail: 'Created folder removed.' })
  }

  const status: RunStatus = unresolved > 0 ? 'needs_attention' : mode === 'undo' ? 'undone' : 'rolled_back'
  await journal.append({
    type: 'status',
    phase,
    status,
    detail: unresolved > 0 ? `${unresolved} operation(s) unresolved; fix the conflicts and retry.` : `${mode} complete.`,
  })
  return summarize(plan, journal.records, entries, null, null)
}

function summarize(plan: MovePlan, records: JournalRecord[], entries: RunEntry[], haltReason: string | null, journalProblem: string | null): RunReport {
  const state = currentStatus(records)
  const moves = entries.filter((e) => e.op === 'move')
  return {
    runId: plan.planId,
    kind: plan.kind,
    status: journalProblem ? 'needs_attention' : state.status,
    phase: state.phase,
    haltReason,
    counts: {
      requested: plan.rows.length,
      applied: moves.filter((e) => e.state === 'applied').length,
      reversed: moves.filter((e) => e.state === 'reversed').length,
      unresolved: moves.filter((e) => e.state === 'unresolved').length,
      skipped: entries.filter((e) => e.state === 'skipped' || e.state === 'unchanged' || e.state === 'retained').length,
    },
    entries,
    journalProblem,
  }
}

// ---------------------------------------------------------------------------------------------
// Run index and dependencies

export interface RunSummary {
  runId: string
  kind: PlanKind
  status: RunStatus
  phase: JournalPhase | null
  rows: number
  restoreOf: string | null
  problem: string | null
  torn: boolean
  /** Moves whose apply outcome is ok, by from -> to. */
  movedTo: { from: string; to: string }[]
}

/** Read-only index over stored runs in creation order. Never repairs anything. */
export async function listRuns(store: JournalStore): Promise<RunSummary[]> {
  const out: RunSummary[] = []
  for (const runId of await store.listRuns()) {
    try {
      const { plan, records, problem, torn } = await loadRun(store, runId)
      const state = currentStatus(records)
      const moved: { from: string; to: string }[] = []
      for (const rec of records) {
        if (rec.type === 'outcome' && rec.phase === 'apply' && rec.op === 'move' && rec.result === 'ok') moved.push({ from: rec.from!, to: rec.to! })
      }
      out.push({
        runId,
        kind: plan.kind,
        status: problem ? 'needs_attention' : records.length === 0 ? 'open' : state.status,
        phase: state.phase,
        rows: plan.rows.length,
        restoreOf: plan.restoreOf,
        problem,
        torn,
        movedTo: moved,
      })
    } catch (error) {
      out.push({ runId, kind: 'organize', status: 'needs_attention', phase: null, rows: 0, restoreOf: null, problem: message(error), torn: false, movedTo: [] })
    }
  }
  return out
}

const UNRESOLVED: RunStatus[] = ['open', 'needs_attention']

/** Reasons new work (apply of any plan) must wait. */
export function newWorkBlockers(runs: RunSummary[]): string[] {
  return runs
    .filter((r) => UNRESOLVED.includes(r.status))
    .map((r) => `Run ${r.runId} (${r.kind}) is ${r.status === 'open' ? 'interrupted' : 'unresolved'}; recover or finish it before new work.`)
}

/**
 * Undo is allowed only for the latest committed, not-undone run, with no unresolved run.
 * A newer committed run (for example a quarantine or restore) blocks undo of an older one.
 */
export function undoBlockers(runs: RunSummary[], runId: string): string[] {
  const index = runs.findIndex((r) => r.runId === runId)
  if (index < 0) return [`Unknown run ${runId}.`]
  const target = runs[index]!
  const reasons: string[] = []
  const resuming = target.status === 'needs_attention' && target.phase === 'undo'
  if (target.status !== 'committed' && !resuming) reasons.push(`Run ${runId} is ${target.status}, not committed.`)
  for (const other of runs) {
    if (other.runId !== runId && UNRESOLVED.includes(other.status)) reasons.push(`Run ${other.runId} (${other.kind}) is unresolved; finish it first.`)
  }
  for (const newer of runs.slice(index + 1)) {
    if (newer.status === 'committed' || UNRESOLVED.includes(newer.status)) {
      reasons.push(`Newer ${newer.kind} run ${newer.runId} must be undone first; undo only reverses the latest committed run.`)
    }
  }
  return [...new Set(reasons)]
}

export function describeEntryPath(entry: RunEntry): string {
  return entry.from ? `${entry.from} → ${entry.to}` : `${entry.to}/ (${baseOf(entry.to)})`
}
