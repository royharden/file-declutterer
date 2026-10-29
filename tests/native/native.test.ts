import { createHash } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NodeFs } from '../../cli/node-fs'
import { loadPlatformHelper } from '../../cli/platform/helper'
import { qualifyRoot } from '../../cli/qualify'
import { FileJournalStore } from '../../cli/state'
import { InterruptError } from '../../src/core/fs-port'
import { heuristicProposals } from '../../src/core/heuristic'
import { approve, buildPlan } from '../../src/core/plan'
import { applyPlan, reverseRun } from '../../src/core/runs'
import { scanRoot } from '../../src/core/scan'
import { DEFAULT_ROOT_CONFIG } from '../../src/core/scan-policy'
import { buildOrganizeRows, defaultSelection, observeDestinations, validateRows, type PlanRow } from '../../src/core/validate'

// Explicit disposable-root native harness (npm run test:native). Each test makes a fresh
// folder under the OS temp directory and a separate private state folder; it never touches
// Downloads, OneDrive or this source tree. These tests exercise the shared executor over the
// real file system with writes forced on for the disposable root only. They are NOT native
// qualification: T24-T27, T31 and T38 need the platform helper and stay pending below.

const config = DEFAULT_ROOT_CONFIG
let root = ''
let state = ''

async function write(rel: string, text: string): Promise<void> {
  const full = path.join(root, ...rel.split('/'))
  await fsp.mkdir(path.dirname(full), { recursive: true })
  await fsp.writeFile(full, text, 'utf8')
}

async function manifest(): Promise<string> {
  const out: string[] = []
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) await walk(path.join(dir, e.name), r)
      else out.push(`${r}:${await fsp.readFile(path.join(dir, e.name), 'utf8')}`)
    }
  }
  await walk(root, '')
  return out.sort().join('\n')
}

let rootId = ''

function nodeFs(): NodeFs {
  return new NodeFs({ root, rootId, writesEnabled: true, identityQualified: true })
}

async function approvedPlan(fs: NodeFs, planId: string) {
  const scan = await scanRoot(fs, { scanId: `scan-${planId}` })
  const extOf = (id: string) => scan.files.find((f) => f.id === id)?.ext ?? ''
  const validate = async (rows: PlanRow[]) => validateRows(rows, { kind: 'organize', config, existing: await observeDestinations(fs, rows), extOf })
  const rows = await validate(defaultSelection(await validate(buildOrganizeRows(scan, { accepted: heuristicProposals(scan), rejected: [], fatal: null }, 'heuristic', 'n', config))))
  const plan = buildPlan({ planId, kind: 'organize', scan, config, rows })
  return { plan, approval: approve(plan, 'native-test') }
}

beforeEach(async () => {
  // realpath: the temp dir may be reported through an 8.3 short name.
  root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'declutter-root-')))
  const info = await fsp.lstat(root, { bigint: true })
  rootId = `r-${createHash('sha256').update(`${info.dev}:${info.ino}`).digest('hex').slice(0, 16)}`
  state = await fsp.mkdtemp(path.join(os.tmpdir(), 'declutter-state-'))
  await write('report.pdf', 'pdf bytes')
  await write('photo.jpg', 'jpg bytes')
  await write('Downloads/song.mp3', 'mp3 bytes')
  await write('proj/package.json', '{}')
  await write('proj/index.js', 'code')
})

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true })
  await fsp.rm(state, { recursive: true, force: true })
})

describe('native executor on a disposable root', () => {
  it('applies with hard links, then undoes to the exact manifest', async () => {
    const before = await manifest()
    const fs = nodeFs()
    const store = new FileJournalStore(state)
    const { plan, approval } = await approvedPlan(fs, 'n1')
    const report = await applyPlan({ fs, store }, plan, approval)
    expect(report.status).toBe('committed')
    expect(await manifest()).toContain('_Organized/Documents/report.pdf:pdf bytes')
    expect(await manifest()).toContain('proj/index.js:code')
    const undone = await reverseRun({ fs, store }, 'n1', 'undo')
    expect(undone.status).toBe('undone')
    expect(await manifest()).toBe(before)
  })

  it('recovers from interruption at every apply boundary (T15 native)', async () => {
    const before = await manifest()
    let n = 1
    for (;;) {
      const fs = nodeFs()
      const store = new FileJournalStore(path.join(state, `s${n}`))
      const { plan, approval } = await approvedPlan(fs, `n-${n}`)
      let seen = 0
      let interrupted = false
      try {
        await applyPlan({ fs, store, checkpoint: (b) => { if (++seen === n) throw new InterruptError(b) } }, plan, approval)
      } catch (e) {
        if (!(e instanceof InterruptError)) throw e
        interrupted = true
      }
      const report = interrupted ? await reverseRun({ fs, store }, `n-${n}`, 'rollback') : await reverseRun({ fs, store }, `n-${n}`, 'undo')
      expect(['rolled_back', 'undone']).toContain(report.status)
      expect(await manifest(), `boundary ${n}`).toBe(before)
      if (!interrupted) break
      n++
    }
  })

  it('never overwrites an occupied destination (T03 native)', async () => {
    await write('_Organized/Documents/report.pdf', 'someone else')
    const fs = nodeFs()
    const { plan } = await approvedPlan(fs, 'n3')
    expect(plan.rows.some((r) => r.from === 'report.pdf')).toBe(false)
    expect(await fsp.readFile(path.join(root, '_Organized', 'Documents', 'report.pdf'), 'utf8')).toBe('someone else')
  })

  it('refuses writes when the adapter is not write-enabled', async () => {
    const fs = new NodeFs({ root, rootId, writesEnabled: false, identityQualified: false })
    await expect(fs.mkdir('x')).rejects.toThrow(/disabled/)
  })

  it('qualification never writes and keeps writes off without the helper (T25 partial)', async () => {
    const before = await manifest()
    const q = await qualifyRoot(root, loadPlatformHelper(), { unmanaged: true })
    expect(q.writeOk).toBe(false)
    expect(await manifest()).toBe(before)
  })
})

describe('native qualification cases (need the platform helper)', () => {
  it.todo('T24 concurrent runs/recoveries admit one owner under the root mutex')
  it.todo('T25 network, sync, FAT/exFAT and unknown-identity roots refused without write probes')
  it.todo('T26 junction or replaced ancestor and cross-volume targets refused')
  it.todo('T27 renamed/remounted/recreated root finds history or refuses ambiguity')
  it.todo('T31 built bin round trip: node dist-cli/main.js --help and read-only validate')
  it.todo('T38 stale LOCK retirement cannot remove a successor; helper loss halts')
})
