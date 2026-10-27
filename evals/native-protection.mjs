// T07 actual NTFS attributes. Only new, synthetic files; no credential names or cleanup.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WindowsPlatformHelper } from '../dist-cli/cli/platform/windows-native.js'
import { qualifyRoot } from '../dist-cli/cli/qualify.js'
import { NodeFs } from '../dist-cli/cli/node-fs.js'
import { scanRoot } from '../dist-cli/src/core/scan.js'

const root = await realpath(await mkdtemp(path.join(tmpdir(), 's13-rv-protection-')))
const hidden = path.join(root, 'hidden-system.pdf')
await writeFile(hidden, 'synthetic attribute-protected bytes')
await writeFile(path.join(root, 'ordinary.pdf'), 'synthetic ordinary bytes')
await writeFile(path.join(root, 'README-private.txt'), 'synthetic protected notice')
await mkdir(path.join(root, 'project'))
await writeFile(path.join(root, 'project', 'package.json'), '{}')
await writeFile(path.join(root, 'project', 'source.txt'), 'synthetic project')
execFileSync('attrib.exe', ['+H', '+S', hidden])
const attributes = execFileSync('attrib.exe', [hidden], { encoding: 'utf8' }).trim()
const helper = new WindowsPlatformHelper()
let report
try {
  const q = await qualifyRoot(root, helper, { unmanaged: true, env: {} })
  assert.equal(q.readOk, true)
  const fs = new NodeFs({ root, rootId: q.rootId, writesEnabled: false, identityQualified: true, helper })
  const hashed = []
  const hash = fs.sha256.bind(fs)
  fs.sha256 = async rel => { hashed.push(rel); return hash(rel) }
  const scan = await scanRoot(fs, { scanId: 'rv-native-protection' })
  report = { candidate: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), root, attributes, hashed, scan }
  assert.match(attributes, /H/)
  assert.match(attributes, /S/)
  assert.deepEqual(hashed, ['ordinary.pdf'], 'Hidden/System attribute file must never be hashed or offered')
  report.result = 'pass'
} catch (error) { report = { ...report, result: 'fail', error: String(error) }; process.exitCode = 1 }
finally {
  await helper.close()
  await writeFile(`evals/native-protection-result-${Date.now()}.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}
