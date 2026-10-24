import { describe, expect, it } from 'vitest'
import { parseManifest } from '../src/engine/manifest'

function ids(): () => string {
  let n = 0
  return () => `m-${n++}`
}

describe('parseManifest', () => {
  it('accepts metadata and synthesizes missing parent folders', () => {
    const parsed = parseManifest(
      {
        files: [
          { relPath: 'Docs/a.txt', sizeBytes: 1, mtimeMs: 2, contentHash: 'h1' },
          { relPath: 'README.md', sizeBytes: 4, mtimeMs: 5, protected: false },
        ],
      },
      ids(),
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.nodes.some((node) => node.relPath === 'Docs' && node.kind === 'dir')).toBe(true)
    expect(parsed.nodes.some((node) => node.relPath === 'Docs/a.txt' && node.contentHash === 'h1')).toBe(true)
    expect(parsed.nodes.find((node) => node.relPath === 'README.md')?.protected).toBe(true)
  })

  it('rejects unexpected top-level fields and file text', () => {
    const extra = parseManifest({ files: [], note: 'hello' }, ids())
    expect(extra.ok).toBe(false)
    if (!extra.ok) expect(extra.issues[0]?.code).toBe('unexpected-field')

    const text = parseManifest(
      { files: [{ relPath: 'a.txt', sizeBytes: 1, mtimeMs: 1, excerpt: 'page one' }] },
      ids(),
    )
    expect(text.ok).toBe(false)
    if (!text.ok) expect(text.issues.some((item) => item.code === 'content-field')).toBe(true)
  })

  it('rejects a hash that looks like pasted text', () => {
    const parsed = parseManifest(
      { files: [{ relPath: 'a.txt', sizeBytes: 1, mtimeMs: 1, contentHash: 'this is a whole paragraph' }] },
      ids(),
    )
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.issues.some((item) => item.code === 'bad-hash')).toBe(true)
  })
})
