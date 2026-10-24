import {
  isProtectedRelPath,
  isSafeToken,
  isTempPath,
  isUnderQuarantine,
  isUnderReserved,
  normalizeRelative,
} from './paths'
import type {
  FileNode,
  Journal,
  JournalEntry,
  JournalKind,
  JournalOp,
  MoveRequest,
  PlanIssue,
  StepResult,
} from './types'
import { validateOrganizeMoves } from './validate'

export interface Hop {
  nodeId: string
  userFrom: string
  toPath: string
  sizeBytes: number
  mtimeMs: number
  op: Extract<JournalOp, 'rename' | 'quarantine'>
}

export interface JournalContext {
  journalId: string
  planId: string | null
  newId?: () => string
}

function findCI(nodes: FileNode[], relPath: string): FileNode | undefined {
  const key = relPath.toLowerCase()
  return nodes.find((node) => node.relPath.toLowerCase() === key)
}

function parentsOf(filePath: string): string[] {
  const parts = filePath.split('/')
  parts.pop()
  const out: string[] = []
  let acc = ''
  for (const part of parts) {
    acc = acc ? `${acc}/${part}` : part
    out.push(acc)
  }
  return out
}

function withEntry(journal: Journal, seq: number, patch: Partial<JournalEntry>): Journal {
  return {
    ...journal,
    entries: journal.entries.map((entry) => (entry.seq === seq ? { ...entry, ...patch } : entry)),
  }
}

export function buildTwoHop(
  nodes: FileNode[],
  hops: Hop[],
  ctx: { journalId: string; planId: string | null; kind: JournalKind; newId: () => string },
): { ok: true; journal: Journal } | { ok: false; issues: PlanIssue[] } {
  if (!isSafeToken(ctx.journalId)) {
    return {
      ok: false,
      issues: [{ code: 'bad-journal-id', message: 'Journal id must be a short safe token.' }],
    }
  }
  if (hops.length === 0) {
    return { ok: false, issues: [{ code: 'empty-plan', message: 'Nothing to apply.' }] }
  }

  const issues: PlanIssue[] = []
  const moving = new Set(hops.map((hop) => hop.nodeId))
  const destSeen = new Set<string>()
  const parked: { hop: Hop; tempPath: string }[] = []

  hops.forEach((hop, index) => {
    const dest = normalizeRelative(hop.toPath)
    if (!dest.ok) {
      issues.push({ code: 'bad-destination', message: dest.reason, path: hop.toPath })
      return
    }
    const destKey = dest.path.toLowerCase()
    if (destSeen.has(destKey)) {
      issues.push({
        code: 'case-collision',
        message: 'Two files would land on the same path, ignoring case.',
        path: dest.path,
      })
    }
    destSeen.add(destKey)
    const occupier = findCI(nodes, dest.path)
    if (occupier && occupier.id !== hop.nodeId && !moving.has(occupier.id)) {
      issues.push({
        code: 'destination-occupied',
        message: 'The destination is already used by a file that is not moving.',
        path: dest.path,
      })
    }
    const base = hop.userFrom.split('/').pop() ?? 'file'
    const tempPath = `.declutter-tmp/${ctx.journalId}/${index + 1}/${base}`
    const normalizedTemp = normalizeRelative(tempPath)
    if (!normalizedTemp.ok) {
      issues.push({ code: 'bad-temp-path', message: normalizedTemp.reason, path: tempPath })
      return
    }
    parked.push({ hop: { ...hop, toPath: dest.path }, tempPath: normalizedTemp.path })
  })
  if (issues.length > 0) return { ok: false, issues }

  const dirPaths: string[] = []
  const seenDirs = new Set<string>()
  for (const item of parked) {
    for (const parent of [...parentsOf(item.tempPath), ...parentsOf(item.hop.toPath)]) {
      const key = parent.toLowerCase()
      if (seenDirs.has(key)) continue
      seenDirs.add(key)
      dirPaths.push(parent)
    }
  }
  dirPaths.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))

  const entries: JournalEntry[] = []
  let seq = 1
  for (const dirPath of dirPaths) {
    const existing = findCI(nodes, dirPath)
    if (existing?.kind === 'dir') continue
    if (existing) {
      issues.push({
        code: 'parent-is-file',
        message: 'A parent folder path is already a file.',
        path: dirPath,
      })
      continue
    }
    entries.push({
      seq,
      op: 'mkdir',
      nodeId: ctx.newId(),
      fromPath: '',
      toPath: dirPath,
      restorePath: '',
      sizeBytes: null,
      mtimeMs: null,
      phase: 'planned',
      note: '',
    })
    seq += 1
  }
  if (issues.length > 0) return { ok: false, issues }

  for (const item of parked) {
    entries.push({
      seq,
      op: 'rename',
      nodeId: item.hop.nodeId,
      fromPath: item.hop.userFrom,
      toPath: item.tempPath,
      restorePath: item.hop.userFrom,
      sizeBytes: item.hop.sizeBytes,
      mtimeMs: item.hop.mtimeMs,
      phase: 'planned',
      note: '',
    })
    seq += 1
  }
  for (const item of parked) {
    entries.push({
      seq,
      op: item.hop.op,
      nodeId: item.hop.nodeId,
      fromPath: item.tempPath,
      toPath: item.hop.toPath,
      restorePath: item.hop.userFrom,
      sizeBytes: item.hop.sizeBytes,
      mtimeMs: item.hop.mtimeMs,
      phase: 'planned',
      note: '',
    })
    seq += 1
  }

  return {
    ok: true,
    journal: {
      id: ctx.journalId,
      kind: ctx.kind,
      status: 'open',
      planId: ctx.planId,
      entries,
    },
  }
}

