import type { Profile } from './types.js'

// The core never touches a file system directly. Adapters (src/adapters/memory-fs.ts for the
// sandbox, cli/node-fs.ts for native) implement these ports. Paths are root-relative with '/'
// separators; '' is the root itself.

export type EntryKind = 'file' | 'dir' | 'link' | 'other'

export interface DirEntry {
  name: string
  kind: EntryKind
  hidden?: boolean
  system?: boolean
}

export interface StatInfo {
  kind: EntryKind
  size: number
  mtimeMs: number
  /** Qualified identity, or null when the adapter cannot supply one. */
  identity: string | null
  linkCount: number
}

export type FsErrorCode = 'EEXIST' | 'ENOENT' | 'ENOTEMPTY' | 'ENOTDIR' | 'EIO' | 'EUNSUPPORTED'

export class FsError extends Error {
  constructor(
    readonly code: FsErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'FsError'
  }
}

export interface FsPort {
  readonly profile: Profile
  readonly rootId: string
  readonly rootDisplay: string
  /** Entries of a directory, without following links. */
  list(dir: string): Promise<DirEntry[]>
  /** lstat semantics; null when the path does not exist. */
  stat(path: string): Promise<StatInfo | null>
  /** Full SHA-256 of the current bytes. Throws when unreadable. */
  sha256(path: string): Promise<string>
  /** Exclusive: fails with EEXIST if anything is at path; parent must exist. */
  mkdir(path: string): Promise<void>
  /** Fails with ENOTEMPTY unless the directory is empty. */
  rmdir(path: string): Promise<void>
  /** Exclusive hard link. Fails with EEXIST if dst exists. Never overwrites. */
  link(src: string, dst: string): Promise<void>
  unlink(path: string): Promise<void>
}

/**
 * Private run state (plans, journals). Lives outside the selected root. Appends resolve only
 * after the bytes are flushed by the adapter.
 */
export interface JournalStore {
  listRuns(): Promise<string[]>
  readPlan(runId: string): Promise<string | null>
  /** Exclusive create; a run's plan is written once. */
  writePlan(runId: string, text: string): Promise<void>
  readJournal(runId: string): Promise<string | null>
  /** Append one complete line (including its trailing newline) and flush. */
  appendJournal(runId: string, line: string): Promise<void>
  /** Copy the current journal aside unchanged; returns the preserved name. */
  preserveJournal(runId: string, label: string): Promise<string>
  /** Atomically replace the journal text (used only for verified torn-tail continuation). */
  replaceJournal(runId: string, text: string): Promise<void>
}

/** Thrown by an executor checkpoint to simulate an interruption at a named boundary. */
export class InterruptError extends Error {
  constructor(readonly boundary: string) {
    super(`Interrupted at ${boundary}`)
    this.name = 'InterruptError'
  }
}

/** Called by executors at every journal/file-system boundary. May throw InterruptError. */
export type Checkpoint = (boundary: string) => void

export function noCheckpoint(): void {}

export function joinPath(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`
}

export function parentOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

export function baseOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? path : path.slice(i + 1)
}

/** Ancestors from the top down, excluding '' and the path itself. */
export function ancestorsOf(path: string): string[] {
  const parts = path.split('/')
  parts.pop()
  const out: string[] = []
  let acc = ''
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part
    out.push(acc)
  }
  return out
}
