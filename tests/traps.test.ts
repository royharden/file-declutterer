import { describe, expect, it } from 'vitest'
import { runTraps, scoreTraps } from '../src/engine/traps'

describe('published traps', () => {
  it('scores every fixture as a pass', () => {
    const results = runTraps()
    const score = scoreTraps(results)
    const failed = results.filter((result) => !result.passed).map((result) => `${result.id}: ${result.detail}`)
    expect(failed).toEqual([])
    expect(score.passed).toBe(score.total)
    expect(score.total).toBe(21)
  })
})
