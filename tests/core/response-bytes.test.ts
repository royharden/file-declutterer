import { parseMovePlan } from '../../src/core/plan'
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

it('enforces imported plan byte limit for multibyte input before schema parsing', () => {
  // what_bug_this_catches: plan import repeated the UTF-16 character-count byte-bound defect.
  const text = JSON.stringify({ padding: String.fromCharCode(30028).repeat(1500000) })
  expect(text.length).toBeLessThan(4 * 1024 * 1024)
  const result = parseMovePlan(text)
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error).toMatch(/4 MiB/)
})
