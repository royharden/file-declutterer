import { expect, it } from 'vitest'
import { parseProposalText } from '../../src/core/proposal-schema'

it('rejects UTF-8 overflow before parsing multibyte response data', () => {
  // what_bug_this_catches: UTF-16 length admitted responses above the 64 KiB byte cap.
  const text = JSON.stringify({ proposals: Array.from({length: 150}, (_, i) => ({
    fileId: String(i), categoryId: 'documents', basename: 'report', confidence: 1, reason: String.fromCharCode(30028).repeat(150),
  })) })
  expect(text.length).toBeLessThan(65536)
  expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(65536)
  expect(parseProposalText(text, new Set(Array.from({length: 150}, (_, i) => String(i)))).fatal).toMatch(/bytes/)
})
