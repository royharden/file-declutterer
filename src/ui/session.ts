import { MemoryFs, MemoryJournalStore } from '../adapters/memory-fs'
import { createSandbox, simulatedResponse } from '../adapters/sandbox-seed'
import { findDuplicates, quarantineRows, restoreCandidates, restoreRows, type DuplicateReport, type RestoreCandidate } from '../core/duplicates'
import { InterruptError } from '../core/fs-port'
import { heuristicProposals } from '../core/heuristic'
import { parseJournal, type JournalRecord } from '../core/journal-codec'
import { approvalIsCurrent, approve, buildPlan, parseMovePlan, reconstructOrganizeRows, type Approval, type MovePlan } from '../core/plan'
import { parseProposalResponse, type ParsedProposals, type RejectedProposal } from '../core/proposal-schema'
import {
  applyPlan,
  listRuns,
  newWorkBlockers,
  previewReverse,
  reverseRun,
  undoBlockers,
  type ExecContext,
  type ReversePreviewEntry,
  type RunReport,
  type RunSummary,
} from '../core/runs'
import { scanRoot } from '../core/scan'
import { DEFAULT_ROOT_CONFIG, POLICY_ID, type RootConfig } from '../core/scan-policy'
import type { PlanKind, ProposalSource, ScanManifest } from '../core/types'
import {
  buildOrganizeRows,
  defaultSelection,
  editOrganizeRow,
  isBlocked,
  observeDestinations,
  organizeDestination,
  validateRows,
  type PlanRow,
} from '../core/validate'

// One sandbox session per page load. All state is in memory; reload loses it (PLAN §2).

export interface ImportedReview {
  plan: MovePlan
  note: string
  unmatched: { from: string; reason: string }[]
}

/** Quarantine and restore use their own reviewed plan, separate from the organize review. */
export interface SidePlan {
  kind: Extract<PlanKind, 'quarantine' | 'restore'>
  planId: string
  restoreOf: string | null
  rows: PlanRow[]
  plan: MovePlan | null
  approval: Approval | null
}

export class SandboxSession {
  fs: MemoryFs
  store: MemoryJournalStore
  config: RootConfig = { ...DEFAULT_ROOT_CONFIG }
  scan: ScanManifest | null = null
  busy = false
  error: string | null = null
  version = 0

  // Propose / review
  proposalSource: ProposalSource | null = null
  batchId: string | null = null
  rows: PlanRow[] = []
  rejected: RejectedProposal[] = []
  proposalFatal: string | null = null
  approval: Approval | null = null
  /** Plan built from the current rows; rebuilt (new digest) after every change. */
  plan: MovePlan | null = null
  imported: ImportedReview | null = null

  // Apply / recovery / runs
  runs: RunSummary[] = []
  lastReport: RunReport | null = null
  /** Interrupt at the Nth journal/file-system boundary of the next action (sandbox only). */
  interruptAt: number | null = null
  boundaries: string[] = []
  lastInterrupt: string | null = null
  preview: { runId: string; entries: ReversePreviewEntry[] } | null = null

  // Duplicates / quarantine / restore
  dupScan: ScanManifest | null = null
  dupReport: DuplicateReport | null = null
  dupSelected = new Set<string>()
  side: SidePlan | null = null
  restoreSource: { runId: string; candidates: RestoreCandidate[] } | null = null
  restoreChosen = new Set<string>()

  private counter = 0
  private listeners = new Set<() => void>()