function idFactory(journalId: string, supplied?: () => string): () => string {
  let counter = 0
  return supplied ?? (() => `${journalId}-dir-${counter++}`)
}

export function prepareApply(
  nodes: FileNode[],
  moves: MoveRequest[],
  ctx: JournalContext,
): { ok: true; journal: Journal } | { ok: false; issues: PlanIssue[] } {
  const validated = validateOrganizeMoves(nodes, moves)
  if (!validated.ok) return validated
  if (validated.planned.length === 0) {
    return {
      ok: false,
      issues: [
        {
          code: 'empty-plan',
          message: 'Nothing to apply. Every selected file is already at its destination.',
        },
      ],
    }
  }
  return buildTwoHop(
    nodes,
    validated.planned.map((move) => ({
      nodeId: move.nodeId,
      userFrom: move.fromPath,
      toPath: move.toPath,
      sizeBytes: move.sizeBytes,
      mtimeMs: move.mtimeMs,
      op: 'rename' as const,
    })),
    {
      journalId: ctx.journalId,
      planId: ctx.planId,
      kind: 'apply',
      newId: idFactory(ctx.journalId, ctx.newId),
    },
  )
}

export function prepareQuarantine(
  nodes: FileNode[],
  nodeIds: string[],
  ctx: JournalContext,
): { ok: true; journal: Journal } | { ok: false; issues: PlanIssue[] } {
  const issues: PlanIssue[] = []
  const hops: Hop[] = []
  const seen = new Set<string>()
  for (const nodeId of nodeIds) {
    if (seen.has(nodeId)) {
      issues.push({ code: 'duplicate-node', message: 'The same file is listed twice.', path: nodeId })
      continue
    }
    seen.add(nodeId)
    const node = nodes.find((item) => item.id === nodeId)
    if (!node || node.kind !== 'file') {
      issues.push({ code: 'missing-node', message: 'That file is not in the workspace.', path: nodeId })
      continue
    }
    if (node.protected || isProtectedRelPath(node.relPath) || isUnderReserved(node.relPath)) {
      issues.push({
        code: 'not-quarantineable',
        message: 'Protected files and files already in a system folder stay put.',
        path: node.relPath,
      })
      continue
    }
    const dest = normalizeRelative(`.quarantine/${ctx.journalId}/${node.relPath}`)
    if (!dest.ok) {
      issues.push({ code: 'bad-destination', message: dest.reason, path: node.relPath })
      continue
    }
    hops.push({
      nodeId: node.id,
      userFrom: node.relPath,
      toPath: dest.path,
      sizeBytes: node.sizeBytes,
      mtimeMs: node.mtimeMs,
      op: 'quarantine',
    })
  }
  if (issues.length > 0) return { ok: false, issues }
  return buildTwoHop(nodes, hops, {
    journalId: ctx.journalId,
    planId: null,
    kind: 'quarantine',
    newId: idFactory(ctx.journalId, ctx.newId),
  })
}

function finalPlacements(journal: Journal): JournalEntry[] {
  return journal.entries.filter(
    (entry) =>
      (entry.op === 'rename' || entry.op === 'quarantine') &&
      entry.phase === 'done' &&
      !isTempPath(entry.toPath),
  )
}

