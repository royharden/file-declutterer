const RESERVED_SEGMENT = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i
const PROTECTED_SEGMENTS = new Set(['.git', 'node_modules'])
const PROTECTED_BASENAMES = /^(readme|license|copying)(\.[a-z0-9]+)?$/i
const LOCKFILES = new Set(['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'])

export type PathResult = { ok: true; path: string } | { ok: false; reason: string }

export function isSafeToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,80}$/.test(value)
}

export function isReservedSegment(segment: string): boolean {
  return RESERVED_SEGMENT.test(segment)
}

export function isTempPath(relPath: string): boolean {
  return relPath.split('/')[0]?.toLowerCase() === '.declutter-tmp'
}

export function isUnderQuarantine(relPath: string): boolean {
  return relPath.split('/')[0]?.toLowerCase() === '.quarantine'
}

/** Organize plans may not read or write the temp parking folder or quarantine. */
export function isUnderReserved(relPath: string): boolean {
  return isTempPath(relPath) || isUnderQuarantine(relPath)
}

export function isProtectedRelPath(relPath: string): boolean {
  const parts = relPath.split('/')
  if (parts.some((part) => PROTECTED_SEGMENTS.has(part.toLowerCase()))) return true
  const base = parts[parts.length - 1]?.toLowerCase() ?? ''
  if (LOCKFILES.has(base)) return true
  if (base === '.env' || base.startsWith('.env.')) return true
  return PROTECTED_BASENAMES.test(base)
}

export function extensionOf(relPath: string): string {
  const base = relPath.split('/').pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return ''
  return base.slice(dot).toLowerCase()
}

export function normalizeRelative(input: string): PathResult {
  if (typeof input !== 'string' || input.length === 0) {
    return { ok: false, reason: 'empty path' }
  }
  if (input.length > 240) return { ok: false, reason: 'path too long' }
  if (input.includes('\\')) return { ok: false, reason: 'backslash is not allowed' }
  if (input.includes('\0')) return { ok: false, reason: 'nul byte' }
  if (input.startsWith('/') || /^[A-Za-z]:/.test(input)) {
    return { ok: false, reason: 'absolute path' }
  }

  const parts = input.split('/')
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    return { ok: false, reason: 'empty, dot, or parent segment' }
  }

  for (const segment of parts) {
    if (segment !== segment.trim()) {
      return { ok: false, reason: 'leading or trailing space' }
    }
    if (segment.endsWith('.')) return { ok: false, reason: 'trailing dot' }
    if (/[<>:"|?*\u0000-\u001f]/.test(segment)) {
      return { ok: false, reason: 'illegal character' }
    }
    if (isReservedSegment(segment)) {
      return { ok: false, reason: 'reserved Windows name' }
    }
  }

  return { ok: true, path: parts.join('/') }
}
