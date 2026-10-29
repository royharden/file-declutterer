// RV independent same-global-identity/wrong-root refusal and correct-root positive control.
// Only new synthetic roots/state. Retains all artifacts; production loader is untouched.
import assert from 'node:assert/strict'
import { mkdtemp, realpath, mkdir, writeFile, readFile, readdir, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { WindowsPlatformHelper } from '../dist-cli/cli/platform/windows-native.js'
import { qualifyRoot } from '../dist-cli/cli/qualify.js'
import { ensurePrivateStateDirectory, FileJournalStore } from '../dist-cli/cli/state.js'
import { acquireRootLock } from '../dist-cli/cli/lock.js'
import { NodeFs } from '../dist-cli/cli/node-fs.js'
import { scanRoot } from '../dist-cli/src/core/scan.js'
import { heuristicProposals } from '../dist-cli/src/core/heuristic.js'
import { buildOrganizeRows, observeDestinations, validateRows } from '../dist-cli/src/core/validate.js'
import { DEFAULT_ROOT_CONFIG as config } from '../dist-cli/src/core/scan-policy.js'
import { buildPlan, approve } from '../dist-cli/src/core/plan.js'
import { applyPlan, reverseRun, previewReverse, listRuns, newWorkBlockers } from '../dist-cli/src/core/runs.js'

const sandbox = await realpath(await mkdtemp(path.join(tmpdir(), 's13-rv-authority-')))
const rootA = path.join(sandbox, 'A'), rootB = path.join(sandbox, 'B'), state = path.join(sandbox, 'private-state')
await mkdir(rootA); await mkdir(rootB)
const bytes = Buffer.from([0, 255, 128, 13, 10, 17, 0])
await writeFile(path.join(rootA, 'report.pdf'), bytes)
async function snapshot(root) {
  const entries = []
  async function walk(dir, prefix = '') { for (const item of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix + item.name
    if (item.isDirectory()) await walk(path.join(dir, item.name), rel + '/')
    else entries.push([rel, (await readFile(path.join(dir, item.name))).toString('hex')])
  } }
  await walk(root)
  return entries.sort((a, b) => a[0].localeCompare(b[0]))
}
const helper = new WindowsPlatformHelper()
let lock, result = 'pass', error = null
const checks = []
try {
  const qa = await qualifyRoot(rootA, helper, { unmanaged: true, env: {} })
  const qb = await qualifyRoot(rootB, helper, { unmanaged: true, env: {} })
  assert.equal(qa.writeOk, true); assert.equal(qb.writeOk, true); assert.notEqual(qa.rootId, qb.rootId)
  await ensurePrivateStateDirectory(state, helper)
  lock = await acquireRootLock(state, qa.rootId, helper)
  const a = new NodeFs({ root: rootA, rootId: qa.rootId, writesEnabled: true, identityQualified: true, helper })
  const b = new NodeFs({ root: rootB, rootId: qb.rootId, writesEnabled: true, identityQualified: true, helper })
  const store = new FileJournalStore(state, helper)
  const scan = await scanRoot(a, { scanId: 'rv-native-authority' })
  const raw = buildOrganizeRows(scan, { accepted: heuristicProposals(scan), rejected: [], fatal: null }, 'heuristic', 'rv', config)
  const rows = validateRows(raw.map(row => ({ ...row, included: true })), { kind: 'organize', config, existing: await observeDestinations(a, raw), extOf: () => '.pdf' })
  const plan = buildPlan({ planId: 'rv-authority', kind: 'organize', scan, config, rows })
  const before = await snapshot(rootA)
  const ctx = { fs: a, store, assertOwnership: lock.assert }
  assert.equal((await applyPlan(ctx, plan, approve(plan, 'rv'))).status, 'committed')
  const rel = '_Organized/Documents/report.pdf'
  await mkdir(path.dirname(path.join(rootB, rel)), { recursive: true })
  await link(path.join(rootA, rel), path.join(rootB, rel))
  assert.equal((await a.stat(rel)).identity, (await b.stat(rel)).identity)
  const aBeforeWrong = await snapshot(rootA), bBeforeWrong = await snapshot(rootB)
  const journalBeforeWrong = await store.readJournal(plan.planId)
  const planBeforeWrong = await store.readPlan(plan.planId)
  for (const [name, filesystem, profile] of [['foreign-root', b, 'native'], ['foreign-profile', a, 'sandbox']]) {
    const calls = []
    const port = new Proxy(filesystem, { get(target, key) {
      if (key === 'profile') return profile
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? (...args) => { calls.push(String(key)); return value.apply(target, args) } : value
    } })
    let ownerChecks = 0
    const wrong = { fs: port, store, assertOwnership: async () => { ownerChecks++; await lock.assert() } }
    await assert.rejects(previewReverse(wrong, plan.planId), /root/)
    await assert.rejects(reverseRun(wrong, plan.planId, 'undo'), /root/)
    await assert.rejects(reverseRun(wrong, plan.planId, 'rollback'), /root/)
    const index = await listRuns(store, port)
    assert.equal(index[0].status, 'needs_attention')
    assert.equal(newWorkBlockers(index).length, 1)
    assert.deepEqual(calls, [])
    assert.equal(ownerChecks, 0)
    assert.equal(await store.readJournal(plan.planId), journalBeforeWrong)
    assert.equal(await store.readPlan(plan.planId), planBeforeWrong)
    assert.deepEqual(await snapshot(rootA), aBeforeWrong)
    assert.deepEqual(await snapshot(rootB), bBeforeWrong)
    checks.push({ name, result: 'pass', filesystemCalls: 0, ownershipCalls: 0, stateAndBothRootsUnchanged: true })
  }
  assert.equal((await reverseRun(ctx, plan.planId, 'undo')).status, 'undone')
  assert.deepEqual(await snapshot(rootA), before)
  assert.deepEqual(await snapshot(rootB), bBeforeWrong)
  assert.deepEqual(await readFile(path.join(rootB, rel)), bytes)
  checks.push({ name: 'correct-root-positive-control', result: 'pass', originalManifestRestored: true, foreignHardlinkPreserved: true })
} catch (failure) { result = 'fail'; error = String(failure); process.exitCode = 1 }
finally {
  if (lock) await lock.release()
  await helper.close()
  const report = { candidate: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sandbox, result, error, checks }
  await writeFile(`evals/native-authority-result-${Date.now()}.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}
