import { extensionOf, isProtectedRelPath, isUnderReserved, normalizeRelative } from './paths'
import type { FileNode, MoveRequest, PlanIssue, PlannedMove } from './types'

function findCI(nodes: FileNode[], relPath: string): FileNode | undefined {
  const key = relPath.toLowerCase()
  return nodes.find((node) => node.relPath.toLowerCase() === key)
}

export function validateOrganizeMoves(
  nodes: FileNode[],
  moves: MoveRequest[],
): { ok: true; planned: PlannedMove[] } | { ok: false; issues: PlanIssue[] } {
  const issues: PlanIssue[] = []
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const seenIds = new Set<string>()
  const planned: PlannedMove[] = []

  for (const move of moves) {
    if (seenIds.has(move.nodeId)) {
      issues.push({
        code: 'duplicate-node',
        message: 'The same file is in the plan twice.',
        path: move.nodeId,
      })
      continue
    }
    seenIds.add(move.nodeId)

    const node = byId.get(move.nodeId)
    if (!node) {
      issues.push({
        code: 'missing-node',
        message: 'That file is not in the workspace.',
        path: move.nodeId,
      })
      continue
    }
    if (node.kind !== 'file') {
      issues.push({
        code: 'not-a-file',
        message: 'Only files can be organized. Folders stay where they are.',
        path: node.relPath,
      })
      continue
    }
    if (node.protected || isProtectedRelPath(node.relPath)) {
      issues.push({
        code: 'protected',
        message: 'Protected files cannot be moved.',
        path: node.relPath,
      })
      continue
    }
    if (isUnderReserved(node.relPath)) {
      issues.push({
        code: 'reserved-source',
        message: 'Files in system folders are outside an organize plan.',
        path: node.relPath,
      })
      continue
    }

    const dest = normalizeRelative(move.toPath)
    if (!dest.ok) {
      issues.push({ code: 'bad-destination', message: dest.reason, path: move.toPath })
      continue
    }
    if (extensionOf(node.relPath) !== extensionOf(dest.path)) {
      issues.push({
        code: 'extension-changed',
        message: 'The file extension must stay the same.',
        path: dest.path,
      })
      continue
    }
    if (isUnderReserved(dest.path)) {
      issues.push({
        code: 'reserved-destination',
        message: 'An organize plan cannot move files into a system folder.',
        path: dest.path,
      })
      continue
    }
    if (dest.path === node.relPath) continue

    planned.push({
      nodeId: node.id,
      fromPath: node.relPath,
      toPath: dest.path,
      sizeBytes: node.sizeBytes,
      mtimeMs: node.mtimeMs,
    })
  }

  const moverIds = new Set(planned.map((move) => move.nodeId))
  const occupied = new Map<string, string>()
  for (const node of nodes) {
    if (!moverIds.has(node.id)) occupied.set(node.relPath.toLowerCase(), node.id)
  }

  const claimed = new Map<string, string>()
  for (const move of planned) {
    const key = move.toPath.toLowerCase()
    if (claimed.has(key)) {
      issues.push({
        code: 'case-collision',
        message: 'Two files would land on the same path, ignoring case.',
        path: move.toPath,
      })
    } else {
      claimed.set(key, move.nodeId)
    }
    if (occupied.has(key)) {
      issues.push({
        code: 'destination-occupied',
        message: 'The destination is already used by a file that is not moving.',
        path: move.toPath,
      })
    }

    const parentParts = move.toPath.split('/')
    parentParts.pop()
    let acc = ''
    for (const part of parentParts) {
      acc = acc ? `${acc}/${part}` : part
      const parent = findCI(nodes, acc)
      if (parent && parent.kind === 'file' && !moverIds.has(parent.id)) {
        issues.push({
          code: 'parent-is-file',
          message: 'A parent folder path is already a file.',
          path: acc,
        })
      }
    }
  }

  const destinations = planned.map((move) => move.toPath)
  for (const dest of destinations) {
    const prefix = `${dest.toLowerCase()}/`
    if (destinations.some((other) => other !== dest && other.toLowerCase().startsWith(prefix))) {
      issues.push({
        code: 'destination-is-parent',
        message: 'A destination path contains another destination.',
        path: dest,
      })
    }
  }

  if (issues.length > 0) return { ok: false, issues }
  return { ok: true, planned }
}
