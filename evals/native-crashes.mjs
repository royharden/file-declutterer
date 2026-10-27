// No user files, no cleanup/deletion: synthetic test roots and private evidence are retained.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, realpath, writeFile, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const driver = fileURLToPath(new URL('./native-command.mjs', import.meta.url))
const observations = []
const bytes = Buffer.from([0, 255, 128, 17, 0, 81, 13, 10])
const trials = []
async function setup() {
  const sandbox = await realpath(await mkdtemp(path.join(tmpdir(), 's13-rv-crash-')))
  await mkdir(path.join(sandbox, 'inbox'))
  await writeFile(path.join(sandbox, 'inbox', 'report.pdf'), bytes)
  trials.push(sandbox)
  return sandbox
}
function command(sandbox, action, crash = 0) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [driver, sandbox, action, String(crash)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Owned child timeout: ${action}; ${err}`)) }, 90000)
    child.stdout.on('data', data => { out += data })
    child.stderr.on('data', data => { err += data })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (crash) resolve({ code, signal, out, err })
      else if (code !== 0) reject(new Error(`Command ${action} failed ${code}: ${err}`))
      else resolve(JSON.parse(out.trim()))
    })
  })
}
async function manifest(sandbox) {
  const records = []
  async function walk(dir, prefix = '') {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix + item.name
      if (item.isDirectory()) await walk(path.join(dir, item.name), rel + '/')
      else records.push([rel, (await readFile(path.join(dir, item.name))).toString('hex')])
    }
  }
  await walk(path.join(sandbox, 'inbox'))
  return records.sort((a, b) => a[0].localeCompare(b[0]))
}
try {
  const probe = await setup()
  const before = await manifest(probe)
  const applied = await command(probe, 'apply')
  assert.equal(applied.report.status, 'committed')
  const reversed = await command(probe, 'undo')
  assert.equal(reversed.report.status, 'undone')
  assert.deepEqual(await manifest(probe), before)
  observations.push({ name: 'actual helper + ACL + mutex + flushed state apply/undo', result: 'pass', applyBoundaries: applied.boundaries.length, reverseBoundaries: reversed.boundaries.length, sandbox: probe })
  console.log(JSON.stringify(observations.at(-1)))
  for (let n = 1; n <= applied.boundaries.length; n++) {
    const sandbox = await setup()
    const original = await manifest(sandbox)
    const killed = await command(sandbox, 'apply', n)
    assert.notEqual(killed.code, 0, `apply boundary ${n} was not terminated`)
    const recovery = await command(sandbox, 'rollback')
    assert.equal(recovery.report.status, 'rolled_back', `apply boundary ${n}`)
    assert.deepEqual(await manifest(sandbox), original, `apply boundary ${n}`)
    const record = { name: `process termination at apply boundary ${n}`, boundary: applied.boundaries[n - 1], result: 'pass', retired: recovery.retired, sandbox }
    observations.push(record); console.log(JSON.stringify(record))
  }
  for (let n = 1; n <= reversed.boundaries.length; n++) {
    const sandbox = await setup()
    const original = await manifest(sandbox)
    await command(sandbox, 'apply')
    const killed = await command(sandbox, 'undo', n)
    assert.notEqual(killed.code, 0, `undo boundary ${n} was not terminated`)
    const retry = await command(sandbox, 'undo')
    assert.equal(retry.report.status, 'undone', `undo boundary ${n}`)
    assert.deepEqual(await manifest(sandbox), original, `undo boundary ${n}`)
    const record = { name: `process termination at undo boundary ${n}`, boundary: reversed.boundaries[n - 1], result: 'pass', sandbox }
    observations.push(record); console.log(JSON.stringify(record))
  }
} catch (error) {
  observations.push({ name: 'native crash evaluation stopped', result: 'fail', detail: String(error) })
  console.log(JSON.stringify(observations.at(-1))); process.exitCode = 1
} finally {
  await writeFile(`evals/native-crashes-result-${Date.now()}.json`, JSON.stringify({ candidate: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), observations, trials }, null, 2))
}