  constructor() {
    this.fs = createSandbox()
    this.store = new MemoryJournalStore()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  changed(): void {
    this.version++
    for (const listener of this.listeners) listener()
  }

  nextId(prefix: string): string {
    this.counter++
    return `${prefix}-${String(this.counter).padStart(4, '0')}`
  }

  reset(): void {
    this.fs = createSandbox()
    this.store = new MemoryJournalStore()
    this.config = { ...DEFAULT_ROOT_CONFIG }
    this.scan = null
    this.error = null
    this.clearProposals()
    this.runs = []
    this.lastReport = null
    this.interruptAt = null
    this.boundaries = []
    this.lastInterrupt = null
    this.preview = null
    this.dupScan = null
    this.dupReport = null
    this.dupSelected = new Set()
    this.side = null
    this.restoreSource = null
    this.restoreChosen = new Set()
    this.changed()
  }

  protected clearProposals(): void {
    this.proposalSource = null
    this.batchId = null
    this.rows = []
    this.rejected = []
    this.proposalFatal = null
    this.approval = null
    this.plan = null
    this.imported = null
  }

  async guard<T>(work: () => Promise<T>): Promise<T | null> {
    if (this.busy) return null
    this.busy = true
    this.error = null
    this.changed()
    try {
      return await work()
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      return null
    } finally {
      this.busy = false
      this.changed()
    }
  }

  async runScan(): Promise<ScanManifest | null> {
    return this.guard(async () => {
      this.clearProposals()
      this.scan = await scanRoot(this.fs, { scanId: this.nextId('scan'), mode: 'organize', config: this.config })
      return this.scan
    })
  }

  get canPropose(): boolean {
    return this.scan !== null && this.scan.status === 'complete' && this.scan.files.length > 0
  }

  async propose(source: 'heuristic' | 'simulated'): Promise<void> {
    await this.guard(async () => {
      const scan = this.scan
      if (!scan || scan.status !== 'complete') throw new Error('Run a complete scan first.')
      const ids = new Set(scan.files.map((f) => f.id))
      const parsed: ParsedProposals =
        source === 'heuristic'
          ? { accepted: heuristicProposals(scan), rejected: [], fatal: null }
          : parseProposalResponse(simulatedResponse(scan), ids)
      this.proposalSource = source
      this.batchId = this.nextId(source === 'heuristic' ? 'heur' : 'sim')
      this.rejected = parsed.rejected
      this.proposalFatal = parsed.fatal
      this.imported = null
      const rows = buildOrganizeRows(scan, parsed, source, this.batchId, this.config)
      const validated = await this.validate(rows)
      this.rows = await this.validate(defaultSelection(validated))
      this.rebuildPlan()
    })
  }

  private extOf = (fileId: string): string => this.scan?.files.find((f) => f.id === fileId)?.ext ?? ''

  private async validate(rows: PlanRow[]): Promise<PlanRow[]> {
    const existing = await observeDestinations(this.fs, rows)
    return validateRows(rows, { kind: 'organize', config: this.config, existing, extOf: this.extOf })
  }

  /** Rebuild the executable plan. A new digest clears approval (T35). */
  private rebuildPlan(): void {
    if (!this.scan || this.rows.length === 0) {
      this.plan = null
      this.approval = null
      return
    }
    const next = buildPlan({ planId: this.plan?.planId ?? this.nextId('plan'), kind: 'organize', scan: this.scan, config: this.config, rows: this.rows })
    if (!this.plan || next.digest !== this.plan.digest) this.approval = null
    this.plan = next
  }

  async setIncluded(rowId: string, included: boolean): Promise<void> {
    await this.guard(async () => {
      const rows = this.rows.map((row) => (row.rowId === rowId ? { ...row, included: included && !isBlocked(row) } : row))
      this.rows = await this.validate(rows)
      this.rebuildPlan()
    })
  }

  async selectClean(): Promise<void> {
    await this.guard(async () => {
      this.rows = await this.validate(defaultSelection(this.rows))
      this.rebuildPlan()
    })
  }

  async clearSelection(): Promise<void> {
    await this.guard(async () => {
      this.rows = await this.validate(this.rows.map((row) => ({ ...row, included: false })))
      this.rebuildPlan()
    })
  }

  async editRow(rowId: string, categoryId: string, basename: string): Promise<void> {
    await this.guard(async () => {
      const file = this.scan?.files.find((f) => f.id === rowId)
      if (!file) throw new Error('Unknown row.')
      const rows = this.rows.map((row) => (row.rowId === rowId ? editOrganizeRow(row, file, categoryId, basename, this.config) : row))
      this.rows = await this.validate(rows)
      this.rebuildPlan()
    })
  }

  /** Changing the output layout re-derives every destination and clears approval (T35). */
  async setOutputRoot(outputRoot: string): Promise<void> {
    await this.guard(async () => {
      this.config = { ...this.config, outputRoot }
      const rows = this.rows.map((row) => {
        const file = this.scan?.files.find((f) => f.id === row.fileId)
        return row.categoryId && row.basename !== null && file
          ? { ...row, destination: organizeDestination(this.config, row.categoryId, row.basename, file.ext) }
          : row
      })
      this.rows = await this.validate(rows)
      this.rebuildPlan()
    })
  }

  get approvalCurrent(): boolean {
    return approvalIsCurrent(this.plan, this.approval)
  }

  approveCurrent(): void {
    if (!this.plan || this.plan.rows.length === 0) return
    this.approval = approve(this.plan, new Date().toISOString())
    this.changed()
  }

  revokeApproval(): void {
    this.approval = null
    this.changed()
  }

  exportPlanJson(): string | null {
    return this.plan ? JSON.stringify(this.plan, null, 2) : null
  }

  /**
   * Import a plan for review (T23). Sandbox organize plans are reconstructed against the
   * current scan and need fresh approval; native plans are shown read-only.
   */
  async importPlan(text: string): Promise<void> {
    await this.guard(async () => {
      const parsed = parseMovePlan(text)
      if (!parsed.ok) throw new Error(`Import refused: ${parsed.error}`)
      const plan = parsed.plan
      if (plan.profile === 'native') {
        this.imported = { plan, note: 'Native plan: review only. The browser never executes native plans; use the local CLI.', unmatched: [] }
        return
      }
      if (!this.scan || this.scan.status !== 'complete') throw new Error('Scan the sandbox before importing a plan.')
      const { rows, unmatched } = reconstructOrganizeRows(plan, this.scan, this.config)
      this.proposalSource = 'manual-edit'
      this.batchId = this.nextId('import')
      this.rejected = []
      this.proposalFatal = null
      this.rows = await this.validate(rows)
      this.plan = null
      this.approval = null
      this.rebuildPlan()
      this.imported = {
        plan,
        note: `Reconstructed ${rows.length} row(s) against the current scan. Rows start unselected; select and approve again.`,
        unmatched,
      }
    })
  }

  // ---- apply, recovery, undo ----

  private execContext(): ExecContext {
    this.boundaries = []
    this.lastInterrupt = null
    const target = this.interruptAt
    return {
      fs: this.fs,
      store: this.store,
      checkpoint: (boundary: string) => {
        this.boundaries.push(boundary)
        if (target !== null && this.boundaries.length === target) throw new InterruptError(boundary)
      },
    }
  }

  async refreshRuns(): Promise<void> {
    this.runs = await listRuns(this.store)
  }

  get blockers(): string[] {
    return newWorkBlockers(this.runs)
  }

  setInterrupt(n: number | null): void {
    this.interruptAt = n !== null && Number.isInteger(n) && n > 0 ? n : null
    this.changed()
  }

  private async runAction(action: (ctx: ExecContext) => Promise<RunReport>): Promise<void> {
    await this.guard(async () => {
      try {
        this.lastReport = await action(this.execContext())
      } catch (error) {
        if (!(error instanceof InterruptError)) throw error
        this.lastInterrupt = `Interrupted at boundary ${this.boundaries.length} (${error.boundary}). The journal keeps what was flushed; recover from Apply / Recovery.`
        this.lastReport = null
      } finally {
        this.interruptAt = null
        this.preview = null
        await this.refreshRuns()
      }
    })
  }

  async applyApproved(): Promise<void> {
    const plan = this.plan
    const approval = this.approval
    if (!plan) return
    await this.refreshRuns()
    await this.runAction((ctx) => applyPlan(ctx, plan, approval, newWorkBlockers(this.runs)))
    // A plan is single-use: its id becomes the run id. Re-plan from a fresh scan afterwards.
    if (this.runs.some((r) => r.runId === plan.planId)) {
      this.clearProposals()
      this.scan = null
      this.changed()
    }
  }

  async rollback(runId: string): Promise<void> {
    await this.runAction((ctx) => reverseRun(ctx, runId, 'rollback'))
  }

  async previewUndo(runId: string): Promise<void> {
    await this.guard(async () => {
      this.preview = { runId, entries: await previewReverse({ fs: this.fs, store: this.store }, runId) }
    })
  }

  undoBlockersFor(runId: string): string[] {
    return undoBlockers(this.runs, runId)
  }

  async undo(runId: string): Promise<void> {
    await this.refreshRuns()
    const blockers = undoBlockers(this.runs, runId)
    await this.runAction((ctx) => reverseRun(ctx, runId, 'undo', blockers))
  }

  async journalRecords(runId: string): Promise<{ records: JournalRecord[]; problem: string | null; torn: boolean }> {
    const parsed = parseJournal((await this.store.readJournal(runId)) ?? '', { runId })
    return {
      records: parsed.records,
      problem: parsed.corrupt ? `line ${parsed.corrupt.line}: ${parsed.corrupt.reason}` : null,
      torn: parsed.tornTail !== null,
    }
  }

  /** Simulate an edit made outside the app (T18 demo). Bytes change in place. */
  simulateExternalEdit(path: string): void {
    const bytes = this.fs.readFile(path)
    if (!bytes) {
      this.error = `No file at ${path}.`
    } else {
      const edited = new Uint8Array(bytes.length + 9)
      edited.set(bytes)
      edited.set([0x20, 0x28, 0x65, 0x64, 0x69, 0x74, 0x65, 0x64, 0x29], bytes.length) // " (edited)"
      this.fs.writeFile(path, edited)
      this.error = null
    }
    this.changed()
  }

  // ---- duplicates, quarantine, restore ----

  async scanDuplicates(): Promise<void> {
    await this.guard(async () => {
      this.dupScan = await scanRoot(this.fs, { scanId: this.nextId('dscan'), mode: 'duplicates', config: this.config })
      this.dupReport = this.dupScan.status === 'complete' ? findDuplicates(this.dupScan, this.config) : null
      this.dupSelected = new Set()
      this.side = null
    })
  }

  toggleDuplicate(fileId: string, selected: boolean): void {
    const next = new Set(this.dupSelected)
    if (selected) next.add(fileId)
    else next.delete(fileId)
    this.dupSelected = next
    if (this.side?.kind === 'quarantine') this.side = null
    this.changed()
  }

  private sideScan(): Pick<ScanManifest, 'scanId' | 'profile' | 'policyId' | 'root'> {
    return this.dupScan ?? { scanId: this.nextId('rscan'), profile: 'sandbox', policyId: POLICY_ID, root: { id: this.fs.rootId, displayHint: this.fs.rootDisplay } }
  }

  private async finishSide(kind: SidePlan['kind'], planId: string, restoreOf: string | null, rows: PlanRow[]): Promise<void> {
    const existing = await observeDestinations(this.fs, rows)
    const validated = validateRows(rows, { kind, config: this.config, existing, extOf: () => '' })
    const plan = buildPlan({ planId, kind, scan: this.sideScan(), config: this.config, rows: validated, restoreOf })
    this.side = { kind, planId, restoreOf, rows: validated, plan, approval: null }
  }

  async reviewQuarantine(): Promise<void> {
    await this.guard(async () => {
      if (!this.dupReport) throw new Error('Find duplicates first.')
      if (this.dupSelected.size === 0) throw new Error('Select at least one extra copy.')
      const planId = this.nextId('quar')
      await this.finishSide('quarantine', planId, null, quarantineRows(this.dupReport, this.dupSelected, planId, this.config))
    })
  }

  async chooseRestoreRun(runId: string): Promise<void> {
    await this.guard(async () => {
      await this.refreshRuns()
      const run = this.runs.find((r) => r.runId === runId)
      const planText = await this.store.readPlan(runId)
      if (!run || run.kind !== 'quarantine' || run.status !== 'committed' || !planText) throw new Error('Choose a committed quarantine run.')
      const parsed = parseMovePlan(planText)
      if (!parsed.ok) throw new Error(parsed.error)
      this.restoreSource = { runId, candidates: restoreCandidates(parsed.plan, run.movedTo) }
      this.restoreChosen = new Set()
      if (this.side?.kind === 'restore') this.side = null
    })
  }

  toggleRestore(quarantined: string, chosen: boolean): void {
    const next = new Set(this.restoreChosen)
    if (chosen) next.add(quarantined)
    else next.delete(quarantined)
    this.restoreChosen = next
    if (this.side?.kind === 'restore') this.side = null
    this.changed()
  }

  async reviewRestore(): Promise<void> {
    await this.guard(async () => {
      if (!this.restoreSource || this.restoreChosen.size === 0) throw new Error('Choose a quarantine run and at least one entry.')
      const rows = await restoreRows(this.fs, this.restoreSource.candidates, this.restoreChosen)
      await this.finishSide('restore', this.nextId('rest'), this.restoreSource.runId, rows)
    })
  }

  get sideApprovalCurrent(): boolean {
    return this.side !== null && approvalIsCurrent(this.side.plan, this.side.approval)
  }

  approveSide(): void {
    if (!this.side?.plan || this.side.plan.rows.length === 0) return
    this.side = { ...this.side, approval: approve(this.side.plan, new Date().toISOString()) }
    this.changed()
  }

  async applySide(): Promise<void> {
    const side = this.side
    if (!side?.plan) return
    await this.refreshRuns()
    const plan = side.plan
    await this.runAction((ctx) => applyPlan(ctx, plan, side.approval, newWorkBlockers(this.runs)))
    if (this.runs.some((r) => r.runId === plan.planId)) {
      this.side = null
      this.dupSelected = new Set()
      this.dupReport = null
      this.dupScan = null
      this.restoreSource = null
      this.restoreChosen = new Set()
      this.changed()
    }
  }
}
