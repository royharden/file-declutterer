export type NodeKind = 'file' | 'dir'

/** Metadata only. This app never stores file bytes. */
export interface FileNode {
  id: string
  relPath: string
  kind: NodeKind
  sizeBytes: number
  mtimeMs: number
  contentHash: string | null
  protected: boolean
  quarantined: boolean
}

export interface PlanIssue {
  code: string
  message: string
  path?: string
}

export interface MoveRequest {
  nodeId: string
  toPath: string
}

export interface PlannedMove {
  nodeId: string
  fromPath: string
  toPath: string
  sizeBytes: number
  mtimeMs: number
}

export type JournalKind = 'apply' | 'undo' | 'quarantine'
export type JournalStatus = 'open' | 'committed' | 'rolled_back' | 'needs_recovery'
export type JournalOp = 'mkdir' | 'rename' | 'quarantine'
export type EntryPhase = 'planned' | 'done' | 'undone' | 'blocked'

export interface JournalEntry {
  seq: number
  op: JournalOp
  nodeId: string
  fromPath: string
  toPath: string
  /** Path to restore if this journal's placement is undone. */
  restorePath: string
  sizeBytes: number | null
  mtimeMs: number | null
  phase: EntryPhase
  note: string
}

export interface Journal {
  id: string
  kind: JournalKind
  status: JournalStatus
  planId: string | null
  entries: JournalEntry[]
}

export type StepEvent = 'advanced' | 'blocked' | 'commit-ready' | 'closed'

export interface StepResult {
  nodes: FileNode[]
  journal: Journal
  event: StepEvent
}
