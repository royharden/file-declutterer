// Author construction evidence only. Real owned child processes are terminated; no InterruptError.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { writeSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, appendFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { WindowsPlatformHelper } from '../dist-cli/cli/platform/windows-native.js'
import { qualifyRoot } from '../dist-cli/cli/qualify.js'
import { NodeFs } from '../dist-cli/cli/node-fs.js'
import { acquireRootLock } from '../dist-cli/cli/lock.js'
import { FileJournalStore, registerRoot, rootStateDir, ensurePrivateStateDirectory } from '../dist-cli/cli/state.js'
import { scanRoot } from '../dist-cli/src/core/scan.js'
import { heuristicProposals } from '../dist-cli/src/core/heuristic.js'
import { approve, buildPlan } from '../dist-cli/src/core/plan.js'
import { applyPlan, reverseRun, listRuns } from '../dist-cli/src/core/runs.js'
import { DEFAULT_ROOT_CONFIG } from '../dist-cli/src/core/scan-policy.js'
import { buildOrganizeRows, observeDestinations, validateRows } from '../dist-cli/src/core/validate.js'

const script = fileURLToPath(import.meta.url)
const repo = fileURLToPath(new URL('../', import.meta.url))
const runId = 'native-process-crash'
const movedPath = '_Organized/Documents/report.pdf'
const pauseCell = new Int32Array(new SharedArrayBuffer(4))
const emit = (value) => writeSync(1, JSON.stringify(value) + '\n')
let terminatedAtCheckpoint = 0

async function manifest(root) {
  const files = [], dirs = []
  async function walk(dir, rel = '') {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const name = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { dirs.push(name); await walk(path.join(dir, e.name), name) }
      else {
        assert.equal(e.isFile(), true, `Unexpected non-regular fixture: ${name}`)
        // Raw bytes are the independent oracle; no application hash/digest is used here.
        files.push([name, (await readFile(path.join(dir, e.name))).toString('hex')])
      }
    }
  }
  await walk(root)
  return { files: files.sort((a,b) => a[0].localeCompare(b[0])), dirs: dirs.sort() }
}

async function child(config) {
  const helper = new WindowsPlatformHelper()
  let lock
  const trace = []
  const checkpoint = (boundary) => {
    trace.push(boundary)
    if (config.target === boundary) {
      emit({ type: 'ready-to-kill', boundary, pid: process.pid })
      // The parent performs TerminateProcess via this exact owned ChildProcess handle.
      // Blocking prevents an asynchronous observer from allowing an extra mutation first.
      Atomics.wait(pauseCell, 0, 0)
      throw new Error('A crash checkpoint must never resume')
    }
  }
  try {
    const q = await qualifyRoot(config.root, helper, { unmanaged: true })
    assert.equal(q.writeOk, true, JSON.stringify(q))
    assert.equal(q.identityQualified, true)
    const env = { LOCALAPPDATA: path.join(config.caseDir, 'private') }
    const state = rootStateDir(q.rootId, env)
    await ensurePrivateStateDirectory(path.join(state, 'runs'), helper)
    lock = await acquireRootLock(state, q.rootId, helper)
    await registerRoot(q.rootId, config.root, new Date().toISOString(), env, helper)
    const fs = new NodeFs({ root: config.root, rootId: q.rootId, writesEnabled: true, identityQualified: true, helper })
    const actualStore = new FileJournalStore(state, helper)
    const store = Object.fromEntries(['listRuns','readPlan','readJournal'].map((key) => [key, actualStore[key].bind(actualStore)]))
    store.writePlan = async (...args) => {
      checkpoint('store:plan:before')
      await actualStore.writePlan(...args)
      checkpoint('store:plan:after')
    }
    store.appendJournal = async (...args) => {
      const r = JSON.parse(args[1])
      // Core exposes every move/mkdir intent and outcome boundary. Add unexposed
      // begin/status and directory reverse-outcome boundaries without duplicating others.
      const label = `journal:${r.phase}:${r.type}:${r.op ?? 'none'}:${r.opIndex ?? 'none'}`
      const boundary = r.type === 'status' || (r.type === 'begin' && r.phase !== 'apply') || (r.type === 'outcome' && r.op === 'rmdir')
      if (boundary) checkpoint(`${label}:before`)
      await actualStore.appendJournal(...args)
      if (boundary) checkpoint(`${label}:after`)
    }
    for (const [key, label] of [['preserveJournal','preserve'], ['replaceJournal','replace']]) {
      store[key] = async (...args) => {
        checkpoint(`store:${label}:before`)
        const result = await actualStore[key](...args)
        checkpoint(`store:${label}:after`)
        return result
      }
    }
    const ctx = { fs, store, checkpoint, assertOwnership: () => lock.assert() }
    let report
    if (config.action === 'apply') {
      const scan = await scanRoot(fs, { scanId: 'native-crash-scan' })
      const source = scan.files.find((f) => f.relPath === 'report.pdf')
      assert.ok(source, 'fixture source is eligible')
      const proposals = heuristicProposals(scan).filter((p) => p.fileId === source.id)
      const rows = buildOrganizeRows(scan, { accepted: proposals, rejected: [], fatal: null }, 'heuristic', 'construction', DEFAULT_ROOT_CONFIG)
      const accepted = rows.map((row) => ({ ...row, included: row.fileId === source.id }))
      const validated = validateRows(accepted, { kind: 'organize', config: DEFAULT_ROOT_CONFIG, existing: await observeDestinations(fs, accepted), extOf: (id) => scan.files.find((f) => f.id === id)?.ext ?? '' })
      const plan = buildPlan({ planId: runId, kind: 'organize', scan, config: DEFAULT_ROOT_CONFIG, rows: validated })
      assert.equal(plan.rows.length, 1, 'exactly one explicitly selected synthetic source')
      report = await applyPlan(ctx, plan, approve(plan, 'explicit-synthetic-construction'))
    } else {
      const runs = await listRuns(store)
      const existing = runs.find((r) => r.runId === runId)
      if (!existing || ['rolled_back', 'undone'].includes(existing.status)) {
        report = { status: existing?.status ?? 'no-run', unchanged: true }
      } else {
        const mode = existing.phase === 'undo' || existing.status === 'committed' ? 'undo' : 'rollback'
        report = await reverseRun(ctx, runId, mode)
      }
    }
    emit({ type: 'result', report, trace, rootId: q.rootId, state, retiredDeadOwner: lock.retired !== null, helperVersion: helper.version })
  } finally {
    if (lock) await lock.release()
    await helper.close()
  }
}

