// Path policy shared by both profiles (PLAN §6). Validation never rewrites a name: it accepts
// the literal spelling or reports why not. No URI decoding, environment expansion or Unicode
// normalization of stored names; normalization is used only for comparison keys.

export const MAX_COMPONENT = 120
export const MAX_RELATIVE_PATH = 240

const DEVICE_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$|clock\$)$/i
// Windows-illegal characters plus both separators. ':' also covers drive letters and ADS.
const ILLEGAL_CHAR = /[<>:"|?*\\/]/
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/
// Percent-encoded path syntax: '.', '/', '\', ':', NUL and '%' itself (double encoding).
const ENCODED_PATH_SYNTAX = /%(2e|2f|5c|3a|00|25)/i

export type CheckResult = { ok: true } | { ok: false; code: string; reason: string }

const OK: CheckResult = { ok: true }

function fail(code: string, reason: string): CheckResult {
  return { ok: false, code, reason }
}

/** Device names are reserved with or without a suffix: CON, con.txt, NUL.tar.gz. */
export function isDeviceName(component: string): boolean {
  const stem = component.split('.')[0] ?? ''
  return DEVICE_NAME.test(stem.trimEnd())
}

export function checkComponent(component: string): CheckResult {
  const literal = checkComponentLiteral(component)
  if (!literal.ok) return literal
  // Compatibility forms (fullwidth solidus, dot, colon, small reverse solidus...) must not
  // become path syntax in the comparison key: run the same rules on the folded spelling.
  const folded = checkComponentLiteral(compareKey(component))
  if (!folded.ok) return fail('folded-syntax', `name folds to path syntax (${folded.reason})`)
  return OK
}

function checkComponentLiteral(component: string): CheckResult {
  if (component.length === 0) return fail('empty-segment', 'empty path segment')
  if (component === '.' || component === '..') return fail('traversal', 'dot or parent segment')
  if (CONTROL_CHAR.test(component)) return fail('control-char', 'control character or NUL')
  if (ILLEGAL_CHAR.test(component)) return fail('illegal-char', 'character not allowed in a name')
  if (/^[ .]/.test(component) || /[ .]$/.test(component)) {
    return fail('edge-dot-space', 'leading or trailing dot or space')
  }
  if (isDeviceName(component)) return fail('device-name', 'reserved Windows device name')
  if (component.length > MAX_COMPONENT) return fail('component-too-long', `name longer than ${MAX_COMPONENT}`)
  return OK
}

/**
 * Checks a root-relative path that the app would create. Rejects absolute, drive, UNC and ADS
 * forms, separators other than '/', and every component rule above.
 */
export function checkRelativePath(path: string): CheckResult {
  if (typeof path !== 'string' || path.length === 0) return fail('empty', 'empty path')
  if (path.length > MAX_RELATIVE_PATH) return fail('path-too-long', `path longer than ${MAX_RELATIVE_PATH}`)
  if (path.includes('\\')) return fail('backslash', 'backslash separator')
  if (path.startsWith('/') || path.startsWith('//')) return fail('absolute', 'absolute or UNC path')
  if (/^[A-Za-z]:/.test(path)) return fail('drive', 'drive-qualified path')
  for (const component of path.split('/')) {
    const result = checkComponent(component)
    if (!result.ok) return result
  }
  return OK
}

/**
 * A proposed basename (no extension). Stricter than a component: proposals may not carry
 * encoded path syntax, and the check never decodes. A literal source such as "%41" passes.
 */
export function checkProposedBasename(basename: string): CheckResult {
  if (typeof basename !== 'string') return fail('not-string', 'basename must be a string')
  if (ENCODED_PATH_SYNTAX.test(basename)) return fail('encoded-path', 'encoded path syntax in a proposed name')
  return checkComponent(basename)
}

/**
 * Final suffix after the last non-leading dot, exact case retained. "a.tar.gz" -> ".gz",
 * ".bashrc" -> "", "README" -> "". Policy id: final-suffix-v1.
 */
export const EXTENSION_POLICY = 'final-suffix-v1'

export function splitExtension(basename: string): { stem: string; ext: string } {
  const dot = basename.lastIndexOf('.')
  if (dot <= 0) return { stem: basename, ext: '' }
  return { stem: basename.slice(0, dot), ext: basename.slice(dot) }
}

/**
 * Conservative comparison key: compatibility-normalized and case-folded both ways so that
 * case variants, NFC/NFD spellings and width variants collide. Actual spelling is retained
 * everywhere else.
 */
export function compareKey(path: string): string {
  return path.normalize('NFKC').toUpperCase().toLowerCase().normalize('NFC')
}

export function samePathKey(a: string, b: string): boolean {
  return compareKey(a) === compareKey(b)
}
