import { describe, expect, it } from 'vitest'
import { exactDuplicateGroups } from '../src/engine/duplicates'
import { applyAll, prepareApply, prepareQuarantine, prepareUndo, recover } from '../src/engine/journal'
import { sanitizeBase } from '../src/engine/rules'
import type { FileNode, Journal } from '../src/engine/types'

function file(id: string, relPath: string, extra: Partial<FileNode> = {}): FileNode {
  return {
    id,
    relPath,
    kind: 'file',
    sizeBytes: 10,
    mtimeMs: 1000,
    contentHash: null,
    protected: false,
    quarantined: false,
    ...extra,
  }
}

function journalOf(
  result: { ok: true; journal: Journal } | { ok: false; issues: { code: string }[] },
): Journal {
  if (!result.ok) throw new Error(result.issues.map((item) => item.code).join(','))
  return result.journal
}

describe('journal apply and undo', () => {
  it('undoes a committed move back to the original path', () => {
    const nodes = [file('a', 'a.txt')]
    const applied = applyAll(
      nodes,
      journalOf(prepareApply(nodes, [{ nodeId: 'a', toPath: 'Documents/a.txt' }], { journalId: 'j-apply', planId: 'plan-1' })),
    )
    expect(applied.journal.status).toBe('committed')
    expect(applied.nodes.find((node) => node.id === 'a')?.relPath).toBe('Documents/a.txt')

    const undone = applyAll(
      applied.nodes,
      journalOf(prepareUndo(applied.nodes, applied.journal, { journalId: 'j-undo', planId: 'plan-1' })),
    )
    expect(undone.journal.kind).toBe('undo')
    expect(undone.journal.status).toBe('committed')
    expect(undone.nodes.find((node) => node.id === 'a')?.relPath).toBe('a.txt')
  })

  it('undoes a swap without treating the other file as an outside occupier', () => {
    const nodes = [file('a', 'a.txt'), file('b', 'b.txt')]
    const applied = applyAll(
      nodes,
      journalOf(
        prepareApply(
          nodes,
          [
            { nodeId: 'a', toPath: 'b.txt' },
            { nodeId: 'b', toPath: 'a.txt' },
          ],
          { journalId: 'j-swap', planId: null },
        ),
      ),
    )
    const undone = applyAll(
      applied.nodes,
      journalOf(prepareUndo(applied.nodes, applied.journal, { journalId: 'j-swap-undo', planId: null })),
    )
    expect(undone.nodes.find((node) => node.id === 'a')?.relPath).toBe('a.txt')
    expect(undone.nodes.find((node) => node.id === 'b')?.relPath).toBe('b.txt')
  })

  it('does not remove a directory that already existed', () => {
    const nodes: FileNode[] = [
      file('a', 'a.txt'),
      {
        id: 'd',
        relPath: 'Documents',
        kind: 'dir',
        sizeBytes: 0,
        mtimeMs: 0,
        contentHash: null,
        protected: false,
        quarantined: false,
      },
    ]
    const prepared = journalOf(
      prepareApply(nodes, [{ nodeId: 'a', toPath: 'Documents/a.txt' }], { journalId: 'j-dir', planId: null }),
    )
    expect(prepared.entries.some((entry) => entry.op === 'mkdir' && entry.toPath === 'Documents')).toBe(false)
    const recovered = recover(nodes, prepared)
    expect(recovered.nodes.find((node) => node.id === 'd')?.relPath).toBe('Documents')
    expect(recovered.journal.status).toBe('rolled_back')
  })

  it('rolls a size-change stop back to the original paths', () => {
    const nodes = [file('a', 'a.txt', { sizeBytes: 10 })]
    const prepared = journalOf(
      prepareApply(nodes, [{ nodeId: 'a', toPath: 'Misc/a.txt' }], { journalId: 'j-size', planId: null }),
    )
    const stopped = applyAll(
      nodes.map((node) => ({ ...node, sizeBytes: 99 })),
      prepared,
    )
    expect(stopped.journal.status).toBe('needs_recovery')
    const recovered = recover(stopped.nodes, stopped.journal)
    expect(recovered.journal.status).toBe('rolled_back')
    expect(recovered.nodes.find((node) => node.id === 'a')?.relPath).toBe('a.txt')
    expect(recovered.nodes.some((node) => node.relPath === 'Misc')).toBe(false)
  })

  it('refuses to quarantine a protected path', () => {
    const result = prepareQuarantine([file('r', 'README.md')], ['r'], { journalId: 'q-readme', planId: null })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.issues.some((item) => item.code === 'not-quarantineable')).toBe(true)
  })
})

describe('duplicates and names', () => {
  it('keeps the lexicographically first path and ignores singleton hashes', () => {
    const groups = exactDuplicateGroups([
      file('b', 'b.txt', { contentHash: 'same' }),
      file('a', 'a.txt', { contentHash: 'same' }),
      file('c', 'c.txt', { contentHash: 'once' }),
      file('q', '.quarantine/old/a.txt', { contentHash: 'same' }),
    ])
    expect(groups).toEqual([{ hash: 'same', keeperId: 'a', extraIds: ['b'] }])
  })

  it('renames a reserved device stem instead of keeping it', () => {
    expect(sanitizeBase('CON.txt')).toBe('file-CON.txt')
  })
})