export function prepareUndo(
  nodes: FileNode[],
  journal: Journal,
  ctx: JournalContext,
): { ok: true; journal: Journal } | { ok: false; issues: PlanIssue[] } {
  if (journal.status !== 'committed') {
    return {
      ok: false,
      issues: [{ code: 'not-committed', message: 'Only a committed journal can be undone.' }],
    }
  }
  if (journal.kind === 'undo') {
    return {
      ok: false,
      issues: [{ code: 'undo-of-undo', message: 'Undo this batch from the journal it restored, not from the undo itself.' }],
    }
  }

  const finals = finalPlacements(journal)
  if (finals.length === 0) {
    return { ok: false, issues: [{ code: 'empty-plan', message: 'That journal moved no files.' }] }
  }

  const moving = new Set(finals.map((entry) => entry.nodeId))
  const issues: PlanIssue[] = []
  const hops: Hop[] = []
  for (const entry of finals) {
    const node = nodes.find((item) => item.id === entry.nodeId)
    if (!node) {
      issues.push({
        code: 'missing-node',
        message: 'A moved file is no longer in the workspace.',
        path: entry.toPath,
      })
      continue
    }
    if (node.relPath.toLowerCase() !== entry.toPath.toLowerCase()) {
      issues.push({
        code: 'not-at-destination',
        message: 'The file is no longer where the journal left it.',
        path: node.relPath,
      })
      continue
    }
    if (entry.sizeBytes !== null && node.sizeBytes !== entry.sizeBytes) {
      issues.push({
        code: 'changed-since-apply',
        message: 'Size changed since the move. Undo will not touch it.',
        path: node.relPath,
      })
      continue
    }
    if (entry.mtimeMs !== null && node.mtimeMs !== entry.mtimeMs) {
      issues.push({
        code: 'changed-since-apply',
        message: 'Modification time changed since the move. Undo will not touch it.',
        path: node.relPath,
      })
      continue
    }
    if (!entry.restorePath) {
      issues.push({
        code: 'missing-restore-path',
        message: 'The journal has no original path for this file.',
        path: node.relPath,
      })
      continue
    }
    const occupier = findCI(nodes, entry.restorePath)
    if (occupier && occupier.id !== node.id && !moving.has(occupier.id)) {
      issues.push({
        code: 'original-occupied',
        message: 'The original path is occupied. Undo will not overwrite it.',
        path: entry.restorePath,
      })
      continue
    }
    hops.push({
      nodeId: node.id,
      userFrom: node.relPath,
      toPath: entry.restorePath,
      sizeBytes: node.sizeBytes,
      mtimeMs: node.mtimeMs,
      op: 'rename',
    })
  }
  if (issues.length > 0) return { ok: false, issues }
  return buildTwoHop(nodes, hops, {
    journalId: ctx.journalId,
    planId: journal.planId,
    kind: 'undo',
    newId: idFactory(ctx.journalId, ctx.newId),
  })
}

function refuse(
  nodes: FileNode[],
  journal: Journal,
  seq: number,
  note: string,
): StepResult {
  return {
    nodes,
    journal: {
      ...withEntry(journal, seq, { phase: 'blocked', note }),
      status: 'needs_recovery',
    },
    event: 'blocked',
  }
}

export function step(nodes: FileNode[], journal: Journal): StepResult {
  if (journal.status !== 'open') return { nodes, journal, event: 'closed' }
  const entry = journal.entries.find((item) => item.phase === 'planned')
  if (!entry) return { nodes, journal, event: 'commit-ready' }

  if (entry.op === 'mkdir') {
    const existing = findCI(nodes, entry.toPath)
    if (existing?.kind === 'dir') {
      return {
        nodes,
        journal: withEntry(journal, entry.seq, { phase: 'done', note: 'already present' }),
        event: 'advanced',
      }
    }
    if (existing) return refuse(nodes, journal, entry.seq, 'parent path is a file')
    const dir: FileNode = {
      id: entry.nodeId,
      relPath: entry.toPath,
      kind: 'dir',
      sizeBytes: 0,
      mtimeMs: 0,
      contentHash: null,
      protected: false,
      quarantined: false,
    }
    return {
      nodes: [...nodes, dir],
      journal: withEntry(journal, entry.seq, { phase: 'done', note: '' }),
      event: 'advanced',
    }
  }

  const node = nodes.find((item) => item.id === entry.nodeId)
  if (!node) return refuse(nodes, journal, entry.seq, 'missing node')
  if (node.relPath.toLowerCase() !== entry.fromPath.toLowerCase()) {
    return refuse(nodes, journal, entry.seq, 'path does not match the journal')
  }
  if (entry.sizeBytes !== null && node.sizeBytes !== entry.sizeBytes) {
    return refuse(nodes, journal, entry.seq, 'size changed since scan')
  }
  if (entry.mtimeMs !== null && node.mtimeMs !== entry.mtimeMs) {
    return refuse(nodes, journal, entry.seq, 'mtime changed since scan')
  }
  const occupier = findCI(nodes, entry.toPath)
  if (occupier && occupier.id !== node.id) {
    return refuse(nodes, journal, entry.seq, 'destination occupied')
  }
  const nextNodes = nodes.map((item) =>
    item.id === node.id
      ? { ...item, relPath: entry.toPath, quarantined: isUnderQuarantine(entry.toPath) }
      : item,
  )
  return {
    nodes: nextNodes,
    journal: withEntry(journal, entry.seq, { phase: 'done', note: '' }),
    event: 'advanced',
  }
}

