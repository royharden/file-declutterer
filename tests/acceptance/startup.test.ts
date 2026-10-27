import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MemoryFs } from '../../src/adapters/memory-fs'
import { sha256Hex } from '../../src/core/fingerprint'
import { parseProposalText, PROPOSAL_LIMITS } from '../../src/core/proposal-schema'
import { scanRoot } from '../../src/core/scan'

describe('RV independent startup acceptance', () => {
  // what_bug_this_catches: hand-written SHA padding/length errors shared by application manifests.
  it('matches Node crypto at SHA-256 block and padding boundaries', () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 127, 128, 1024, 65537]) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 131 + length) % 256)
      expect(sha256Hex(bytes), `length ${length}`).toBe(createHash('sha256').update(bytes).digest('hex'))
    }
  })

  // what_bug_this_catches: filtering protected files after hashing leaks their contents to readers.
  it('never hashes synthetic protected names or project descendants', async () => {
    const fs = new MemoryFs('rv-protection')
    const protectedPaths = ['README-private.txt', 'LICENSE.txt', '.env', 'credentials.json', 'project/package.json', 'project/source.txt']
    for (const path of [...protectedPaths, 'ordinary.txt']) fs.writeFile(path, new Uint8Array([1, 2, 3]))
    const hashed: string[] = []
    const hash = fs.sha256.bind(fs)
    fs.sha256 = async (path) => { hashed.push(path); return hash(path) }
    const result = await scanRoot(fs, { scanId: 'rv-protection-scan' })
    expect(result.status).toBe('complete')
    expect(hashed).toEqual(['ordinary.txt'])
    expect(result.files.map((file) => file.relPath)).toEqual(['ordinary.txt'])
    expect(result.projectRoots).toEqual(['project'])
  })

  // what_bug_this_catches: counting UTF-16 characters permits a response exceeding its byte budget.
  it('rejects valid multibyte JSON over the 64 KiB response byte bound', () => {
    const proposals = Array.from({ length: 150 }, (_, i) => ({
      fileId: `rv-${i}`, categoryId: 'documents', basename: `note-${i}`, confidence: 0.9, reason: '界'.repeat(150),
    }))
    const text = JSON.stringify({ proposals })
    expect(text.length).toBeLessThan(PROPOSAL_LIMITS.maxResponseBytes)
    expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(PROPOSAL_LIMITS.maxResponseBytes)
    const result = parseProposalText(text, new Set(proposals.map((p) => p.fileId)))
    expect(result.fatal).not.toBeNull()
    expect(result.accepted).toEqual([])
  })
})
