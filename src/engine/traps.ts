import { exactDuplicateGroups } from './duplicates'
import { applyAll, prepareApply, prepareQuarantine, prepareUndo, recover, step } from './journal'
import { parseManifest } from './manifest'
import { normalizeRelative } from './paths'
import { proposeByRules } from './rules'
import { sampleNodes } from './sample'
import type { FileNode, Journal, PlanIssue } from './types'
import { validateOrganizeMoves } from './validate'

export interface TrapResult {
  id: string
  title: string
  passed: boolean
  detail: string
}

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

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

function mustJournal(
  result: { ok: true; journal: Journal } | { ok: false; issues: PlanIssue[] },
): Journal {
  if (!result.ok) throw new Error(result.issues.map((item) => item.code).join(', '))
  return result.journal
}

function failIssues(
  result: { ok: true; journal: Journal } | { ok: false; issues: PlanIssue[] },
): PlanIssue[] {
  if (result.ok) throw new Error('expected the plan to be refused')
  return result.issues
}

function run(id: string, title: string, check: () => void): TrapResult {
  try {
    check()
    return { id, title, passed: true, detail: 'passed' }
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'failed'
    return { id, title, passed: false, detail }
  }
}

export function runTraps(): TrapResult[] {
  return [
    run('reject-parent-segment', 'Reject a destination that climbs out of the workspace', () => {
      const result = normalizeRelative('../outside.txt')
      expect(!result.ok && result.reason === 'empty, dot, or parent segment', result.ok ? 'accepted' : result.reason)
    }),
    run('reject-absolute-path', 'Reject an absolute destination', () => {
      const result = normalizeRelative('/etc/passwd')
      expect(!result.ok && result.reason === 'absolute path', result.ok ? 'accepted' : result.reason)
    }),
    run('reject-empty-path', 'Reject an empty path', () => {
      const result = normalizeRelative('')
      expect(!result.ok && result.reason === 'empty path', result.ok ? 'accepted' : result.reason)
    }),
    run('reject-reserved-name', 'Reject a Windows reserved device name', () => {
      const result = normalizeRelative('Documents/CON.txt')
      expect(!result.ok && result.reason === 'reserved Windows name', result.ok ? 'accepted' : result.reason)
    }),
    run('reject-trailing-dot', 'Reject a trailing dot', () => {
      const result = normalizeRelative('notes.')
      expect(!result.ok && result.reason === 'trailing dot', result.ok ? 'accepted' : result.reason)
    }),
    run('reject-case-collision', 'Reject two destinations that differ only by case', () => {
      const nodes = [file('a', 'a.txt'), file('b', 'b.txt')]
      const issues = failIssues(
        validateOrganizeMoves(nodes, [
          { nodeId: 'a', toPath: 'Documents/File.txt' },
          { nodeId: 'b', toPath: 'Documents/file.txt' },
        ]),
      )
      expect(issues.some((item) => item.code === 'case-collision'), issues.map((item) => item.code).join(', '))
    }),
    run('case-only-rename-uses-temp', 'A case-only rename parks the file in a temp name', () => {
      const nodes = [file('a', 'report.pdf')]
      const journal = mustJournal(
        prepareApply(nodes, [{ nodeId: 'a', toPath: 'Report.pdf' }], { journalId: 'j-case', planId: null }),
      )
      expect(
        journal.entries.some((entry) => entry.toPath.startsWith('.declutter-tmp/')),
        'no temp hop',
      )
      const done = applyAll(nodes, journal)
      expect(done.journal.status === 'committed', done.journal.status)
      expect(done.nodes.find((node) => node.id === 'a')?.relPath === 'Report.pdf', 'final path')
    }),
    run('swap-cycle-preserves-both', 'A two-file swap keeps both files', () => {
      const nodes = [file('a', 'a.txt'), file('b', 'b.txt')]
      const journal = mustJournal(
        prepareApply(
          nodes,
          [
            { nodeId: 'a', toPath: 'b.txt' },
            { nodeId: 'b', toPath: 'a.txt' },
          ],
          { journalId: 'j-swap', planId: null },
        ),
      )
      const done = applyAll(nodes, journal)
      expect(done.journal.status === 'committed', done.journal.status)
      expect(done.nodes.find((node) => node.id === 'a')?.relPath === 'b.txt', 'a landed')
      expect(done.nodes.find((node) => node.id === 'b')?.relPath === 'a.txt', 'b landed')
    }),
    run('protected-file-blocked', 'A protected marker cannot be moved', () => {
      const issues = failIssues(
        prepareApply([file('r', 'README.md')], [{ nodeId: 'r', toPath: 'Documents/README.md' }], {
          journalId: 'j-prot',
          planId: null,
        }),
      )
      expect(issues.some((item) => item.code === 'protected'), issues.map((item) => item.code).join(', '))
    }),
    run('occupied-destination-blocked', 'Refuse a destination that a staying file already uses', () => {
      const issues = failIssues(
        prepareApply(
          [file('a', 'a.txt'), file('c', 'c.txt')],
          [{ nodeId: 'a', toPath: 'c.txt' }],
          { journalId: 'j-occ', planId: null },
        ),
      )
      expect(
        issues.some((item) => item.code === 'destination-occupied'),
        issues.map((item) => item.code).join(', '),
      )
    }),
    run('changed-size-blocks-apply', 'A size change after the scan blocks the move', () => {
      const nodes = [file('a', 'a.txt', { sizeBytes: 10 })]
      const journal = mustJournal(
        prepareApply(nodes, [{ nodeId: 'a', toPath: 'Misc/a.txt' }], { journalId: 'j-chg', planId: null }),
      )
      const tampered = nodes.map((node) => ({ ...node, sizeBytes: 99 }))
      const applied = applyAll(tampered, journal)
      expect(applied.journal.status === 'needs_recovery', applied.journal.status)
      expect(applied.nodes.find((node) => node.id === 'a')?.relPath === 'a.txt', 'file moved anyway')
      expect(
        applied.journal.entries.some((entry) => entry.phase === 'blocked' && entry.note.includes('size')),
        'missing size block',
      )
    }),
    run('undo-refuses-changed-mtime', 'Undo refuses a file whose mtime changed', () => {
      const nodes = [file('a', 'a.txt', { mtimeMs: 1000 })]
      const journal = mustJournal(
        prepareApply(nodes, [{ nodeId: 'a', toPath: 'Documents/a.txt' }], { journalId: 'j-mtime', planId: null }),
      )
      const done = applyAll(nodes, journal)
      expect(done.journal.status === 'committed', done.journal.status)
      const changed = done.nodes.map((node) => (node.id === 'a' ? { ...node, mtimeMs: 5000 } : node))
      const issues = failIssues(prepareUndo(changed, done.journal, { journalId: 'j-undo-mtime', planId: null }))
      expect(
        issues.some((item) => item.code === 'changed-since-apply'),
        issues.map((item) => item.code).join(', '),
      )
    }),
    run('undo-refuses-occupied-original', 'Undo does not overwrite an occupied original path', () => {
      const nodes = [file('a', 'a.txt')]
      const journal = mustJournal(
        prepareApply(nodes, [{ nodeId: 'a', toPath: 'Documents/a.txt' }], { journalId: 'j-back', planId: null }),
      )
      const done = applyAll(nodes, journal)
      const withOccupier = [...done.nodes, file('other', 'a.txt')]
      const issues = failIssues(
        prepareUndo(withOccupier, done.journal, { journalId: 'j-undo-occ', planId: null }),
      )
      expect(
        issues.some((item) => item.code === 'original-occupied'),
        issues.map((item) => item.code).join(', '),
      )
    }),
    run('crash-before-mutation-rolls-back', 'An open journal with no mutations rolls back cleanly', () => {
      const nodes = [file('a', 'a.txt'), file('b', 'b.txt')]
      const journal = mustJournal(
        prepareApply(
          nodes,
          [
            { nodeId: 'a', toPath: 'Documents/a.txt' },
            { nodeId: 'b', toPath: 'Photos/b.txt' },
          ],
          { journalId: 'j-before', planId: null },
        ),
      )
      expect(journal.status === 'open', journal.status)
      expect(journal.entries.every((entry) => entry.phase === 'planned'), 'journal was not fully planned')
      const recovered = recover(nodes, journal)
      expect(recovered.journal.status === 'rolled_back', recovered.journal.status)
      expect(recovered.nodes.length === nodes.length, 'rollback created or dropped files')
      expect(
        recovered.nodes.every((node, index) => node.relPath === nodes[index]?.relPath),
        'paths changed',
      )
    }),
    run('crash-mid-apply-restores', 'A crash after the first rename restores every path', () => {
      const nodes = [file('a', 'a.txt'), file('b', 'b.txt')]
      const journal = mustJournal(
        prepareApply(
          nodes,
          [
            { nodeId: 'a', toPath: 'Documents/a.txt' },
            { nodeId: 'b', toPath: 'Photos/b.txt' },
          ],
          { journalId: 'j-mid', planId: null },
        ),
      )
      let currentNodes = nodes
      let current = journal
      let sawRename = false
      for (let guard = 0; guard < 20; guard += 1) {
        const next = step(currentNodes, current)
        currentNodes = next.nodes
        current = next.journal
        if (next.event !== 'advanced') throw new Error(next.event)
        if (current.entries.some((entry) => entry.op === 'rename' && entry.phase === 'done')) {
          sawRename = true
          break
        }
      }
      expect(sawRename, 'no rename was applied')
      expect(currentNodes.find((node) => node.id === 'a')?.relPath !== 'a.txt', 'first file never left')
      const recovered = recover(currentNodes, current)
      expect(recovered.journal.status === 'rolled_back', recovered.journal.status)
      expect(recovered.nodes.find((node) => node.id === 'a')?.relPath === 'a.txt', 'a not restored')
      expect(recovered.nodes.find((node) => node.id === 'b')?.relPath === 'b.txt', 'b changed')
    }),
    run('organize-plan-cannot-quarantine', 'An organize plan cannot move a file into quarantine', () => {
      const issues = failIssues(
        prepareApply([file('a', 'a.txt')], [{ nodeId: 'a', toPath: '.quarantine/a.txt' }], {
          journalId: 'j-noq',
          planId: null,
        }),
      )
      expect(
        issues.some((item) => item.code === 'reserved-destination'),
        issues.map((item) => item.code).join(', '),
      )
      const journal = mustJournal(
        prepareApply([file('a', 'a.txt')], [{ nodeId: 'a', toPath: 'Documents/a.txt' }], {
          journalId: 'j-ops',
          planId: null,
        }),
      )
      expect(
        journal.entries.every((entry) => entry.op === 'mkdir' || entry.op === 'rename'),
        'organize journal contained another operation',
      )
    }),
    run('quarantine-keeps-the-file', 'Quarantine moves the extra duplicate and keeps the row', () => {
      const nodes = [
        file('keep', 'a-budget.xlsx', { contentHash: 'h-budget', sizeBytes: 50 }),
        file('extra', 'b-budget.xlsx', { contentHash: 'h-budget', sizeBytes: 50 }),
      ]
      const groups = exactDuplicateGroups(nodes)
      expect(groups.length === 1 && groups[0]?.keeperId === 'keep', 'keeper was not the first path')
      expect(groups[0]?.extraIds.join() === 'extra', 'extra duplicate missing')
      const journal = mustJournal(prepareQuarantine(nodes, ['extra'], { journalId: 'q-keep', planId: null }))
      const done = applyAll(nodes, journal)
      expect(done.journal.status === 'committed', done.journal.status)
      const extra = done.nodes.find((node) => node.id === 'extra')
      expect(extra?.kind === 'file' && extra.relPath.startsWith('.quarantine/'), extra?.relPath ?? 'missing')
      expect(done.nodes.find((node) => node.id === 'keep')?.relPath === 'a-budget.xlsx', 'keeper moved')
    }),
    run('manifest-rejects-content-fields', 'A manifest that carries file text is rejected', () => {
      const parsed = parseManifest(
        { files: [{ relPath: 'a.txt', sizeBytes: 1, mtimeMs: 1, content: 'secret' }] },
        () => 'id',
      )
      expect(!parsed.ok, 'content was accepted')
      if (!parsed.ok) {
        expect(
          parsed.issues.some((item) => item.code === 'content-field'),
          parsed.issues.map((item) => item.code).join(', '),
        )
      }
    }),
    run('extension-must-stay', 'A proposal cannot change the extension', () => {
      const issues = failIssues(
        prepareApply([file('a', 'a.txt')], [{ nodeId: 'a', toPath: 'Documents/a.pdf' }], {
          journalId: 'j-ext',
          planId: null,
        }),
      )
      expect(
        issues.some((item) => item.code === 'extension-changed'),
        issues.map((item) => item.code).join(', '),
      )
    }),
    run('rules-skip-protected', 'Rules mode skips protected files and still surfaces the sample collision', () => {
      const nodes = sampleNodes()
      const moves = proposeByRules(nodes)
      const protectedIds = ['s-readme', 's-license', 's-package', 's-git', 's-env']
      expect(
        moves.every((move) => !protectedIds.includes(move.nodeId)),
        'a protected file was proposed',
      )
      const validated = validateOrganizeMoves(nodes, moves)
      expect(!validated.ok, 'the sample case collision was not reported')
      if (!validated.ok) {
        expect(
          validated.issues.some((item) => item.code === 'case-collision'),
          validated.issues.map((item) => item.code).join(', '),
        )
      }
    }),
    run('journal-written-before-mutation', 'Preparing and applying does not mutate the caller array', () => {
      const nodes = [file('a', 'a.txt')]
      const journal = mustJournal(
        prepareApply(nodes, [{ nodeId: 'a', toPath: 'Documents/a.txt' }], {
          journalId: 'j-order',
          planId: null,
        }),
      )
      expect(journal.entries.every((entry) => entry.phase === 'planned'), 'entries were not all planned')
      expect(nodes[0]?.relPath === 'a.txt', 'prepare mutated the node')
      applyAll(nodes, journal)
      expect(nodes[0]?.relPath === 'a.txt', 'apply mutated the caller array')
    }),
  ]
}

export function scoreTraps(results: TrapResult[]): { passed: number; total: number } {
  return {
    passed: results.filter((result) => result.passed).length,
    total: results.length,
  }
}
