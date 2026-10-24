import * as fsp from 'node:fs/promises'
import * as path from 'node:path'

/**
 * True when child is parent itself or lies beneath it. A relative path escapes only when it is
 * exactly '..' or starts with '..' plus a separator; a child entry named '..plan.json' is inside.
 */
export function isWithin(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  if (rel === '') return true
  if (path.isAbsolute(rel)) return false
  return !(rel === '..' || rel.startsWith(`..${path.sep}`) || rel.startsWith('../'))
}

/**
 * Real location of a path that may not exist yet: the nearest existing ancestor is resolved
 * through links/junctions, and the missing remainder is appended unchanged.
 */
export async function realLocation(file: string): Promise<string> {
  let current = path.resolve(file)
  const missing: string[] = []
  for (;;) {
    try {
      return path.join(await fsp.realpath(current), ...missing.reverse())
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(file)
      missing.push(path.basename(current))
      current = parent
    }
  }
}
