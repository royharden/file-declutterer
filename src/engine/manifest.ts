import { isProtectedRelPath, normalizeRelative } from './paths'
import type { FileNode, PlanIssue } from './types'

const ALLOWED_KEYS = new Set(['relPath', 'kind', 'sizeBytes', 'mtimeMs', 'contentHash', 'protected'])
const BANNED_KEYS = new Set([
  'content',
  'text',
  'excerpt',
  'bytes',
  'data',
  'body',
  'base64',
  'exif',
  'preview',
  'filetext',
])
const HASH_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
export const MANIFEST_FILE_CAP = 500

function issue(code: string, message: string, path?: string): PlanIssue {
  return path === undefined ? { code, message } : { code, message, path }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function synthesizeParents(nodes: FileNode[], newId: () => string): FileNode[] {
  const known = new Set(nodes.map((node) => node.relPath.toLowerCase()))
  const extras: FileNode[] = []
  for (const node of nodes) {
    const parts = node.relPath.split('/')
    parts.pop()
    let acc = ''
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part
      const key = acc.toLowerCase()
      if (known.has(key)) continue
      known.add(key)
      extras.push({
        id: newId(),
        relPath: acc,
        kind: 'dir',
        sizeBytes: 0,
        mtimeMs: 0,
        contentHash: null,
        protected: isProtectedRelPath(acc),
        quarantined: false,
      })
    }
  }
  return [...extras, ...nodes]
}

export function parseManifest(
  input: unknown,
  newId: () => string,
): { ok: true; nodes: FileNode[] } | { ok: false; issues: PlanIssue[] } {
  if (!isRecord(input)) {
    return { ok: false, issues: [issue('bad-manifest', 'Manifest must be a JSON object.')] }
  }
  const topKeys = Object.keys(input)
  if (topKeys.length !== 1 || topKeys[0] !== 'files') {
    return {
      ok: false,
      issues: [issue('unexpected-field', 'Manifest may only contain a files array.')],
    }
  }
  if (!Array.isArray(input.files)) {
    return { ok: false, issues: [issue('bad-manifest', 'files must be an array.')] }
  }
  if (input.files.length > MANIFEST_FILE_CAP) {
    return {
      ok: false,
      issues: [issue('too-many', `A manifest may contain at most ${MANIFEST_FILE_CAP} entries.`)],
    }
  }

  const issues: PlanIssue[] = []
  const nodes: FileNode[] = []
  const seen = new Set<string>()

  input.files.forEach((entry, index) => {
    const label = `files[${index}]`
    if (!isRecord(entry)) {
      issues.push(issue('bad-entry', 'Each file entry must be an object.', label))
      return
    }
    const keys = Object.keys(entry)
    const banned = keys.find((key) => BANNED_KEYS.has(key.toLowerCase()))
    if (banned) {
      issues.push(
        issue('content-field', 'Manifest entries cannot carry file contents.', `${label}.${banned}`),
      )
      return
    }
    const unexpected = keys.find((key) => !ALLOWED_KEYS.has(key))
    if (unexpected) {
      issues.push(issue('unexpected-field', 'That field is not allowed on a file entry.', `${label}.${unexpected}`))
      return
    }
    if (typeof entry.relPath !== 'string') {
      issues.push(issue('bad-path', 'relPath must be a string.', label))
      return
    }
    const normalized = normalizeRelative(entry.relPath)
    if (!normalized.ok) {
      issues.push(issue('bad-path', normalized.reason, entry.relPath))
      return
    }
    const pathKey = normalized.path.toLowerCase()
    if (seen.has(pathKey)) {
      issues.push(issue('duplicate-path', 'Two entries use the same path, ignoring case.', normalized.path))
      return
    }
    seen.add(pathKey)

    const kind = entry.kind === undefined ? 'file' : entry.kind
    if (kind !== 'file' && kind !== 'dir') {
      issues.push(issue('bad-kind', 'kind must be file or dir.', normalized.path))
      return
    }
    if (typeof entry.sizeBytes !== 'number' || !Number.isInteger(entry.sizeBytes) || entry.sizeBytes < 0) {
      issues.push(issue('bad-size', 'sizeBytes must be a non-negative integer.', normalized.path))
      return
    }
    if (typeof entry.mtimeMs !== 'number' || !Number.isInteger(entry.mtimeMs) || entry.mtimeMs < 0) {
      issues.push(issue('bad-mtime', 'mtimeMs must be a non-negative integer.', normalized.path))
      return
    }
    let contentHash: string | null = null
    if (entry.contentHash !== undefined && entry.contentHash !== null) {
      if (typeof entry.contentHash !== 'string' || !HASH_PATTERN.test(entry.contentHash)) {
        issues.push(
          issue('bad-hash', 'contentHash must be a short label, not file text.', normalized.path),
        )
        return
      }
      contentHash = entry.contentHash
    }
    const flagged = entry.protected === true
    if (entry.protected !== undefined && typeof entry.protected !== 'boolean') {
      issues.push(issue('bad-protected', 'protected must be a boolean.', normalized.path))
      return
    }
    nodes.push({
      id: newId(),
      relPath: normalized.path,
      kind,
      sizeBytes: entry.sizeBytes,
      mtimeMs: entry.mtimeMs,
      contentHash,
      protected: flagged || isProtectedRelPath(normalized.path),
      quarantined: false,
    })
  })

  if (issues.length > 0) return { ok: false, issues }

  for (const node of nodes) {
    if (node.kind !== 'file') continue
    const parts = node.relPath.split('/')
    parts.pop()
    let acc = ''
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part
      const parent = nodes.find((item) => item.relPath.toLowerCase() === acc.toLowerCase())
      if (parent && parent.kind === 'file') {
        issues.push(issue('parent-is-file', 'A parent folder path is already a file.', acc))
      }
    }
  }
  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, nodes: synthesizeParents(nodes, newId) }
}
