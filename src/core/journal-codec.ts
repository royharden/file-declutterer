import { sha256Text, SHA256_HEX } from './fingerprint.js'
import type { JournalStore } from './fs-port.js'
import { canonicalJson } from './plan.js'
import type { RunStatus } from './types.js'

// Write-ahead journal codec (PLAN §8). One canonical-JSON record per line, each carrying the
// SHA-256 of the previous line. The unkeyed chain detects corruption; it is not authenticity
// against someone rewriting all same-user private state.
//
// A line is complete only when its trailing newline is present. At most one final fragment
// without a newline is tolerated as a torn tail. A complete line that fails to parse, breaks
// the chain or the sequence makes the journal needs_attention; history is never reset.

export const JOURNAL_SCHEMA = 'declutter-journal'
export const GENESIS = '0'.repeat(64)

export type RecordType = 'begin' | 'intent' | 'outcome' | 'observe' | 'halt' | 'status' | 'continuation'
export type JournalOp = 'mkdir' | 'move' | 'unlink-extra' | 'rmdir'
export type JournalPhase = 'apply' | 'rollback' | 'undo'
export type OutcomeResult = 'ok' | 'failed' | 'linked-only' | 'existing' | 'refused'

export interface Expected {
  sha256: string | null
  identity: string | null
  size: number | null
  mtimeMs: number | null
}

export interface JournalRecord {
  schema: typeof JOURNAL_SCHEMA
  v: 1
  runId: string
  rootId: string
  planId: string
  planDigest: string
  seq: number
  prev: string
  type: RecordType
  phase: JournalPhase | null
  /** Index into the compiled apply operation list this record concerns, or null. */
  opIndex: number | null
  op: JournalOp | null
  from: string | null
  to: string | null
  expected: Expected | null
  result: OutcomeResult | null
  /** Identity observed after the action (created directory, linked file), or null. */
  observedIdentity: string | null
  status: RunStatus | null
  detail: string | null
}

export type RecordBody = Pick<JournalRecord, 'type'> & Partial<Omit<JournalRecord, 'schema' | 'v' | 'runId' | 'rootId' | 'planId' | 'planDigest' | 'seq' | 'prev' | 'type'>>

export interface RunIdentity {
  runId: string
  rootId: string
  planId: string
  planDigest: string
}

export interface ParsedJournal {
  records: JournalRecord[]
  /** Text of complete lines exactly as stored (each with its newline). */
  completeText: string
  tornTail: string | null
  corrupt: { line: number; reason: string } | null
}

const RECORD_KEYS = [
  'detail', 'expected', 'from', 'observedIdentity', 'op', 'opIndex', 'phase', 'planDigest', 'planId', 'prev',
  'result', 'rootId', 'runId', 'schema', 'seq', 'status', 'to', 'type', 'v',
].sort()

export function encodeRecord(identity: RunIdentity, seq: number, prev: string, body: RecordBody): { record: JournalRecord; line: string } {
  const record: JournalRecord = {
    schema: JOURNAL_SCHEMA,
    v: 1,
    runId: identity.runId,
    rootId: identity.rootId,
    planId: identity.planId,
    planDigest: identity.planDigest,
    seq,
    prev,
    type: body.type,
    phase: body.phase ?? null,
    opIndex: body.opIndex ?? null,
    op: body.op ?? null,
    from: body.from ?? null,
    to: body.to ?? null,
    expected: body.expected ?? null,
    result: body.result ?? null,
    observedIdentity: body.observedIdentity ?? null,
    status: body.status ?? null,
    detail: body.detail ?? null,
  }
  return { record, line: `${canonicalJson(record)}\n` }
}

export function parseJournal(text: string, identity?: Pick<RunIdentity, 'runId'>): ParsedJournal {
  const records: JournalRecord[] = []
  if (text === '') return { records, completeText: '', tornTail: null, corrupt: null }
  const lastNewline = text.lastIndexOf('\n')
  const completeText = lastNewline < 0 ? '' : text.slice(0, lastNewline + 1)
  const tornTail = lastNewline === text.length - 1 ? null : text.slice(lastNewline + 1)
  const lines = completeText === '' ? [] : completeText.slice(0, -1).split('\n')
  let prev = GENESIS
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const bad = (reason: string): ParsedJournal => ({ records, completeText, tornTail, corrupt: { line: i + 1, reason } })
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return bad('complete line is not valid JSON')
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return bad('record is not an object')
    const rec = parsed as JournalRecord
    const keys = Object.keys(rec).sort()
    if (keys.length !== RECORD_KEYS.length || keys.some((k, j) => k !== RECORD_KEYS[j])) return bad('unexpected record fields')
    if (rec.schema !== JOURNAL_SCHEMA || rec.v !== 1) return bad('unsupported schema or version')
    if (rec.expected !== null) {
      const expected = rec.expected
      if (typeof expected !== 'object' || Array.isArray(expected) || Object.keys(expected).sort().join(',') !== 'identity,mtimeMs,sha256,size') return bad('missing or unsupported expected metadata')
      if (expected.mtimeMs !== null && !Number.isSafeInteger(expected.mtimeMs)) return bad('invalid expected modification time')
      if (expected.size !== null && (!Number.isSafeInteger(expected.size) || expected.size < 0)) return bad('invalid expected size')
      if (expected.sha256 !== null && (typeof expected.sha256 !== 'string' || !SHA256_HEX.test(expected.sha256))) return bad('invalid expected hash')
      if (expected.identity !== null && typeof expected.identity !== 'string') return bad('invalid expected identity')
    }
    if (rec.type === 'intent' && rec.op === 'move' && (rec.expected === null || rec.expected.mtimeMs === null)) return bad('move intent lacks approved modification metadata')
    if (rec.seq !== i) return bad(`sequence ${String(rec.seq)} where ${i} expected`)
    if (rec.prev !== prev || !SHA256_HEX.test(rec.prev)) return bad('previous-record hash does not match')
    if (identity && rec.runId !== identity.runId) return bad('record belongs to another run')
    if (records.length > 0 && (rec.runId !== records[0]!.runId || rec.planDigest !== records[0]!.planDigest)) return bad('run or plan digest changed mid-journal')
    let canonical: string
    try {
      canonical = canonicalJson(rec)
    } catch {
      return bad('record is not canonical')
    }
    if (canonical !== line) return bad('record is not in canonical form')
    records.push(rec)
    prev = sha256Text(line)
  }
  return { records, completeText, tornTail, corrupt: null }
}

