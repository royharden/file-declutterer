// Shared contracts for the one active core. No DOM, Node or platform imports in src/core.

export type Profile = 'sandbox' | 'native'

/** Where a fingerprint came from. Only computed values can back duplicates or mutations. */
export type Provenance = 'computed-native' | 'computed-synthetic' | 'imported-unverified'

export interface FileRecord {
  /** Opaque, scan-local id. */
  id: string
  /** Literal relative path with '/' separators, exactly as spelled on the root. */
  relPath: string
  /** Exact original final suffix including the dot, or '' (see splitExtension). */
  ext: string
  size: number
  mtimeMs: number
  /** Full lowercase hex SHA-256 of the bytes, or null when not computed. */
  sha256: string | null
  /** Qualified file identity (sandbox inode, native volume+file id), or null. */
  identity: string | null
  provenance: Provenance
}

export type SkipReason =
  | 'protected'
  | 'hidden'
  | 'project-tree'
  | 'output-root'
  | 'quarantine-root'
  | 'app-state'
  | 'link-or-reparse'
  | 'multiply-linked'
  | 'unhashable'
  | 'not-regular'
  | 'invalid-name'

export interface SkipRecord {
  relPath: string
  kind: 'file' | 'dir' | 'other'
  reason: SkipReason
  detail: string
}

export interface ScanBounds {
  maxFiles: number
  maxBytes: number
  maxDepth: number
  maxEntries: number
}

export interface ScanTotals {
  eligibleFiles: number
  eligibleBytes: number
  encounteredEntries: number
  skipped: number
  blocked: number
  zeroByte: number
  projectTrees: number
}

export interface ScanManifest {
  schema: 'scan-manifest'
  version: 1
  scanId: string
  profile: Profile
  mode: ScanMode
  policyId: string
  root: { id: string; displayHint: string }
  bounds: ScanBounds
  status: 'complete' | 'aborted'
  abortReason: string | null
  files: FileRecord[]
  skipped: SkipRecord[]
  /** Relative paths of project subtrees that were left untouched. */
  projectRoots: string[]
  totals: ScanTotals
}

/** organize excludes output and quarantine; duplicates includes the output root. */
export type ScanMode = 'organize' | 'duplicates'

export type IssueSeverity = 'block' | 'warn'

export interface Issue {
  code: string
  severity: IssueSeverity
  message: string
}

export type ProposalSource = 'heuristic' | 'simulated' | 'local-ai' | 'manual-edit'

export type PlanKind = 'organize' | 'quarantine' | 'restore'

export type RunStatus = 'open' | 'committed' | 'rolled_back' | 'undone' | 'needs_attention'
