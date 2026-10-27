// Actual process crashes plus torn/corrupt/missing/foreign history; retain all synthetic evidence.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, realpath, writeFile, readFile, appendFile, readdir, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseJournal } from '../dist-cli/src/core/journal-codec.js'

const driver = fileURLToPath(new URL('./native-command.mjs', import.meta.url))
const records = []
const bytes = Buffer.from([0, 255, 128, 17, 0, 81, 13, 10])
async function setup() { const dir = await realpath(await mkdtemp(path.join(tmpdir(), 's13-rv-crash-'))); await mkdir(path.join(dir, 'inbox')); await writeFile(path.join(dir, 'inbox', 'report.pdf'), bytes); return dir }
const journal = dir => path.join(dir, 'private-state', 'runs', 'rv-native-run', 'journal.jsonl')
const destination = dir => path.join(dir, 'inbox', '_Organized', 'Documents', 'report.pdf')
function command(dir, action, crash = 0) { return new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [driver, dir, action, String(crash)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  const timer = setTimeout(() => { child.kill(); reject(new Error('owned command timeout')) }, 90000)
  child.stdout.on('data', data => { out += data }); child.stderr.on('data', data => { err += data })
  child.on('error', error => { clearTimeout(timer); reject(error) })
  child.on('exit', code => { clearTimeout(timer); if (crash) resolve({ code }); else if (code !== 0) reject(new Error(err)); else resolve(JSON.parse(out.trim())) })
}) }
async function test(name, work) { try { records.push({ name, result: 'pass', detail: await work() }) } catch (error) { records.push({ name, result: 'fail', detail: String(error) }); process.exitCode = 1 } console.log(JSON.stringify(records.at(-1))) }

await test('torn-tail continuation preserves evidence across a second actual process death', async () => {
  const dir = await setup()
  assert.notEqual((await command(dir, 'apply', 12)).code, 0)
  await appendFile(journal(dir), '{"torn":')
  const original = await readFile(journal(dir), 'utf8')
  assert.notEqual((await command(dir, 'rollback', 2)).code, 0)
  const runDir = path.dirname(journal(dir))
  const preserved = (await readdir(runDir)).filter(name => name.startsWith('journal.') && name !== 'journal.jsonl' && name.endsWith('.jsonl'))
  assert.ok(preserved.length > 0)
  assert.ok((await Promise.all(preserved.map(name => readFile(path.join(runDir, name), 'utf8')))).includes(original))
  const second = parseJournal(await readFile(journal(dir), 'utf8'))
  assert.equal(second.corrupt, null)
  assert.ok(second.records.some(record => record.type === 'continuation'))
  assert.equal((await command(dir, 'rollback')).report.status, 'rolled_back')
  assert.deepEqual(await readFile(path.join(dir, 'inbox', 'report.pdf')), bytes)
  return { dir, preserved }
})
await test('complete corrupt record blocks recovery and preserves linked-only paths', async () => {
  const dir = await setup()
  await command(dir, 'apply', 12)
  const text = await readFile(journal(dir), 'utf8')
  await writeFile(journal(dir), text.replace('"seq":0', '"seq":99'))
  const result = await command(dir, 'rollback')
  assert.equal(result.report.status, 'needs_attention')
  assert.deepEqual(await readFile(path.join(dir, 'inbox', 'report.pdf')), bytes)
  assert.deepEqual(await readFile(destination(dir)), bytes)
  return dir
})
await test('missing journal is lost evidence and cannot authorize reversal', async () => {
  const dir = await setup()
  await command(dir, 'apply', 12)
  await rename(journal(dir), path.join(path.dirname(journal(dir)), 'saved-missing-journal.jsonl'))
  const result = await command(dir, 'rollback')
  assert.equal(result.report.status, 'needs_attention')
  assert.deepEqual(await readFile(path.join(dir, 'inbox', 'report.pdf')), bytes)
  assert.deepEqual(await readFile(destination(dir)), bytes)
  return dir
})
await test('foreign destination after flushed intent remains untouched', async () => {
  const dir = await setup()
  await command(dir, 'apply', 11)
  const foreign = Buffer.from('synthetic foreign bytes')
  await writeFile(destination(dir), foreign, { flag: 'wx' })
  assert.equal((await command(dir, 'rollback')).report.status, 'rolled_back')
  assert.deepEqual(await readFile(path.join(dir, 'inbox', 'report.pdf')), bytes)
  assert.deepEqual(await readFile(destination(dir)), foreign)
  return dir
})
await writeFile(`evals/native-history-result-${Date.now()}.json`, JSON.stringify({ candidate: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), records }, null, 2))
