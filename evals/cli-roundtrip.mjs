import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtemp, realpath, mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
const sandbox = await realpath(await mkdtemp(path.join(tmpdir(), 's13-rv-cli-')))
const root = path.join(sandbox, 'inbox')
await mkdir(root)
const bytes = Buffer.from([1, 0, 255, 129, 0])
await writeFile(path.join(root, 'report.pdf'), bytes)
const planPath = path.join(sandbox, 'review-plan.json')
const env = { ...process.env, LOCALAPPDATA: path.join(sandbox, 'private-appdata') }
const records = []
function run(args) {
  const result = spawnSync(process.execPath, ['dist-cli/main.js', ...args], { env, encoding: 'utf8', timeout: 30000, windowsHide: true })
  records.push({ args, status: result.status, stdout: result.stdout, stderr: result.stderr })
  if (result.error) throw result.error
  return result
}
try {
  assert.equal(run(['--help']).status, 0)
  const qualification = run(['qualify', root, '--unmanaged'])
  assert.equal(qualification.status, 0)
  assert.match(qualification.stdout, /read-only: yes; native writes: no/)
  assert.equal(run(['scan', root, '--unmanaged']).status, 0)
  assert.equal(run(['propose', root, '--unmanaged', '--mode', 'heuristic', '--out', planPath]).status, 0)
  const plan = JSON.parse(await readFile(planPath, 'utf8'))
  assert.equal(plan.profile, 'native')
  assert.equal(plan.rows.length, 1)
  assert.equal(run(['validate', root, '--unmanaged', '--plan', planPath]).status, 0)
  const refused = run(['apply', root, '--plan', planPath, '--confirm', plan.digest, '--unmanaged'])
  assert.notEqual(refused.status, 0)
  assert.match(refused.stderr, /native writes are not available/i)
  assert.deepEqual(await readdir(root), ['report.pdf'])
  assert.deepEqual(await readFile(path.join(root, 'report.pdf')), bytes)
  console.log('PASS CLI help/qualify/scan/propose/export/validate; production mutation gate refuses apply without changes')
} catch (error) { records.push({ error: String(error) }); process.exitCode = 1 }
await writeFile(`evals/cli-roundtrip-result-${Date.now()}.json`, JSON.stringify({ candidate: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sandbox, records }, null, 2))