function launch(config) {
  return new Promise((resolve, reject) => {
    const owned = spawn(process.execPath, [script, '--child', JSON.stringify(config)], { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    let result = null, marker = null, stderr = '', requestedKill = false
    const timer = setTimeout(() => {
      if (owned.exitCode === null) owned.kill('SIGKILL')
      reject(new Error(`Owned child timed out: ${config.action}/${config.target ?? 'complete'}: ${stderr}`))
    }, 120_000)
    owned.stderr.on('data', (chunk) => { if (stderr.length < 16_384) stderr += chunk.toString() })
    createInterface({ input: owned.stdout }).on('line', (line) => {
      try {
        const data = JSON.parse(line)
        if (data.type === 'ready-to-kill') {
          assert.equal(data.pid, owned.pid)
          assert.equal(data.boundary, config.target)
          assert.equal(requestedKill, false)
          marker = data
          requestedKill = true
          assert.equal(owned.kill('SIGKILL'), true, 'TerminateProcess request on owned child accepted')
          terminatedAtCheckpoint++
        } else if (data.type === 'result') result = data
      } catch (error) {
        if (owned.exitCode === null) owned.kill('SIGKILL')
        clearTimeout(timer); reject(error)
      }
    })
    owned.on('error', (error) => { clearTimeout(timer); reject(error) })
    owned.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (config.target) {
        if (!marker || !requestedKill) reject(new Error(`Target not killed (${code}/${signal}): ${config.target}: ${stderr}`))
        else resolve({ killed: true, marker, exitCode: code, signal })
      } else if (code !== 0 || !result) reject(new Error(`Child failed (${code}/${signal}): ${stderr}`))
      else resolve(result)
    })
  })
}

