// Real disposable root identity/ancestry checks; no deletion or whole-disk discovery.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, rename, symlink, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { WindowsPlatformHelper } from '../dist-cli/cli/platform/windows-native.js'
import { qualifyRoot } from '../dist-cli/cli/qualify.js'
import { NodeFs } from '../dist-cli/cli/node-fs.js'
import { registerRoot, rootsHintingPath } from '../dist-cli/cli/state.js'

const sandbox = await realpath(await mkdtemp(path.join(tmpdir(), 's13-rv-roots-')))
const root = path.join(sandbox, 'inbox')
await mkdir(root)
await writeFile(path.join(root, 'synthetic.txt'), 'root identity fixture')
const helper = new WindowsPlatformHelper()
const records = []
async function test(name, work) { try { records.push({ name, result: 'pass', detail: await work() }) } catch (error) { records.push({ name, result: 'fail', detail: String(error) }); process.exitCode = 1 } }
const env = { LOCALAPPDATA: path.join(sandbox, 'private-appdata') }
try {
  const initial = await qualifyRoot(root, helper, { unmanaged: true, env: {} })
  assert.equal(initial.writeOk, true)
  await test('qualification performs no write probe', async () => { assert.deepEqual(await readdir(root), ['synthetic.txt']); return initial.rootId })
  await test('unmanaged declaration required for native writes', async () => { const q = await qualifyRoot(root, helper, { unmanaged: false, env: {} }); assert.equal(q.writeOk, false); return q.notes })
  await test('junction root refused without following target for mutation', async () => { const junction = path.join(sandbox, 'junction'); await symlink(root, junction, 'junction'); const q = await qualifyRoot(junction, helper, { unmanaged: true, env: {} }); assert.equal(q.writeOk, false); return q.reasons })
  await registerRoot(initial.rootId, root, new Date().toISOString(), env, helper)
  const adapter = new NodeFs({ root, rootId: initial.rootId, writesEnabled: true, identityQualified: true, helper })
  const renamed = path.join(sandbox, 'renamed-inbox')
  await rename(root, renamed)
  await test('renamed root retains qualified identity and registered history', async () => { const q = await qualifyRoot(renamed, helper, { unmanaged: true, env: {} }); assert.equal(q.rootId, initial.rootId); const record = await registerRoot(q.rootId, renamed, new Date().toISOString(), env, helper); assert.ok(record.pathHints.includes(root)); assert.ok(record.pathHints.includes(renamed)); return q.rootId })
  await mkdir(root)
  await test('recreated path cannot reuse old adapter mutation authority', async () => { const q = await qualifyRoot(root, helper, { unmanaged: true, env: {} }); assert.notEqual(q.rootId, initial.rootId); await assert.rejects(adapter.mkdir('must-not-appear'), /identity changed/); assert.deepEqual(await readdir(root), []); const hints = await rootsHintingPath(root, q.rootId, env, helper); assert.ok(hints.includes(initial.rootId)); return hints })
  records.push({ name: 'real cross-volume/remount refusal', result: 'not-run', detail: 'No second designated disposable volume is authorized/available; no simulated native pass.' })
} finally {
  await helper.close()
  const report = { candidate: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sandbox, records }
  await writeFile(`evals/native-roots-result-${Date.now()}.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}
