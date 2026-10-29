import { spawn } from 'node:child_process'
import type { PlatformHelper } from './platform/helper.js'
import { constants as fsConstants } from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { JournalStore } from '../src/core/fs-port.js'
import { isWithin } from './within.js'

// Private CLI state outside the selected root (PLAN §7):
//   %LOCALAPPDATA%\file-declutterer\<rootId>\root.json         path hints (never authority)
//   %LOCALAPPDATA%\file-declutterer\<rootId>\runs\<runId>\     plan.json, journal.jsonl, preserved copies
//   %LOCALAPPDATA%\file-declutterer\<rootId>\LOCK               root lock marker (cli/lock.ts)
// Qualified native state uses explicit local-user ACLs on new directories, checks existing
// ACLs, and flushes directory metadata through the helper. index.json is derived only.

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
  return isWithin(path.resolve(stateDir), path.resolve(rootPath))
}

/** Inspect every existing component before private state IO. Never follow a state link. */
async function assertStatePath(target: string, helper?: PlatformHelper): Promise<void> {
  const full = path.resolve(target)
  const parsed = path.parse(full)
  let current = parsed.root
  for (const part of full.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    try {
      const info = await fsp.lstat(current)
      if (info.isSymbolicLink()) throw new Error('Private state link/reparse path refused.')
      if (info.isFile() && info.nlink !== 1) throw new Error('Multiply-linked private state refused.')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (helper) {
          const facts = await helper.components(path.dirname(current))
          if (!facts.length || facts.some((c) => c.reparse || c.cloudPlaceholder)) throw new Error('Unqualified private-state ancestry.')
        }
        return
      }
      throw error
    }
  }
  if (helper) {
    const facts = await helper.components(full)
    if (!facts.length || facts.some((c) => c.reparse || c.cloudPlaceholder)) throw new Error('Unqualified private-state ancestry.')
  }
}

const ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  $request = [Console]::In.ReadLine() | ConvertFrom-Json
  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $item = Get-Item -LiteralPath $request.path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse state directory' }
  if ($request.created) {
    $acl = [System.Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $request.path -AclObject $acl
  }
  $acl = Get-Acl -LiteralPath $request.path
  if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'State owner mismatch' }
  foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')) { throw 'State directory permits another principal' }
  }
  [Console]::Out.WriteLine('private-state-acl-ok')
} catch { [Console]::Error.WriteLine('Private state ACL validation failed'); exit 1 }
`

async function privateAcl(dir: string, created: boolean): Promise<void> {
  if (process.platform !== 'win32') {
    if (((await fsp.stat(dir)).mode & 0o077) !== 0) throw new Error('Private state permissions are too broad.')
    return
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ACL_SCRIPT, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false })
    let output = ''
    const timer = setTimeout(() => { child.stdin.end(); child.kill(); reject(new Error('Private state ACL check timed out.')) }, 30_000)
    child.stdout.on('data', (chunk) => { output += String(chunk); if (output.length > 1024) child.stdin.end() })
    child.stderr.on('data', () => { /* no arbitrary script stderr in user logs */ })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('exit', (code) => { clearTimeout(timer); code === 0 && output.trim() === 'private-state-acl-ok' ? resolve() : reject(new Error('Private state ACL validation failed.')) })
    child.stdin.end(JSON.stringify({ path: dir, created }) + '\n')
  })
}

/** Create only missing app directories; secure new directories, validate existing ones. */
export async function ensurePrivateStateDirectory(dir: string, helper?: PlatformHelper): Promise<void> {
  await assertStatePath(dir)
  const missing: string[] = []
  let parent = path.resolve(dir)
  for (;;) {
    try { if (!(await fsp.lstat(parent)).isDirectory()) throw new Error('State parent is not a directory.'); break }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; missing.push(parent); parent = path.dirname(parent) }
  }
  for (const item of missing.reverse()) {
    await fsp.mkdir(item, { mode: 0o700 })
    if (helper) { await privateAcl(item, true); await helper.flushDirectory(path.dirname(item)) }
  }
  await assertStatePath(dir, helper)
  if (helper) await privateAcl(dir, false)
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
async function fsyncDir(dir: string, helper?: PlatformHelper): Promise<void> {
  if (helper) { await helper.flushDirectory(dir); return }
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
export async function registerRoot(rootId: string, rootPath: string, now: string, env?: NodeJS.ProcessEnv, helper?: PlatformHelper): Promise<RootRecord> {
  const dir = rootStateDir(rootId, env)
  await ensurePrivateStateDirectory(path.join(dir, 'runs'), helper)
  const file = path.join(dir, 'root.json')
  let record: RootRecord = { rootId, pathHints: [], firstSeen: now, lastSeen: now }
  await assertStatePath(file, helper)
  try {
    const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as RootRecord
    if (parsed.rootId !== rootId || !Array.isArray(parsed.pathHints) || parsed.pathHints.some((p) => typeof p !== 'string') || typeof parsed.firstSeen !== 'string') throw new Error('Invalid root registration; existing evidence preserved.')
    record = { ...parsed, lastSeen: now }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (!record.pathHints.includes(rootPath)) record.pathHints = [...record.pathHints, rootPath].slice(-10)
  const tmp = `${file}.${process.pid}.tmp`
  await assertStatePath(file, helper)
  await fsp.writeFile(tmp, JSON.stringify(record, null, 2), { encoding: 'utf8', flag: 'wx' })
  await fsyncFile(tmp)
  await fsp.rename(tmp, file)
  await fsyncDir(dir, helper)
  return record
}

/**
 * Other roots whose hints name this path. A root that was recreated or remounted at the same
 * path has a different identity; history is not guessed across that boundary.
 */
export async function rootsHintingPath(rootPath: string, exceptRootId: string, env?: NodeJS.ProcessEnv, helper?: PlatformHelper): Promise<string[]> {
  const base = stateBase(env)
  let entries: string[] = []
  try {
    entries = await fsp.readdir(base)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const out: string[] = []
  for (const id of entries) {
    if (id === exceptRootId || !SAFE_ID.test(id)) continue
    try {
      const file = path.join(base, id, 'root.json')
      await assertStatePath(file, helper)
      const rec = JSON.parse(await fsp.readFile(file, 'utf8')) as RootRecord
      if (rec.rootId !== id || !Array.isArray(rec.pathHints) || rec.pathHints.some((p) => typeof p !== 'string')) throw new Error('Unverifiable root hint')
      if (rec.pathHints.some((p) => p.toLowerCase() === rootPath.toLowerCase())) out.push(id)
    } catch {
      // Unknown history may name this path; never silently clear an ambiguity gate.
      out.push(`unverifiable:${id}`)
    }
  }
  return out
}

export class FileJournalStore implements JournalStore {
  private readonly runsDir: string

  constructor(stateDir: string, private readonly helper?: PlatformHelper) {
    this.runsDir = path.join(stateDir, 'runs')
  }

  private runDir(runId: string): string {
    if (!SAFE_ID.test(runId)) throw new Error(`Unsafe run id ${runId}`)
    return path.join(this.runsDir, runId)
  }

  async listRuns(): Promise<string[]> {
    await assertStatePath(this.runsDir, this.helper)
    let names: string[] = []
    try {
      names = (await fsp.readdir(this.runsDir)).filter((n) => SAFE_ID.test(n))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
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
      const file = path.join(this.runDir(runId), 'plan.json')
      await assertStatePath(file, this.helper)
      return await fsp.readFile(file, 'utf8')
    } catch {
      return null
    }
  }

  async writePlan(runId: string, text: string): Promise<void> {
    const dir = this.runDir(runId)
    await ensurePrivateStateDirectory(dir, this.helper)
    const file = path.join(dir, 'plan.json')
    await assertStatePath(file, this.helper)
    const handle = await fsp.open(file, 'wx')
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fsyncDir(dir, this.helper)
  }

  async readJournal(runId: string): Promise<string | null> {
    try {
      const file = path.join(this.runDir(runId), 'journal.jsonl')
      await assertStatePath(file, this.helper)
      return await fsp.readFile(file, 'utf8')
    } catch {
      return null
    }
  }

  async appendJournal(runId: string, line: string): Promise<void> {
    const file = path.join(this.runDir(runId), 'journal.jsonl')
    await assertStatePath(file, this.helper)
    const handle = await fsp.open(file, 'a')
    try {
      await handle.write(line, null, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fsyncDir(path.dirname(file), this.helper)
  }

  async preserveJournal(runId: string, label: string): Promise<string> {
    const dir = this.runDir(runId)
    await assertStatePath(path.join(dir, 'journal.jsonl'), this.helper)
    for (let n = 1; ; n++) {
      const name = `journal.${label}-${n}.jsonl`
      try {
        await fsp.copyFile(path.join(dir, 'journal.jsonl'), path.join(dir, name), fsConstants.COPYFILE_EXCL)
        await fsyncFile(path.join(dir, name))
        await fsyncDir(dir, this.helper)
        return name
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
  }

  async replaceJournal(runId: string, text: string): Promise<void> {
    const dir = this.runDir(runId)
    await assertStatePath(path.join(dir, 'journal.jsonl'), this.helper)
    const tmp = path.join(dir, `journal.${process.pid}.tmp`)
    await fsp.writeFile(tmp, text, { encoding: 'utf8', flag: 'wx' })
    await fsyncFile(tmp)
    // Private state only: an atomic replace of the app's own journal, never a user file.
    await fsp.rename(tmp, path.join(dir, 'journal.jsonl'))
    await fsyncDir(dir, this.helper)
  }
}