export function applyAll(nodes: FileNode[], journal: Journal): { nodes: FileNode[]; journal: Journal } {
  let currentNodes = nodes
  let current = journal
  for (let guard = 0; guard < 500; guard += 1) {
    const next = step(currentNodes, current)
    currentNodes = next.nodes
    current = next.journal
    if (next.event === 'commit-ready') {
      return { nodes: currentNodes, journal: { ...current, status: 'committed' } }
    }
    if (next.event !== 'advanced') return { nodes: currentNodes, journal: current }
  }
  return { nodes: currentNodes, journal: { ...current, status: 'needs_recovery' } }
}

function hasChild(nodes: FileNode[], dirPath: string): boolean {
  const prefix = `${dirPath.toLowerCase()}/`
  return nodes.some((node) => node.relPath.toLowerCase().startsWith(prefix))
}

export function recover(nodes: FileNode[], journal: Journal): { nodes: FileNode[]; journal: Journal } {
  if (journal.status !== 'open' && journal.status !== 'needs_recovery') {
    return { nodes, journal }
  }

  let current = nodes.map((node) => ({ ...node }))
  const entries = journal.entries.map((entry) => ({ ...entry }))
  let blocked = false

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (!entry) continue
    if (entry.phase === 'planned') {
      entries[index] = { ...entry, phase: 'undone', note: 'not applied' }
      continue
    }
    if (entry.phase !== 'done') continue

    if (entry.op === 'mkdir') {
      const dir = findCI(current, entry.toPath)
      if (!dir) {
        entries[index] = { ...entry, phase: 'undone', note: 'directory already absent' }
        continue
      }
      if (dir.kind !== 'dir' || hasChild(current, entry.toPath)) {
        blocked = true
        entries[index] = {
          ...entry,
          phase: 'blocked',
          note: 'directory not empty or not a directory',
        }
        continue
      }
      current = current.filter((node) => node.id !== dir.id)
      entries[index] = { ...entry, phase: 'undone', note: 'removed empty directory' }
      continue
    }

    const node = current.find((item) => item.id === entry.nodeId)
    if (!node) {
      blocked = true
      entries[index] = { ...entry, phase: 'blocked', note: 'missing node on rollback' }
      continue
    }
    if (node.relPath.toLowerCase() !== entry.toPath.toLowerCase()) {
      blocked = true
      entries[index] = { ...entry, phase: 'blocked', note: 'node is not at the journal destination' }
      continue
    }
    if (entry.sizeBytes !== null && node.sizeBytes !== entry.sizeBytes) {
      blocked = true
      entries[index] = { ...entry, phase: 'blocked', note: 'size changed since move' }
      continue
    }
    if (entry.mtimeMs !== null && node.mtimeMs !== entry.mtimeMs) {
      blocked = true
      entries[index] = { ...entry, phase: 'blocked', note: 'mtime changed since move' }
      continue
    }
    const occupier = findCI(current, entry.fromPath)
    if (occupier && occupier.id !== node.id) {
      blocked = true
      entries[index] = { ...entry, phase: 'blocked', note: 'original path is occupied' }
      continue
    }
    current = current.map((item) =>
      item.id === node.id
        ? { ...item, relPath: entry.fromPath, quarantined: isUnderQuarantine(entry.fromPath) }
        : item,
    )
    entries[index] = { ...entry, phase: 'undone', note: 'rolled back' }
  }

  const unresolved = entries.some((entry) => entryLeftBehind(entry, current))
  return {
    nodes: current,
    journal: {
      ...journal,
      entries,
      status: blocked || unresolved ? 'needs_recovery' : 'rolled_back',
    },
  }
}

function entryLeftBehind(entry: JournalEntry, nodes: FileNode[]): boolean {
  if (entry.phase !== 'blocked') return false
  if (entry.op === 'mkdir') {
    return nodes.some((node) => node.id === entry.nodeId)
  }
  const node = nodes.find((item) => item.id === entry.nodeId)
  if (!node || !entry.fromPath) return true
  return node.relPath.toLowerCase() !== entry.fromPath.toLowerCase()
}
