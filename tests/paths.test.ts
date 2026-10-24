import { describe, expect, it } from 'vitest'
import { extensionOf, isProtectedRelPath, normalizeRelative } from '../src/engine/paths'
import { pathFixtures } from './pathFixtures'

describe('normalizeRelative', () => {
  it.each(pathFixtures)('$input', (fixture) => {
    const result = normalizeRelative(fixture.input)
    expect(result.ok).toBe(fixture.ok)
    if (result.ok) expect(result.path).toBe(fixture.path)
    if (!result.ok) expect(result.reason).toBe(fixture.reason)
  })
})

describe('protection and extensions', () => {
  it('locks project markers and secret env files', () => {
    expect(isProtectedRelPath('README.md')).toBe(true)
    expect(isProtectedRelPath('docs/LICENSE')).toBe(true)
    expect(isProtectedRelPath('.git/HEAD')).toBe(true)
    expect(isProtectedRelPath('app/node_modules/left-pad/index.js')).toBe(true)
    expect(isProtectedRelPath('package.json')).toBe(true)
    expect(isProtectedRelPath('.env')).toBe(true)
    expect(isProtectedRelPath('.env.local')).toBe(true)
    expect(isProtectedRelPath('src/notes.txt')).toBe(false)
  })

  it('keeps the last extension and ignores dotfiles', () => {
    expect(extensionOf('Photos/Cat.JPG')).toBe('.jpg')
    expect(extensionOf('.env')).toBe('')
    expect(extensionOf('download')).toBe('')
    expect(extensionOf('archive.tar.gz')).toBe('.gz')
  })
})
