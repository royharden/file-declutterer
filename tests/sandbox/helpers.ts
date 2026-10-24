import { MemoryFs, MemoryJournalStore } from '../../src/adapters/memory-fs'
import { createSandbox } from '../../src/adapters/sandbox-seed'
import { InterruptError, type Checkpoint } from '../../src/core/fs-port'
import { heuristicProposals } from '../../src/core/heuristic'
import { approve, buildPlan, type Approval, type MovePlan } from '../../src/core/plan'
import type { ExecContext } from '../../src/core/runs'
import { scanRoot } from '../../src/core/scan'
import { DEFAULT_ROOT_CONFIG } from '../../src/core/scan-policy'
import { buildOrganizeRows, defaultSelection, observeDestinations, validateRows, type PlanRow } from '../../src/core/validate'

export const config = DEFAULT_ROOT_CONFIG

/** Independent pre/post manifest straight from the in-memory volume. */
export function manifestOf(fs: MemoryFs): string {
  return JSON.stringify(fs.manifest())
}

export async function approvedOrganizePlan(fs: MemoryFs, planId = 'plan-a', only?: string[]): Promise<{ plan: MovePlan; approval: Approval }> {
  const scan = await scanRoot(fs, { scanId: `scan-${planId}` })
  const extOf = (id: string) => scan.files.find((f) => f.id === id)?.ext ?? ''
  const validate = async (rows: PlanRow[]) => validateRows(rows, { kind: 'organize', config, existing: await observeDestinations(fs, rows), extOf })
  let rows = await validate(defaultSelection(await validate(buildOrganizeRows(scan, { accepted: heuristicProposals(scan), rejected: [], fatal: null }, 'heuristic', 'b', config))))
  if (only) rows = await validate(rows.map((r) => ({ ...r, included: r.included && only.includes(r.source) })))
  const plan = buildPlan({ planId, kind: 'organize', scan, config, rows })
  return { plan, approval: approve(plan, '2026-10-23T00:00:00Z') }
}

export function smallSandbox(): MemoryFs {
  return createSandbox()
}

/** Context whose checkpoint throws at the nth boundary (1-based); 0 never interrupts. */
export function ctxWithInterrupt(fs: MemoryFs, store: MemoryJournalStore, n = 0): ExecContext & { reached: string[] } {
  const reached: string[] = []
  const checkpoint: Checkpoint = (boundary) => {
    reached.push(boundary)
    if (n > 0 && reached.length === n) throw new InterruptError(boundary)
  }
  return { fs, store, checkpoint, reached }
}
