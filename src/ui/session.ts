import { MemoryFs, MemoryJournalStore } from '../adapters/memory-fs'
import { createSandbox, simulatedResponse } from '../adapters/sandbox-seed'
import { heuristicProposals } from '../core/heuristic'
import { approvalIsCurrent, approve, buildPlan, parseMovePlan, reconstructOrganizeRows, type Approval, type MovePlan } from '../core/plan'
import { parseProposalResponse, type ParsedProposals, type RejectedProposal } from '../core/proposal-schema'
import { scanRoot } from '../core/scan'
import { DEFAULT_ROOT_CONFIG, type RootConfig } from '../core/scan-policy'
import type { ProposalSource, ScanManifest } from '../core/types'
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
}
