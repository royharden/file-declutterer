import { sha256Hex } from '../core/fingerprint.js'
import { FsError, joinPath, parentOf, type DirEntry, type FsPort, type JournalStore, type StatInfo } from '../core/fs-port.js'
import { compareKey } from '../core/paths.js'

// Byte-bearing in-memory file system for the hosted sandbox and pure tests. Case-insensitive
// and case-preserving like a default Windows volume: names collide by compareKey. Hard links
// share one inode, so link/verify/unlink behave like the native executor expects.
// Nothing here touches a real disk; reload loses everything.

interface Inode {
  id: number
  bytes: Uint8Array
  mtimeMs: number
}

type Node = { kind: 'file'; path: string; inode: Inode } | { kind: 'dir'; path: string; id: number }

export interface FaultPlan {
  /** Make the nth upcoming call of op fail with EIO (1 = next call). */
  op: 'link' | 'unlink' | 'mkdir' | 'rmdir' | 'sha256'
  nth: number
  path?: string
}

export class MemoryFs implements FsPort {
  readonly profile = 'sandbox' as const
  readonly rootDisplay: string
  private nodes = new Map<string, Node>()
  private nextId = 1
  private clock = Date.UTC(2026, 9, 1)
  private faults: (FaultPlan & { seen: number })[] = []

  constructor(
    readonly rootId: string = 'sandbox-root',
    rootDisplay = 'Sandbox (in memory)',
  ) {
    this.rootDisplay = rootDisplay
    this.nodes.set('', { kind: 'dir', path: '', id: 0 })
  }

  // ---- seeding and simulation helpers (not part of FsPort) ----

  tick(): number {
    this.clock += 1000
    return this.clock
  }

  mkdirp(path: string): void {
    let acc = ''
    for (const part of path.split('/')) {
      acc = joinPath(acc, part)
      const existing = this.nodes.get(compareKey(acc))
      if (existing && existing.kind === 'file') throw new FsError('ENOTDIR', `${acc} is a file`)
      if (!existing) this.nodes.set(compareKey(acc), { kind: 'dir', path: acc, id: this.nextId++ })
    }
  }

  /** Create or overwrite a file's bytes in place (seeding and "external edit" simulation). */
  writeFile(path: string, bytes: Uint8Array, mtimeMs?: number): void {
    const parent = parentOf(path)
    if (parent) this.mkdirp(parent)
    const existing = this.nodes.get(compareKey(path))
    if (existing && existing.kind === 'dir') throw new FsError('EEXIST', `${path} is a directory`)
    const mtime = mtimeMs ?? this.tick()
    if (existing && existing.kind === 'file') {
      existing.inode.bytes = bytes
      existing.inode.mtimeMs = mtime
      return
    }
    this.nodes.set(compareKey(path), { kind: 'file', path, inode: { id: this.nextId++, bytes, mtimeMs: mtime } })
  }

  readFile(path: string): Uint8Array | null {
    const node = this.nodes.get(compareKey(path))
    return node && node.kind === 'file' ? node.inode.bytes : null
  }

  /** Simulate an external create, e.g. a foreign file appearing at a destination. */
  createForeign(path: string, bytes: Uint8Array): void {
    this.writeFile(path, bytes)
  }

  /** Simulate an external delete outside the app. */
  removeExternally(path: string): void {
    this.nodes.delete(compareKey(path))
  }

  injectFault(plan: FaultPlan): void {
    this.faults.push({ ...plan, seen: 0 })
  }

  clearFaults(): void {
    this.faults = []
  }

