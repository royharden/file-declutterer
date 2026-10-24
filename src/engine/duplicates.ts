import { isUnderReserved } from './paths'
import type { FileNode } from './types'

export interface DuplicateGroup {
  hash: string
  keeperId: string
  extraIds: string[]
}

/** Exact hash only. Hashes are supplied by the sample or the manifest. Bytes are never hashed here. */
export function exactDuplicateGroups(nodes: FileNode[]): DuplicateGroup[] {
  const groups = new Map<string, FileNode[]>()
  for (const node of nodes) {
    if (node.kind !== 'file' || !node.contentHash) continue
    if (isUnderReserved(node.relPath)) continue
    const list = groups.get(node.contentHash) ?? []
    list.push(node)
    groups.set(node.contentHash, list)
  }

  const result: DuplicateGroup[] = []
  for (const [hash, list] of groups) {
    if (list.length < 2) continue
    const sorted = [...list].sort((a, b) => a.relPath.localeCompare(b.relPath))
    const keeper = sorted[0]
    if (!keeper) continue
    result.push({
      hash,
      keeperId: keeper.id,
      extraIds: sorted.slice(1).map((node) => node.id),
    })
  }
  return result.sort((a, b) => a.hash.localeCompare(b.hash))
}