/**
 * Appends records for one run. Opening a journal with a torn tail first preserves the
 * original bytes, then atomically replaces the journal with its verified complete records
 * plus a continuation record naming what was dropped. Nothing is ever appended after a
 * fragment. A corrupt journal refuses to open for writing.
 */
export class JournalWriter {
  private constructor(
    private readonly store: JournalStore,
    readonly identity: RunIdentity,
    private seq: number,
    private prev: string,
    readonly records: JournalRecord[],
  ) {}

  static async create(store: JournalStore, identity: RunIdentity): Promise<JournalWriter> {
    const existing = await store.readJournal(identity.runId)
    if (existing !== null && existing !== '') throw new Error(`Run ${identity.runId} already has a journal.`)
    return new JournalWriter(store, identity, 0, GENESIS, [])
  }

  /**
   * Open an existing run for appending. identity comes from the stored plan; every complete
   * record must agree with it. A journal whose only content is a torn fragment is continued
   * from genesis (the fragment is preserved first).
   */
  static async open(store: JournalStore, identity: RunIdentity): Promise<{ writer: JournalWriter | null; parsed: ParsedJournal }> {
    const runId = identity.runId
    const text = (await store.readJournal(runId)) ?? ''
    const parsed = parseJournal(text, { runId })
    if (parsed.corrupt) return { writer: null, parsed }
    const first = parsed.records[0]
    if (first && (first.rootId !== identity.rootId || first.planId !== identity.planId || first.planDigest !== identity.planDigest)) {
      return { writer: null, parsed: { ...parsed, corrupt: { line: 1, reason: 'journal does not match the stored plan' } } }
    }
    let prev = GENESIS
    if (parsed.completeText !== '') {
      const lines = parsed.completeText.slice(0, -1).split('\n')
      prev = sha256Text(lines[lines.length - 1]!)
    }
    let seq = parsed.records.length
    const records = [...parsed.records]
    if (parsed.tornTail !== null) {
      const preservedAs = await store.preserveJournal(runId, 'torn')
      const { record, line } = encodeRecord(identity, seq, prev, {
        type: 'continuation',
        detail: `Dropped torn fragment of ${parsed.tornTail.length} chars (sha256 ${sha256Text(parsed.tornTail)}); original preserved as ${preservedAs}.`,
      })
      await store.replaceJournal(runId, parsed.completeText + line)
      records.push(record)
      prev = sha256Text(line.slice(0, -1))
      seq++
    }
    return { writer: new JournalWriter(store, identity, seq, prev, records), parsed }
  }

  async append(body: RecordBody): Promise<JournalRecord> {
    const { record, line } = encodeRecord(this.identity, this.seq, this.prev, body)
    await this.store.appendJournal(this.identity.runId, line)
    this.records.push(record)
    this.prev = sha256Text(line.slice(0, -1))
    this.seq++
    return record
  }
}

/**
 * Latest run status. 'open' when the apply never wrote a status. A rollback or undo that
 * began after the last status and did not finish is needs_attention in that phase, so it
 * blocks new work until it is retried to completion.
 */
export function currentStatus(records: JournalRecord[]): { status: RunStatus; phase: JournalPhase | null; detail: string | null } {
  for (let i = records.length - 1; i >= 0; i--) {
    const rec = records[i]!
    if (rec.type === 'status' && rec.status) return { status: rec.status, phase: rec.phase, detail: rec.detail }
    if (rec.type === 'begin' && (rec.phase === 'rollback' || rec.phase === 'undo')) {
      return { status: 'needs_attention', phase: rec.phase, detail: `The ${rec.phase} was interrupted; retry it.` }
    }
  }
  return { status: 'open', phase: 'apply', detail: null }
}
