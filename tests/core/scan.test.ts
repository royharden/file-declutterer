import { describe, expect, it } from 'vitest'
import { MemoryFs } from '../../src/adapters/memory-fs'
import { createSandbox, SEED_FILES } from '../../src/adapters/sandbox-seed'
import { sha256Text } from '../../src/core/fingerprint'
import { checkProposedBasename, checkRelativePath, compareKey, splitExtension } from '../../src/core/paths'
import { scanRoot } from '../../src/core/scan'
import { utf8Encode } from '../../src/core/fingerprint'

describe('sha256', () => {
  it('matches FIPS 180-4 vectors', () => {
    expect(sha256Text('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256Text('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256Text('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    )
  })
})

describe('path policy (T09, T10)', () => {
  it.each(['../x', 'a/../b', '/abs', 'C:/x', '//server/share', 'a\\b', 'a:stream', 'CON', 'con.txt', 'NUL.tar.gz', 'a/ b', 'a/b.', 'x'.repeat(121), 'a\u0000b'])(
    'rejects %s',
    (path) => {
      expect(checkRelativePath(path).ok).toBe(false)
    },
  )
  it('rejects compatibility characters that fold to path syntax (T09)', () => {
    expect(checkRelativePath('a／b').ok).toBe(false)
    expect(checkProposedBasename('．．').ok).toBe(false)
    expect(checkProposedBasename('x：y').ok).toBe(false)
    expect(checkProposedBasename('a﹨b').ok).toBe(false)
  })
  it('accepts a literal %41 and rejects encoded traversal in proposals', () => {
    expect(checkRelativePath('%41.txt').ok).toBe(true)
    expect(checkProposedBasename('%41').ok).toBe(true)
    expect(checkProposedBasename('%2e%2e%2fescape').ok).toBe(false)
    expect(checkProposedBasename('%252e').ok).toBe(false)
  })
  it('splits the final suffix only', () => {
    expect(splitExtension('a.tar.gz')).toEqual({ stem: 'a.tar', ext: '.gz' })
    expect(splitExtension('.bashrc')).toEqual({ stem: '.bashrc', ext: '' })
    expect(splitExtension('Report.PDF')).toEqual({ stem: 'Report', ext: '.PDF' })
  })
  it('collides case and Unicode variants (T02 key)', () => {
    expect(compareKey('Report Final.pdf')).toBe(compareKey('report final.PDF'))
    expect(compareKey('caf\u00e9.txt')).toBe(compareKey('cafe\u0301.txt'))
  })
})

describe('scan', () => {
  it('skips project trees and protected names (T07)', async () => {
    const fs = createSandbox()
    const scan = await scanRoot(fs, { scanId: 's1' })
    expect(scan.status).toBe('complete')
    expect(scan.projectRoots.sort()).toEqual(['Projects/tool', 'Projects/webapp'])
    const paths = scan.files.map((f) => f.relPath)
    for (const banned of ['README.md', 'LICENSE', '.env', 'Desktop/Thumbs.db']) expect(paths).not.toContain(banned)
    expect(paths.some((p) => p.startsWith('Projects/webapp') || p.startsWith('Projects/tool'))).toBe(false)
    expect(paths).toContain('Projects/loose-sketch.svg')
    expect(paths).toContain('%41.txt')
    expect(scan.totals.zeroByte).toBe(1)
  })

  it('computes real hashes; same size different bytes differ (T14)', async () => {
    const scan = await scanRoot(createSandbox(), { scanId: 's2' })
    const a = scan.files.find((f) => f.relPath === 'sample-a.dat')!
    const b = scan.files.find((f) => f.relPath === 'sample-b.dat')!
    expect(a.size).toBe(b.size)
    expect(a.sha256).not.toBe(b.sha256)
    expect(a.provenance).toBe('computed-synthetic')
  })

  it('reports unhashable files as blocked (T14)', async () => {
    const fs = createSandbox()
    fs.injectFault({ op: 'sha256', nth: 1, path: 'notes.txt' })
    const scan = await scanRoot(fs, { scanId: 's3', hashConcurrency: 1 })
    expect(scan.skipped.find((s) => s.relPath === 'notes.txt')?.reason).toBe('unhashable')
    expect(scan.files.some((f) => f.relPath === 'notes.txt')).toBe(false)
  })

  it('aborts on bound overflow with no files (T13)', async () => {
    const fs = createSandbox()
    const scan = await scanRoot(fs, { scanId: 's4', bounds: { maxFiles: 5, maxBytes: 1e9, maxDepth: 4, maxEntries: 2000 } })
    expect(scan.status).toBe('aborted')
    expect(scan.files).toEqual([])
    const deep = new MemoryFs()
    deep.writeFile('a/b/c/d/e/f.txt', utf8Encode('deep'))
    expect((await scanRoot(deep, { scanId: 's5' })).status).toBe('aborted')
  })

  it('refuses a root that is itself a project', async () => {
    const fs = new MemoryFs()
    fs.writeFile('package.json', utf8Encode('{}'))
    fs.writeFile('a.txt', utf8Encode('a'))
    const scan = await scanRoot(fs, { scanId: 's6' })
    expect(scan.status).toBe('aborted')
  })

  it('excludes output and quarantine on ordinary scans (T34)', async () => {
    const fs = createSandbox()
    fs.writeFile('_Organized/Documents/x.pdf', utf8Encode('x'))
    fs.writeFile('_declutter-quarantine/run-1/y.txt', utf8Encode('y'))
    const organize = await scanRoot(fs, { scanId: 's7' })
    expect(organize.files.some((f) => f.relPath.startsWith('_'))).toBe(false)
    const dupes = await scanRoot(fs, { scanId: 's8', mode: 'duplicates' })
    expect(dupes.files.some((f) => f.relPath === '_Organized/Documents/x.pdf')).toBe(true)
    expect(dupes.files.some((f) => f.relPath.startsWith('_declutter-quarantine'))).toBe(false)
  })

  it('seeds about forty files', () => {
    expect(SEED_FILES.length).toBeGreaterThanOrEqual(38)
  })
})
