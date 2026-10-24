import { constants as fsConstants } from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { JournalStore } from '../src/core/fs-port.js'

// Private CLI state outside the selected root (PLAN §7):
//   %LOCALAPPDATA%\file-declutterer\<rootId>\root.json         path hints (never authority)
//   %LOCALAPPDATA%\file-declutterer\<rootId>\runs\<runId>\     plan.json, journal.jsonl, preserved copies
//   %LOCALAPPDATA%\file-declutterer\<rootId>\LOCK               root lock marker (cli/lock.ts)
// The per-user profile directory already restricts access to the local user; ACLs are not
// changed here (deferred review item). index.json is never written: run listings are derived.

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

export function stateBase(env: NodeJS.ProcessEnv = process.env): string {
  const local = env.LOCALAPPDATA
  if (local) return path.join(local, 'file-declutterer')
  return path.join(os.homedir(), '.local', 'state', 'file-declutterer')
}

export function rootStateDir(rootId: string, env?: NodeJS.ProcessEnv): string {
  if (!SAFE_ID.test(rootId)) throw new Error(`Unsafe root id ${rootId}`)
  return path.join(stateBase(env), rootId)
}

/** True when the state directory would sit inside the selected root (refused). */
export function stateInsideRoot(rootPath: string, stateDir: string): boolean {
  const rel = path.relative(path.resolve(rootPath), path.resolve(stateDir))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

async function fsyncFile(file: string): Promise<void> {
  const handle = await fsp.open(file, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Best-effort directory flush; Windows does not support fsync on directories through Node. */
async function fsyncDir(dir: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await fsp.open(dir, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export interface RootRecord {
  rootId: string
  pathHints: string[]
  firstSeen: string
  lastSeen: string
}

/** Register or refresh path hints for a root. Hints never reassociate history by themselves. */
export async function registerRoot(rootId: string, rootPath: string, now: string, env?: NodeJS.ProcessEnv): Promise<RootRecord> {
  const dir = rootStateDir(rootId, env)
  await fsp.mkdir(path.join(dir, 'runs'), { recursive: true })
  const file = path.join(dir, 'root.json')
  let record: RootRecord = { rootId, pathHints: [], firstSeen: now, lastSeen: now }
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as RootRecord
    if (parsed.rootId === rootId && Array.isArray(parsed.pathHints)) record = { ...parsed, lastSeen: now }
  } catch {
    // First registration, or an unreadable hint file (hints are not authority).
  }
  if (!record.pathHints.includes(rootPath)) record.pathHints = [...record.pathHints, rootPath].slice(-10)
  const tmp = `${file}.${process.pid}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(record, null, 2), 'utf8')
  await fsyncFile(tmp)
  await fsp.rename(tmp, file)
  await fsyncDir(dir)
  return record
}

/**
 * Other roots whose hints name this path. A root that was recreated or remounted at the same
 * path has a different identity; history is not guessed across that boundary.
 */
export async function rootsHintingPath(rootPath: string, exceptRootId: string, env?: NodeJS.ProcessEnv): Promise<string[]> {
  const base = stateBase(env)
  let entries: string[] = []
  try {
    entries = await fsp.readdir(base)
  } catch {
    return []
  }
  const out: string[] = []
  for (const id of entries) {
    if (id === exceptRootId || !SAFE_ID.test(id)) continue
    try {
      const rec = JSON.parse(await fsp.readFile(path.join(base, id, 'root.json'), 'utf8')) as RootRecord
      if (rec.pathHints.some((p) => p.toLowerCase() === rootPath.toLowerCase())) out.push(id)
    } catch {
      // Ignore unreadable hint files.
    }
  }
  return out
}

export class FileJournalStore implements JournalStore {
  private readonly runsDir: string

  constructor(stateDir: string) {
    this.runsDir = path.join(stateDir, 'runs')
  }

  private runDir(runId: string): string {
    if (!SAFE_ID.test(runId)) throw new Error(`Unsafe run id ${runId}`)
    return path.join(this.runsDir, runId)
  }

  async listRuns(): Promise<string[]> {
    let names: string[] = []
    try {
      names = (await fsp.readdir(this.runsDir)).filter((n) => SAFE_ID.test(n))
    } catch {
      return []
    }
    const withTime = await Promise.all(
      names.map(async (n) => {
        try {
          const st = await fsp.stat(path.join(this.runsDir, n, 'plan.json'))
          return { n, t: st.birthtimeMs || st.mtimeMs }
        } catch {
          return { n, t: Number.POSITIVE_INFINITY }
        }
      }),
    )
    return withTime.sort((a, b) => a.t - b.t || (a.n < b.n ? -1 : 1)).map((x) => x.n)
  }

  async readPlan(runId: string): Promise<string | null> {
    try {
      return await fsp.readFile(path.join(this.runDir(runId), 'plan.json'), 'utf8')
    } catch {
      return null
    }
  }

  async writePlan(runId: string, text: string): Promise<void> {
    const dir = this.runDir(runId)
    await fsp.mkdir(dir, { recursive: true })
    const file = path.join(dir, 'plan.json')
    const handle = await fsp.open(file, 'wx')
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fsyncDir(dir)
  }

  async readJournal(runId: string): Promise<string | null> {
    try {
      return await fsp.readFile(path.join(this.runDir(runId), 'journal.jsonl'), 'utf8')
    } catch {
      return null
    }
  }

  async appendJournal(runId: string, line: string): Promise<void> {
    const file = path.join(this.runDir(runId), 'journal.jsonl')
    const handle = await fsp.open(file, 'a')
    try {
      await handle.write(line, null, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  async preserveJournal(runId: string, label: string): Promise<string> {
    const dir = this.runDir(runId)
    for (let n = 1; ; n++) {
      const name = `journal.${label}-${n}.jsonl`
      try {
        await fsp.copyFile(path.join(dir, 'journal.jsonl'), path.join(dir, name), fsConstants.COPYFILE_EXCL)
        await fsyncFile(path.join(dir, name))
        await fsyncDir(dir)
        return name
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
  }

  async replaceJournal(runId: string, text: string): Promise<void> {
    const dir = this.runDir(runId)
    const tmp = path.join(dir, `journal.${process.pid}.tmp`)
    await fsp.writeFile(tmp, text, 'utf8')
    await fsyncFile(tmp)
    // Private state only: an atomic replace of the app's own journal, never a user file.
    await fsp.rename(tmp, path.join(dir, 'journal.jsonl'))
    await fsyncDir(dir)
  }
}