  /** Independent byte/path manifest: every file path with its digest, sorted. */
  manifest(): { path: string; sha256: string }[] {
    const out: { path: string; sha256: string }[] = []
    for (const node of this.nodes.values()) {
      if (node.kind === 'file') out.push({ path: node.path, sha256: sha256Hex(node.inode.bytes) })
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  }

  allPaths(): { path: string; kind: 'file' | 'dir' }[] {
    return [...this.nodes.values()]
      .filter((node) => node.path !== '')
      .map((node) => ({ path: node.path, kind: node.kind }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  }

  private maybeFail(op: FaultPlan['op'], path: string): void {
    for (const fault of this.faults) {
      if (fault.op !== op) continue
      if (fault.path !== undefined && compareKey(fault.path) !== compareKey(path)) continue
      fault.seen++
      if (fault.seen === fault.nth) {
        this.faults = this.faults.filter((f) => f !== fault)
        throw new FsError('EIO', `Injected ${op} failure at ${path}`)
      }
    }
  }

  private requireDir(path: string): void {
    const node = this.nodes.get(compareKey(path))
    if (!node) throw new FsError('ENOENT', `${path || '(root)'} does not exist`)
    if (node.kind !== 'dir') throw new FsError('ENOTDIR', `${path} is not a directory`)
  }

  // ---- FsPort ----

  async list(dir: string): Promise<DirEntry[]> {
    this.requireDir(dir)
    const prefix = dir === '' ? '' : `${compareKey(dir)}/`
    const out: DirEntry[] = []
    for (const [key, node] of this.nodes) {
      if (key === '' || !key.startsWith(prefix)) continue
      if (key.slice(prefix.length).includes('/')) continue
      out.push({ name: node.path.slice(node.path.lastIndexOf('/') + 1), kind: node.kind })
    }
    return out
  }

  async stat(path: string): Promise<StatInfo | null> {
    const node = this.nodes.get(compareKey(path))
    if (!node) return null
    if (node.kind === 'dir') return { kind: 'dir', size: 0, mtimeMs: 0, identity: `sbx-d:${node.id}`, linkCount: 1 }
    let links = 0
    for (const other of this.nodes.values()) if (other.kind === 'file' && other.inode === node.inode) links++
    return { kind: 'file', size: node.inode.bytes.length, mtimeMs: node.inode.mtimeMs, identity: `sbx:${node.inode.id}`, linkCount: links }
  }

  async sha256(path: string): Promise<string> {
    this.maybeFail('sha256', path)
    const node = this.nodes.get(compareKey(path))
    if (!node || node.kind !== 'file') throw new FsError('ENOENT', `${path} is not a file`)
    return sha256Hex(node.inode.bytes)
  }

  async mkdir(path: string): Promise<void> {
    this.maybeFail('mkdir', path)
    if (this.nodes.has(compareKey(path))) throw new FsError('EEXIST', `${path} exists`)
    this.requireDir(parentOf(path))
    this.nodes.set(compareKey(path), { kind: 'dir', path, id: this.nextId++ })
  }

  async rmdir(path: string): Promise<void> {
    this.maybeFail('rmdir', path)
    this.requireDir(path)
    if ((await this.list(path)).length > 0) throw new FsError('ENOTEMPTY', `${path} is not empty`)
    this.nodes.delete(compareKey(path))
  }

  async link(src: string, dst: string): Promise<void> {
    this.maybeFail('link', dst)
    const node = this.nodes.get(compareKey(src))
    if (!node || node.kind !== 'file') throw new FsError('ENOENT', `${src} is not a file`)
    if (this.nodes.has(compareKey(dst))) throw new FsError('EEXIST', `${dst} exists`)
    this.requireDir(parentOf(dst))
    this.nodes.set(compareKey(dst), { kind: 'file', path: dst, inode: node.inode })
  }

  async unlink(path: string): Promise<void> {
    this.maybeFail('unlink', path)
    const node = this.nodes.get(compareKey(path))
    if (!node || node.kind !== 'file') throw new FsError('ENOENT', `${path} is not a file`)
    this.nodes.delete(compareKey(path))
  }
}

/** In-memory private run state. Mirrors the native state directory layout. */
export class MemoryJournalStore implements JournalStore {
  private plans = new Map<string, string>()
  private journals = new Map<string, string>()
  readonly preserved = new Map<string, string>()

  async listRuns(): Promise<string[]> {
    return [...this.plans.keys()]
  }

  async readPlan(runId: string): Promise<string | null> {
    return this.plans.get(runId) ?? null
  }

  async writePlan(runId: string, text: string): Promise<void> {
    if (this.plans.has(runId)) throw new FsError('EEXIST', `run ${runId} already has a plan`)
    this.plans.set(runId, text)
  }

  async readJournal(runId: string): Promise<string | null> {
    return this.journals.get(runId) ?? null
  }

  async appendJournal(runId: string, line: string): Promise<void> {
    this.journals.set(runId, (this.journals.get(runId) ?? '') + line)
  }

  async preserveJournal(runId: string, label: string): Promise<string> {
    let name = `${runId}.${label}`
    for (let n = 2; this.preserved.has(name); n++) name = `${runId}.${label}-${n}`
    this.preserved.set(name, this.journals.get(runId) ?? '')
    return name
  }

  async replaceJournal(runId: string, text: string): Promise<void> {
    this.journals.set(runId, text)
  }

  /** Simulate a torn write: append a fragment with no trailing newline. */
  tearAppend(runId: string, fragment: string): void {
    this.journals.set(runId, (this.journals.get(runId) ?? '') + fragment)
  }
}
