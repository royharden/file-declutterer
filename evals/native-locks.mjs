// Actual Windows helper/ACL/root-LOCK checks; retain all newly created synthetic state.
import assert from 'node:assert/strict'
import { mkdtemp, realpath, mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir, hostname } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { WindowsPlatformHelper } from '../dist-cli/cli/platform/windows-native.js'
import { qualifiedRootId } from '../dist-cli/cli/qualify.js'
import { ensurePrivateStateDirectory } from '../dist-cli/cli/state.js'
import { acquireRootLock } from '../dist-cli/cli/lock.js'

const root = await realpath(await mkdtemp(path.join(tmpdir(), 's13-rv-locks-')))
const records = []
const helpers = []
function helper() { const h = new WindowsPlatformHelper(); helpers.push(h); return h }
async function test(name, work) { try { records.push({ name, result: 'pass', detail: await work() }) } catch (error) { records.push({ name, result: 'fail', detail: String(error) }); process.exitCode = 1 } }
const h = helper()
const rootId = qualifiedRootId(await h.fileId(root))
async function state(name) { const dir = path.join(root, name); await ensurePrivateStateDirectory(dir, h); return dir }
function marker(token, epoch) { return { token, rootId, host: hostname(), pid: process.pid, processStart: epoch, acquiredAt: new Date().toISOString() } }
try {
  await test('real mutex excludes concurrent owner; stale release preserves successor', async () => {
    const dir = await state('concurrent')
    const first = await acquireRootLock(dir, rootId, h)
    const other = helper()
    await assert.rejects(acquireRootLock(dir, rootId, other), /held by another/)
    await first.release()
    const next = await acquireRootLock(dir, rootId, other)
    await first.release()
    await next.assert()
    assert.equal(JSON.parse(await readFile(path.join(dir, 'LOCK'), 'utf8')).token, next.owner.token)
    await next.release()
    return 'successor marker survived old owner release'
  })
  await test('fresh assertion and release preserve replacement marker', async () => {
    const dir = await state('replacement')
    const lock = await acquireRootLock(dir, rootId, h)
    const replacement = { ...lock.owner, token: 'b'.repeat(32) }
    await writeFile(path.join(dir, 'LOCK'), JSON.stringify(replacement))
    await assert.rejects(lock.assert(), /no longer names/)
    await lock.release()
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'LOCK'), 'utf8')), replacement)
    return 'replacement not unlinked by original owner'
  })
  await test('PID epoch mismatch is never timeout-stolen', async () => {
    const dir = await state('pid-reuse')
    const text = JSON.stringify(marker('c'.repeat(32), 'different-start-epoch'))
    await writeFile(path.join(dir, 'LOCK'), text)
    await assert.rejects(acquireRootLock(dir, rootId, h), /different process/)
    assert.equal(await readFile(path.join(dir, 'LOCK'), 'utf8'), text)
    return 'mismatched process-start evidence preserved'
  })
  await test('dead owner retirement retains evidence under actual root mutex', async () => {
    const dir = await state('dead-owner')
    const old = { ...marker('d'.repeat(32), 'old-start'), pid: 2147483647 }
    await writeFile(path.join(dir, 'LOCK'), JSON.stringify(old))
    const acquired = await acquireRootLock(dir, rootId, h)
    assert.equal(acquired.retired.token, old.token)
    const files = await readdir(dir)
    const retired = files.find(name => name.startsWith('LOCK.retired-'))
    assert.deepEqual(JSON.parse(await readFile(path.join(dir, retired), 'utf8')), old)
    await acquired.release()
    return retired
  })
  await test('helper communication loss halts ownership assertion', async () => {
    const owner = helper()
    const dir = await state('helper-loss')
    const lock = await acquireRootLock(dir, rootId, owner)
    const evidence = await readFile(path.join(dir, 'LOCK'), 'utf8')
    await owner.close()
    await assert.rejects(lock.assert(), /mutex lost/)
    assert.equal(await readFile(path.join(dir, 'LOCK'), 'utf8'), evidence)
    return 'abandoned marker retained; mutation authority lost immediately'
  })
} finally {
  for (const item of helpers) await item.close().catch(() => {})
  const report = { candidate: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), root, records }
  await writeFile(`evals/native-locks-result-${Date.now()}.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}
