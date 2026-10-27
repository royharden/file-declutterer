// Independent real-helper observation harness; retains synthetic artifacts, deletes nothing.
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, realpath, writeFile, mkdir, link, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const root = await realpath(await mkdtemp(path.join(tmpdir(), 's13-rv-facts-')))
const worker = fileURLToPath(new URL('../cli/platform/windows-worker.ps1', import.meta.url))
const records = []
const clients = []
function client() {
  const child = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', worker, '-ParentPid', String(process.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const pending = new Map()
  let id = 0
  child.stderr.on('data', () => {})
  createInterface({ input: child.stdout }).on('line', line => {
    const reply = JSON.parse(line)
    const entry = pending.get(reply.id)
    if (entry) { clearTimeout(entry.timer); pending.delete(reply.id); reply.ok ? entry.resolve(reply.value) : entry.reject(new Error(reply.error)) }
  })
  const api = { call(op, arg = '') {
    return new Promise((resolve, reject) => {
      const seq = ++id
      const timer = setTimeout(() => { pending.delete(seq); reject(new Error('RPC timeout')); child.stdin.end() }, 30000)
      pending.set(seq, { resolve, reject, timer })
      child.stdin.write(JSON.stringify({ id: seq, op, arg }) + '\n')
    })
  }, close() { child.stdin.end() } }
  clients.push(api)
  return api
}
async function test(name, work) {
  try { records.push({ name, result: 'pass', detail: await work() }) }
  catch (error) { records.push({ name, result: 'fail', detail: String(error) }); process.exitCode = 1 }
}
const a = client()
try {
  await writeFile(path.join(root, 'long-synthetic-filename.txt'), new Uint8Array([0, 255, 17, 0, 128]))
  await link(path.join(root, 'long-synthetic-filename.txt'), path.join(root, 'second.txt'))
  await test('volume is unmanaged local NTFS', async () => { const v = await a.call('volume', root); assert.equal(v.fileSystem, 'NTFS'); assert.equal(v.remote, false); return v })
  await test('full 128-bit identity agrees for hard links', async () => { const id = await a.call('fileId', path.join(root, 'second.txt')); assert.match(id, /^[a-f0-9]{16}:[a-f0-9]{32}$/); assert.equal(id, await a.call('fileId', path.join(root, 'long-synthetic-filename.txt'))); return id })
  await test('short alias is refused before canonicalization', async () => {
    const alias = await a.call('shortPath', root)
    if (alias.toLowerCase() === root.toLowerCase()) throw new Error('No alias available: case unverified')
    try { const actual = await a.call('components', alias); throw new Error(JSON.stringify({ root, alias, accepted: actual })) }
    catch (error) { assert.match(String(error), /alias refused/); return { root, alias } }
  })
  await test('junction flagged as reparse', async () => { await mkdir(path.join(root, 'target')); await symlink(path.join(root, 'target'), path.join(root, 'junction'), 'junction'); const facts = await a.call('components', path.join(root, 'junction')); assert.equal(facts.at(-1).reparse, true); return facts.at(-1) })
  await test('process epoch and absent PID', async () => { const epoch = await a.call('processStart', String(process.pid)); assert.match(epoch, /^\d+$/); assert.equal(await a.call('processStart', '2147483647'), null); return epoch })
  await test('mutex admits only one worker then successor', async () => { const id = path.basename(root); const name = await a.call('acquire', id); const b = client(); await assert.rejects(b.call('acquire', id), /held by another/); assert.equal(await a.call('held', name), true); await a.call('release', name); const successor = await b.call('acquire', id); assert.equal(successor, name); await b.call('release', successor); return name })
  await test('real directory flush', async () => { await a.call('flushDirectory', root); return 'FlushFileBuffers succeeded' })
} finally {
  for (const c of clients) c.close()
  const report = { candidate: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), root, records }
  await writeFile(`evals/native-facts-result-${Date.now()}.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}
