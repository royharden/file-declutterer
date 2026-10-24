import { extensionOf, isProtectedRelPath, isReservedSegment, isUnderReserved, normalizeRelative } from './paths'
import type { FileNode, MoveRequest } from './types'

const FOLDERS: { folder: string; extensions: string[] }[] = [
  { folder: 'Photos', extensions: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic'] },
  { folder: 'Audio', extensions: ['.mp3', '.wav', '.flac', '.m4a', '.aac'] },
  { folder: 'Video', extensions: ['.mp4', '.mov', '.mkv', '.webm'] },
  { folder: 'Archives', extensions: ['.zip', '.7z', '.rar', '.tar', '.gz'] },
  { folder: 'Documents', extensions: ['.pdf', '.doc', '.docx', '.txt', '.md', '.rtf', '.xls', '.xlsx', '.csv', '.ppt', '.pptx'] },
  { folder: 'Code', extensions: ['.js', '.ts', '.tsx', '.jsx', '.py', '.json', '.css', '.html'] },
]

export function folderForExtension(relPath: string): string {
  const extension = extensionOf(relPath)
  for (const rule of FOLDERS) {
    if (rule.extensions.includes(extension)) return rule.folder
  }
  return 'Misc'
}

export function sanitizeBase(base: string): string {
  const extension = extensionOf(base)
  const stem = extension ? base.slice(0, -extension.length) : base
  let cleaned = stem.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/^[. ]+|[. ]+$/g, '')
  if (!cleaned || isReservedSegment(cleaned) || isReservedSegment(`${cleaned}${extension}`)) {
    cleaned = cleaned ? `file-${cleaned}` : 'file'
  }
  return `${cleaned}${extension}`
}

/** Extension rules only. This is not a model and must not be labeled as one. */
export function proposeByRules(nodes: FileNode[]): MoveRequest[] {
  const moves: MoveRequest[] = []
  for (const node of nodes) {
    if (node.kind !== 'file') continue
    if (node.protected || isProtectedRelPath(node.relPath) || isUnderReserved(node.relPath)) continue
    const base = node.relPath.split('/').pop() ?? node.relPath
    const toPath = `${folderForExtension(base)}/${sanitizeBase(base)}`
    const normalized = normalizeRelative(toPath)
    if (!normalized.ok) continue
    if (normalized.path === node.relPath) continue
    moves.push({ nodeId: node.id, toPath: normalized.path })
  }
  return moves
}
