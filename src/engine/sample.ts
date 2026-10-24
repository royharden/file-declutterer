import type { FileNode } from './types'

function node(partial: Omit<FileNode, 'quarantined'> & { quarantined?: boolean }): FileNode {
  return { quarantined: false, ...partial }
}

/**
 * Synthetic clutter. Hashes are labels, not digests of bytes.
 * The two "report final" names are a deliberate case collision for the review screen.
 */
export function sampleNodes(): FileNode[] {
  return [
    node({ id: 's-downloads', relPath: 'Downloads', kind: 'dir', sizeBytes: 0, mtimeMs: 0, contentHash: null, protected: false }),
    node({ id: 's-readme', relPath: 'README.md', kind: 'file', sizeBytes: 420, mtimeMs: 1_700_000_000_000, contentHash: null, protected: true }),
    node({ id: 's-license', relPath: 'LICENSE', kind: 'file', sizeBytes: 1100, mtimeMs: 1_700_000_000_000, contentHash: null, protected: true }),
    node({ id: 's-package', relPath: 'package.json', kind: 'file', sizeBytes: 300, mtimeMs: 1_700_000_000_000, contentHash: null, protected: true }),
    node({ id: 's-gitdir', relPath: '.git', kind: 'dir', sizeBytes: 0, mtimeMs: 0, contentHash: null, protected: true }),
    node({ id: 's-git', relPath: '.git/HEAD', kind: 'file', sizeBytes: 21, mtimeMs: 1_700_000_000_000, contentHash: null, protected: true }),
    node({ id: 's-env', relPath: '.env', kind: 'file', sizeBytes: 48, mtimeMs: 1_700_000_000_000, contentHash: null, protected: true }),
    node({ id: 's-report-lower', relPath: 'Downloads/report final.pdf', kind: 'file', sizeBytes: 22000, mtimeMs: 1_710_000_000_000, contentHash: null, protected: false }),
    node({ id: 's-report-upper', relPath: 'Downloads/Report Final.pdf', kind: 'file', sizeBytes: 22100, mtimeMs: 1_710_000_100_000, contentHash: null, protected: false }),
    node({ id: 's-photo', relPath: 'Downloads/IMG_001.jpg', kind: 'file', sizeBytes: 1_800_000, mtimeMs: 1_710_000_200_000, contentHash: null, protected: false }),
    node({ id: 's-png', relPath: 'vacation.png', kind: 'file', sizeBytes: 640000, mtimeMs: 1_710_000_300_000, contentHash: null, protected: false }),
    node({ id: 's-song', relPath: 'song.mp3', kind: 'file', sizeBytes: 4_400_000, mtimeMs: 1_710_000_400_000, contentHash: null, protected: false }),
    node({ id: 's-notes', relPath: 'notes.txt', kind: 'file', sizeBytes: 900, mtimeMs: 1_710_000_500_000, contentHash: null, protected: false }),
    node({ id: 's-zip', relPath: 'backup.zip', kind: 'file', sizeBytes: 9_000_000, mtimeMs: 1_710_000_600_000, contentHash: null, protected: false }),
    node({ id: 's-clip', relPath: 'clip.mp4', kind: 'file', sizeBytes: 12_000_000, mtimeMs: 1_710_000_700_000, contentHash: null, protected: false }),
    node({ id: 's-code', relPath: 'scratch.ts', kind: 'file', sizeBytes: 1500, mtimeMs: 1_710_000_800_000, contentHash: null, protected: false }),
    node({ id: 's-budget', relPath: 'budget.xlsx', kind: 'file', sizeBytes: 50000, mtimeMs: 1_710_000_900_000, contentHash: 'h-budget', protected: false }),
    node({ id: 's-budget-copy', relPath: 'Copy of budget.xlsx', kind: 'file', sizeBytes: 50000, mtimeMs: 1_710_001_000_000, contentHash: 'h-budget', protected: false }),
    node({ id: 's-download', relPath: 'download', kind: 'file', sizeBytes: 80, mtimeMs: 1_710_001_100_000, contentHash: null, protected: false }),
    node({ id: 's-invoices', relPath: 'Invoices', kind: 'dir', sizeBytes: 0, mtimeMs: 0, contentHash: null, protected: false }),
    node({ id: 's-invoice', relPath: 'Invoices/invoice-2026.pdf', kind: 'file', sizeBytes: 33000, mtimeMs: 1_710_001_200_000, contentHash: null, protected: false }),
  ]
}