async function parent() {
  assert.equal(process.platform, 'win32', 'real Windows only')
  const suite = await realpath(await mkdtemp(path.join(tmpdir(), 's13-native-process-crash-')))
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', windowsHide: true }).trim()
  assert.equal(head, 'e5e6fa79e9f4a67b65c2cb9e72a6d1b222156b77', 'parent-pinned candidate before execution')
  const runtimeFiles = ['cli/platform/windows-worker.cs', 'cli/platform/windows-worker.ps1', 'scripts/native-process-crash.mjs']
  async function collectRuntime(dir) {
    for (const entry of await readdir(path.join(repo, dir), { withFileTypes: true })) {
      const name = `${dir}/${entry.name}`
      if (entry.isDirectory()) await collectRuntime(name)
      else if (/\.(js|cs|ps1)$/.test(entry.name)) runtimeFiles.push(name)
    }
  }
  await collectRuntime('dist-cli/cli')
  await collectRuntime('dist-cli/src/core')
  runtimeFiles.sort()
  const hashes = async () => Object.fromEntries(await Promise.all(runtimeFiles.map(async (file) => [file, createHash('sha256').update(await readFile(path.join(repo, file))).digest('hex')])))
  const fingerprints = await hashes()
  const evidence = { suite, head, runtime: process.version, helperVersion: 'windows-pwsh-win32-v1', started: new Date().toISOString(), fingerprints, discoveries: {}, cases: [], limitations: ['Author construction evidence; independent S13-RV acceptance required.', 'Process termination on C: NTFS, not power-loss or hostile-writer proof.', 'Independent manifest covers exact raw bytes at file paths; unproven empty created directories may be conservatively retained.', 'One organize row; no maximum-size plan or cross-volume qualification in this harness.'] }
  const save = async () => writeFile(path.join(suite, 'evidence.json'), JSON.stringify(evidence, null, 2))
  let ordinal = 0
  async function fixture(label) {
    const caseDir = path.join(suite, `${String(++ordinal).padStart(3, '0')}-${label}`)
    const root = path.join(caseDir, 'inbox')
    await mkdir(root, { recursive: true })
    await writeFile(path.join(root, 'report.pdf'), Buffer.from([0, 255, 1, 37, 10, 13, 88, 80, 68, 70]))
    await writeFile(path.join(root, 'foreign.bin'), Buffer.from('foreign unselected synthetic sentinel'))
    await writeFile(path.join(root, 'README.protected'), 'protected synthetic sentinel')
    await mkdir(path.join(root, 'project', '.git'), { recursive: true })
    await writeFile(path.join(root, 'project', 'source.js'), 'protected project synthetic bytes')
    return { caseDir, root, original: await manifest(root) }
  }
  async function verifyRestored(f, allowLostJournalRefusal = false) {
    const first = await manifest(f.root)
    assert.deepEqual(first.files, f.original.files, 'raw byte/path restoration including foreign and protected sentinels')
    const retry = await launch({ ...f, action: 'recover' })
    if (allowLostJournalRefusal) {
      assert.equal(retry.report.status, 'needs_attention', 'lost history remains a refusal on fresh-child retry')
      assert.match(retry.report.journalProblem ?? '', /missing|empty/i)
      const journal = path.join(retry.state, 'runs', runId, 'journal.jsonl')
      await assert.rejects(readFile(journal), { code: 'ENOENT' }, 'lost journal must not be recreated')
    } else assert.ok(['rolled_back', 'undone', 'no-run'].includes(retry.report.status), JSON.stringify(retry.report))
    assert.deepEqual((await manifest(f.root)).files, f.original.files, 'fresh-child terminal retry is idempotent')
    return { retryStatus: retry.report.status, retainedEmptyDirectories: first.dirs.filter((d) => !f.original.dirs.includes(d)) }
  }
  async function discover(action, seed) {
    const f = await fixture(`discover-${action}`)
    if (seed === 'committed') assert.equal((await launch({ ...f, action: 'apply' })).report.status, 'committed')
    if (seed === 'linked') await launch({ ...f, action: 'apply', target: 'apply:2:after-link' })
    const r = await launch({ ...f, action })
    assert.equal(new Set(r.trace).size, r.trace.length, 'checkpoint labels unique per single-row execution')
    evidence.discoveries[seed ?? 'apply'] = r.trace
    if (action === 'apply') await launch({ ...f, action: 'recover' })
    await verifyRestored(f)
    await save()
    return r.trace
  }
  emit({ type: 'suite-start', suite, head })
  try {
    const apply = await discover('apply')
    assert.ok(apply.includes('apply:2:after-link'), 'expected linked-only seed boundary discovered')
    const undo = await discover('recover', 'committed')
    const rollback = await discover('recover', 'linked')
    for (const [profile, boundaries] of [['apply', apply], ['undo', undo], ['rollback-linked', rollback]]) {
      for (const target of boundaries) {
        const f = await fixture(`${profile}-${evidence.cases.length + 1}`)
        if (profile === 'undo') assert.equal((await launch({ ...f, action: 'apply' })).report.status, 'committed')
        if (profile === 'rollback-linked') await launch({ ...f, action: 'apply', target: 'apply:2:after-link' })
        const killed = await launch({ ...f, action: profile === 'apply' ? 'apply' : 'recover', target })
        const recovery = await launch({ ...f, action: 'recover' })
        const lostJournalRefusal = profile === 'apply' && target === 'store:plan:after'
        if (lostJournalRefusal) {
          assert.equal(recovery.report.status, 'needs_attention', 'plan without a first verified journal is lost evidence')
          assert.match(recovery.report.journalProblem ?? '', /missing|empty/i)
        } else assert.ok(['rolled_back', 'undone', 'no-run'].includes(recovery.report.status), JSON.stringify(recovery.report))
        const verify = await verifyRestored(f, lostJournalRefusal)
        evidence.cases.push({ profile, target, result: 'PASS', caseDir: f.caseDir, killed, recoveredStatus: recovery.report.status, safeLostJournalRefusal: lostJournalRefusal, retiredDeadOwner: recovery.retiredDeadOwner, ...verify })
        await save()
        emit({ type: 'case-pass', profile, target, completed: evidence.cases.length })
      }
    }
    // A torn journal is deliberately synthesized only in this harness-owned private state.
    for (const target of ['store:preserve:before', 'store:preserve:after', 'store:replace:before', 'store:replace:after']) {
      const f = await fixture(`torn-${evidence.cases.length + 1}`)
      await launch({ ...f, action: 'apply', target: 'apply:2:after-link' })
      const roots = await readdir(path.join(f.caseDir, 'private', 'file-declutterer'))
      assert.equal(roots.length, 1)
      const dir = path.join(f.caseDir, 'private', 'file-declutterer', roots[0], 'runs', runId)
      const journal = path.join(dir, 'journal.jsonl')
      await appendFile(journal, '{"schema":')
      const torn = await readFile(journal)
      const killed = await launch({ ...f, action: 'recover', target })
      const recovery = await launch({ ...f, action: 'recover' })
      assert.equal(recovery.report.status, 'rolled_back')
      const preserved = (await readdir(dir)).filter((name) => name.startsWith('journal.torn-'))
      assert.ok(preserved.length > 0)
      const bytes = await Promise.all(preserved.map((name) => readFile(path.join(dir, name))))
      assert.ok(bytes.some((b) => b.equals(torn)), 'exact torn original preserved across second process death')
      const verify = await verifyRestored(f)
      evidence.cases.push({ profile: 'torn-second-crash', target, result: 'PASS', killed, preserved: preserved.length, caseDir: f.caseDir, ...verify })
      await save(); emit({ type: 'case-pass', profile: 'torn-second-crash', target, completed: evidence.cases.length })
    }
    {
      const f = await fixture('complete-corruption')
      await launch({ ...f, action: 'apply', target: 'apply:2:after-link' })
      const roots = await readdir(path.join(f.caseDir, 'private', 'file-declutterer'))
      const journal = path.join(f.caseDir, 'private', 'file-declutterer', roots[0], 'runs', runId, 'journal.jsonl')
      await appendFile(journal, '{not valid complete JSON}\n')
      const before = await manifest(f.root), logBefore = await readFile(journal)
      const recovery = await launch({ ...f, action: 'recover' })
      assert.equal(recovery.report.status, 'needs_attention')
      assert.ok(recovery.report.journalProblem)
      assert.deepEqual(await manifest(f.root), before, 'corrupt evidence refuses without file mutation')
      assert.deepEqual(await readFile(journal), logBefore, 'corrupt journal left untouched')
      evidence.cases.push({ profile: 'complete-corruption', result: 'PASS', caseDir: f.caseDir, expectedStatus: recovery.report.status })
      await save()
    }
    {
      const f = await fixture('foreign-original-conflict')
      assert.equal((await launch({ ...f, action: 'apply' })).report.status, 'committed')
      const foreign = path.join(f.root, 'report.pdf')
      await writeFile(foreign, 'foreign replacement created only by harness', { flag: 'wx' })
      const before = await manifest(f.root)
      const refused = await launch({ ...f, action: 'recover' })
      assert.equal(refused.report.status, 'needs_attention')
      assert.deepEqual((await manifest(f.root)).files, before.files, 'both foreign original and moved source preserved')
      // Delete only the exact foreign fixture this harness just created, after verifying it.
      assert.equal(await readFile(foreign, 'utf8'), 'foreign replacement created only by harness')
      await unlink(foreign)
      assert.equal((await launch({ ...f, action: 'recover' })).report.status, 'undone')
      const verify = await verifyRestored(f)
      evidence.cases.push({ profile: 'foreign-original-conflict', result: 'PASS', caseDir: f.caseDir, ...verify })
      await save()
    }
    assert.deepEqual(await hashes(), fingerprints, 'executed runtime and harness unchanged during suite')
    evidence.result = 'PASS'
  } catch (error) {
    evidence.result = 'FAIL'
    evidence.failure = error.stack ?? String(error)
    process.exitCode = 1
  } finally {
    evidence.finished = new Date().toISOString()
    evidence.counts = { passed: evidence.cases.filter((c) => c.result === 'PASS').length, failed: evidence.result === 'FAIL' ? 1 : 0, discoveredApply: evidence.discoveries.apply?.length ?? 0, discoveredUndo: evidence.discoveries.committed?.length ?? 0, discoveredRollbackLinked: evidence.discoveries.linked?.length ?? 0, processKills: terminatedAtCheckpoint }
    await save()
    emit({ type: 'suite-result', result: evidence.result, counts: evidence.counts, suite, failure: evidence.failure ?? null })
  }
}

if (process.argv[2] === '--child') child(JSON.parse(process.argv[3])).catch((error) => { console.error(error.stack ?? error); process.exitCode = 1 })
else await parent()
