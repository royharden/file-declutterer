// RV child-command driver. All paths come from RV's newly created synthetic sandbox.
// The production helper loader is untouched; this driver explicitly constructs the helper.
import path from 'node:path'
import { writeFile } from 'node:fs/promises'
import { WindowsPlatformHelper } from '../dist-cli/cli/platform/windows-native.js'
import { qualifyRoot } from '../dist-cli/cli/qualify.js'
import { ensurePrivateStateDirectory, FileJournalStore } from '../dist-cli/cli/state.js'
import { acquireRootLock } from '../dist-cli/cli/lock.js'
import { NodeFs } from '../dist-cli/cli/node-fs.js'
import { scanRoot } from '../dist-cli/src/core/scan.js'
import { heuristicProposals } from '../dist-cli/src/core/heuristic.js'
import { buildOrganizeRows, validateRows, observeDestinations } from '../dist-cli/src/core/validate.js'
import { DEFAULT_ROOT_CONFIG as config } from '../dist-cli/src/core/scan-policy.js'
import { buildPlan, approve } from '../dist-cli/src/core/plan.js'
import { applyPlan, reverseRun } from '../dist-cli/src/core/runs.js'

const [sandbox, action, crashText = '0'] = process.argv.slice(2)
if (!sandbox || !path.basename(sandbox).startsWith('s13-rv-crash-')) throw new Error('RV sandbox required')
const root = path.join(sandbox, 'inbox')
const state = path.join(sandbox, 'private-state')
const helper = new WindowsPlatformHelper()
let lock
let seen = 0
const boundaries = []
try {
  const q = await qualifyRoot(root, helper, { unmanaged: true, env: {} })
  if (!q.writeOk) throw new Error(JSON.stringify(q))
  await ensurePrivateStateDirectory(state, helper)
  lock = await acquireRootLock(state, q.rootId, helper)
  const fs = new NodeFs({ root, rootId: q.rootId, identityQualified: true, writesEnabled: true, helper })
  const store = new FileJournalStore(state, helper)
  const ctx = { fs, store, assertOwnership: lock.assert, checkpoint(boundary) {
    boundaries.push(boundary)
    if (++seen === Number(crashText)) process.kill(process.pid)
  } }
  let report
  if (action === 'apply') {
    const scan = await scanRoot(fs, { scanId: 'rv-scan' })
    const raw = buildOrganizeRows(scan, { accepted: heuristicProposals(scan), rejected: [], fatal: null }, 'heuristic', 'rv', config)
    const rows = validateRows(raw.map(row => ({ ...row, included: true })), { kind: 'organize', config, existing: await observeDestinations(fs, raw), extOf: id => scan.files.find(f => f.id === id)?.ext ?? '' })
    const plan = buildPlan({ planId: 'rv-native-run', kind: 'organize', scan, config, rows })
    if (plan.rows.length !== 1) throw new Error('Expected one explicit synthetic file')
    report = await applyPlan(ctx, plan, approve(plan, 'rv-native-eval'))
  } else {
    report = await reverseRun(ctx, 'rv-native-run', action)
  }
  const result = { action, boundaries, report, retired: lock.retired !== null }
  await writeFile(path.join(sandbox, `result-${action}-${Date.now()}.json`), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} finally {
  if (lock) await lock.release()
  await helper.close()
}
