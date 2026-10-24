import { utf8Encode } from '../core/fingerprint.js'
import type { ScanManifest } from '../core/types.js'
import { MemoryFs } from './memory-fs.js'

// Deterministic synthetic workspace for the hosted sandbox (PLAN §3). Every file carries real
// bytes so hashes, duplicates and recovery manifests are computed, not labelled. Names that a
// native volume cannot hold live in proposal/trap fixtures instead.

const TEXT = (s: string): Uint8Array => utf8Encode(s)

export interface SeedFile {
  path: string
  content: string
}

export const SEED_FILES: SeedFile[] = [
  // Loose root files: category candidates.
  { path: 'Q3 report.pdf', content: '%PDF-1.7 quarterly report Q3 2026' },
  { path: 'invoice-2026-09.pdf', content: '%PDF-1.7 invoice September 2026 total 412.00' },
  { path: 'notes.txt', content: 'Meeting notes: ship the sandbox first.' },
  { path: 'Budget 2026.xlsx', content: 'PK budget workbook 2026' },
  { path: 'slides-final.pptx', content: 'PK slides final deck' },
  { path: 'IMG_0412.jpg', content: 'JFIF beach photo 0412' },
  { path: 'IMG_0413.jpg', content: 'JFIF beach photo 0413' },
  { path: 'screenshot 2026-10-01.png', content: 'PNG screenshot of settings page' },
  { path: 'podcast-ep12.mp3', content: 'ID3 podcast episode 12' },
  { path: 'clip.mp4', content: 'ftypmp42 short clip' },
  { path: 'archive-old.zip', content: 'PK old archive' },
  { path: 'setup-tool.exe', content: 'MZ installer for a tool' },
  { path: 'script.py', content: 'print("hello")\n' },
  { path: 'data.csv', content: 'id,name\n1,alpha\n2,beta\n' },
  { path: 'mystery.xyz', content: 'unknown format payload' },
  { path: '%41.txt', content: 'literal percent name, never decoded' },
  { path: 'empty.log', content: '' },
  { path: 'sample-a.dat', content: 'AAAAAAAAAAAAAAAA' },
  { path: 'sample-b.dat', content: 'BBBBBBBBBBBBBBBB' },
  // Loose protected markers: never organized.
  { path: 'README.md', content: '# My files\n' },
  { path: 'LICENSE', content: 'All rights reserved.\n' },
  { path: '.env', content: 'NAME_ONLY=placeholder\n' },
  // Downloads: case and Unicode destination clashes, plus true duplicates.
  { path: 'Downloads/Report Final.pdf', content: '%PDF-1.7 report final version A' },
  { path: 'Downloads/old/report final.pdf', content: '%PDF-1.7 report final version B' },
  { path: 'Downloads/café.txt', content: 'composed e-acute' },
  { path: 'Downloads/old/café.txt', content: 'decomposed e + combining acute' },
  { path: 'Downloads/IMG_0412 (1).jpg', content: 'JFIF beach photo 0412' },
  { path: 'Downloads/invoice-2026-09 copy.pdf', content: '%PDF-1.7 invoice September 2026 total 412.00' },
  { path: 'Downloads/notes (2).txt', content: 'Meeting notes: ship the sandbox first.' },
  { path: 'Downloads/song.flac', content: 'fLaC song bytes' },
  { path: 'Downloads/old/installer.msi', content: 'MSI package bytes' },
  // Desktop.
  { path: 'Desktop/todo.docx', content: 'PK todo list document' },
  { path: 'Desktop/photo.heic', content: 'ftypheic phone photo' },
  { path: 'Desktop/Thumbs.db', content: 'thumbnail cache' },
  // Project subtrees: left whole.
  { path: 'Projects/webapp/package.json', content: '{"name":"webapp"}' },
  { path: 'Projects/webapp/src/index.js', content: 'console.log("app")' },
  { path: 'Projects/webapp/README.md', content: '# webapp' },
  { path: 'Projects/tool/.git/HEAD', content: 'ref: refs/heads/main' },
  { path: 'Projects/tool/main.go', content: 'package main' },
  { path: 'Projects/loose-sketch.svg', content: '<svg></svg>' },
]

export function createSandbox(): MemoryFs {
  const fs = new MemoryFs('sandbox-root', 'Sandbox (in memory)')
  let mtime = Date.UTC(2026, 8, 1)
  for (const file of SEED_FILES) {
    mtime += 60_000
    fs.writeFile(file.path, TEXT(file.content), mtime)
  }
  return fs
}

/**
 * Simulated AI example (PLAN §3 step 3). A fixed response in the Proposal v1 shape, including
 * deliberately invalid items so the rejection paths are visible. Never presented as real inference.
 */
export function simulatedResponse(scan: ScanManifest): unknown {
  const id = (path: string): string => scan.files.find((f) => f.relPath === path)?.id ?? `missing:${path}`
  const proposals: Record<string, unknown>[] = []
  const add = (path: string, categoryId: string, basename: string, confidence: number, reason: string): void => {
    if (scan.files.some((f) => f.relPath === path)) proposals.push({ fileId: id(path), categoryId, basename, confidence, reason })
  }
  add('Q3 report.pdf', 'documents', '2026-Q3 Report', 0.92, 'Quarterly report PDF.')
  add('invoice-2026-09.pdf', 'documents', 'Invoice 2026-09', 0.95, 'Invoice with a date in the name.')
  add('notes.txt', 'documents', 'Meeting Notes', 0.7, 'Plain-text notes.')
  add('Budget 2026.xlsx', 'spreadsheets', 'Budget 2026', 0.97, 'Spreadsheet.')
  add('slides-final.pptx', 'presentations', 'Slides Final', 0.9, 'Slide deck.')
  add('IMG_0412.jpg', 'images', 'Beach 0412', 0.8, 'Photo.')
  add('IMG_0413.jpg', 'images', 'Beach 0413', 0.8, 'Photo.')
  add('podcast-ep12.mp3', 'audio', 'Podcast Episode 12', 0.88, 'Audio episode.')
  add('clip.mp4', 'video', 'Clip', 0.6, 'Short video.')
  add('data.csv', 'spreadsheets', 'Data', 0.45, 'Could be code input or a spreadsheet; low confidence.')
  // Invalid on purpose: off-list category (T33), encoded traversal (T10), misleading suffix (T32).
  add('archive-old.zip', 'taxes', 'Old Archive', 0.9, 'Off-list category; must be rejected, not mapped.')
  add('mystery.xyz', 'other', '%2e%2e%2fescape', 0.9, 'Encoded traversal; must be rejected.')
  add('setup-tool.exe', 'documents', 'invoice.pdf', 0.99, 'Misleading suffix; must be blocked until edited.')
  // Extra field (T11): the whole item is rejected.
  if (scan.files.some((f) => f.relPath === 'script.py')) {
    proposals.push({ fileId: id('script.py'), categoryId: 'code', basename: 'script', confidence: 0.9, reason: 'Code.', path: '../../etc' })
  }
  return { proposals }
}
