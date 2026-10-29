// Actual NTFS metadata-only conflict and explicit retry, on RV-created synthetic files.
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtemp, realpath, mkdir, writeFile, readFile, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const sandbox = await realpath(await mkdtemp(path.join(tmpdir(), 's13-rv-crash-')))
await mkdir(path.join(sandbox, 'inbox'))
const original = path.join(sandbox, 'inbox', 'report.pdf')
const destination = path.join(sandbox, 'inbox', '_Organized', 'Documents', 'report.pdf')
const bytes = Buffer.from([0, 255, 128, 17, 0, 81, 13, 10])
await writeFile(original, bytes)
const driver = fileURLToPath(new URL('./native-command.mjs', import.meta.url))
const commands = []
function command(action) {
  const result = spawnSync(process.execPath, [driver, sandbox, action], { encoding: 'utf8', timeout: 90000, windowsHide: true })
  if (result.error) throw result.error
  const entry = { action, code: result.status, stdout: result.stdout, stderr: result.stderr }
  commands.push(entry)
  return result.status === 0 ? JSON.parse(result.stdout.trim()) : null
}
let result = 'pass', error = null
try {
  assert.equal(command('apply').report.status, 'committed')
  const before = await stat(destination, { bigint: true })
  await utimes(destination, new Date(Number(before.atimeMs)), new Date(Number(before.mtimeMs) + 1000))
  const changed = await stat(destination, { bigint: true })
  assert.equal(changed.ino, before.ino)
  assert.equal(changed.size, before.size)
  assert.notEqual(changed.mtimeMs, before.mtimeMs)
  assert.deepEqual(await readFile(destination), bytes)
  const refused = command('undo')
  assert.equal(refused.report.status, 'needs_attention')
  assert.equal(refused.report.counts.unresolved, 1)
  assert.deepEqual(await readFile(destination), bytes)
  await utimes(destination, new Date(Number(before.atimeMs)), new Date(Number(before.mtimeMs)))
  assert.equal(command('undo').report.status, 'undone')
  assert.deepEqual(await readFile(original), bytes)
  assert.equal(command('undo'), null, 'a completed run cannot execute a second undo')
  assert.deepEqual(await readFile(original), bytes)
} catch (failure) { result = 'fail'; error = String(failure); process.exitCode = 1 }
await writeFile(`evals/native-metadata-result-${Date.now()}.json`, JSON.stringify({ candidate: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sandbox, result, error, commands }, null, 2))
console.log(JSON.stringify({ sandbox, result, error }))
