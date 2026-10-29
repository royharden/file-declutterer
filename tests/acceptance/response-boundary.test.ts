import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { utf8Encode } from '../../src/core/fingerprint'
import { parseProposalText, PROPOSAL_LIMITS } from '../../src/core/proposal-schema'

describe('RV V0 response-byte boundaries', () => {
  // what_bug_this_catches: replacing a platform encoder with a core encoder changes Unicode counting.
  it.each(['plain ASCII', '界', '😀', '\ud800', '\udc00', 'a\ud800b', 'é\u0301😀界'])('agrees with Node UTF-8 for %j', (text) => {
    expect(Array.from(utf8Encode(text))).toEqual(Array.from(Buffer.from(text, 'utf8')))
  })

  // what_bug_this_catches: off-by-one rejection or a limit enforced only after JSON parsing.
  it('accepts exactly the byte cap and rejects one extra byte', () => {
    const body = JSON.stringify({ proposals: [] })
    const atLimit = body.padEnd(PROPOSAL_LIMITS.maxResponseBytes, ' ')
    expect(parseProposalText(atLimit, new Set())).toEqual({ accepted: [], rejected: [], fatal: null })
    expect(parseProposalText(atLimit + ' ', new Set()).fatal).toMatch(/bytes/)
  })
})
