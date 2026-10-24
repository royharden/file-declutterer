import { describe, expect, it } from 'vitest'
import { runSandboxTraps, sandboxCheckIds } from '../../src/adapters/trap-runner'
import { REQUIRED_TRAP_IDS, TRAPS } from '../../src/core/traps'

// Registry contract: required IDs are present without freezing an exact total, so new
// cases can be added. Every S/B case has a sandbox check; N cases never pass in the sandbox.

const REQUIRED = Array.from({ length: 39 }, (_, i) => `T${String(i + 1).padStart(2, '0')}`)

describe('trap registry', () => {
  it('registers every required trap id once with a what_bug_this_catches', () => {
    for (const id of REQUIRED) expect(REQUIRED_TRAP_IDS).toContain(id)
    expect(new Set(REQUIRED_TRAP_IDS).size).toBe(REQUIRED_TRAP_IDS.length)
    expect(TRAPS.every((t) => t.whatBugThisCatches.length > 10)).toBe(true)
  })

  it('has a sandbox check for every S and B case and none for N cases', () => {
    const checks = new Set(sandboxCheckIds())
    for (const trap of TRAPS) {
      if (trap.profile === 'N') expect(checks.has(trap.id)).toBe(false)
      else if (!['T31'].includes(trap.id)) expect(checks.has(trap.id), trap.id).toBe(true)
    }
  })

  it('passes every executed sandbox case and reports native as not run', async () => {
    const results = await runSandboxTraps()
    const failed = results.filter((r) => r.sandbox === 'fail' || r.sandbox === 'error')
    expect(failed.map((r) => `${r.trap.id}: ${r.observation}`)).toEqual([])
    expect(results.every((r) => r.native === 'not-run')).toBe(true)
    expect(results.filter((r) => r.trap.profile === 'N').every((r) => r.sandbox === 'not-run')).toBe(true)
  }, 120_000)
})
