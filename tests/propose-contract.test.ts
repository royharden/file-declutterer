import { describe, expect, it } from 'vitest'
import { extensionOf as appExtension, isProtectedRelPath as appProtected, isUnderReserved as appReserved, normalizeRelative as appNormalize } from '../src/engine/paths'
import { extensionOf as edgeExtension, isProtectedRelPath as edgeProtected, isUnderReserved as edgeReserved, normalizeRelative as edgeNormalize, selectablePaths } from '../supabase/functions/propose-plan/pathSafety'
import { assertWorkspaceOnlyBody } from '../supabase/functions/propose-plan/proposalGuard'
import { acceptProposals, extractJsonObject } from '../supabase/functions/propose-plan/proposals'
import { pathFixtures } from './pathFixtures'

describe('edge and app path rules', () => {
  it('agrees on the shared fixture table', () => {
    for (const fixture of pathFixtures) {
      expect(edgeNormalize(fixture.input)).toEqual(appNormalize(fixture.input))
    }
  })

  it('agrees on protection, reservation, and extensions', () => {
    const samples = ['README.md', '.git/HEAD', '.env.local', 'package.json', 'Photos/a.JPG', '.quarantine/a.txt', '.declutter-tmp/j/1/a.txt', 'notes.txt']
    for (const sample of samples) {
      expect(edgeProtected(sample)).toBe(appProtected(sample))
      expect(edgeReserved(sample)).toBe(appReserved(sample))
      expect(edgeExtension(sample)).toBe(appExtension(sample))
    }
  })

  it('sends only ordinary file paths', () => {
    expect(
      selectablePaths([
        { rel_path: 'README.md', kind: 'file' },
        { rel_path: '.git/HEAD', kind: 'file' },
        { rel_path: 'Downloads', kind: 'dir' },
        { rel_path: 'song.mp3', kind: 'file' },
        { rel_path: '.quarantine/x.txt', kind: 'file' },
      ]),
    ).toEqual(['song.mp3'])
  })
})

describe('proposal contract', () => {
  it('rejects any body other than workspace_id', () => {
    const extra = assertWorkspaceOnlyBody({ workspace_id: '11111111-1111-1111-1111-111111111111', files: [] })
    expect(extra.ok).toBe(false)
    const content = assertWorkspaceOnlyBody({ content: 'secret' })
    expect(content.ok).toBe(false)
    const ok = assertWorkspaceOnlyBody({ workspace_id: '11111111-1111-1111-1111-111111111111' })
    expect(ok).toEqual({ ok: true, workspaceId: '11111111-1111-1111-1111-111111111111' })
  })

  it('drops model output that changes an extension or adds a field', () => {
    const fenced = extractJsonObject('```json\n{"proposals":[{"from":"a.txt","to":"Documents/a.txt"}]}\n```')
    const accepted = acceptProposals(['a.txt', 'b.txt'], fenced)
    expect(accepted.proposals).toEqual([{ from: 'a.txt', to: 'Documents/a.txt' }])

    const dirty = acceptProposals(['a.txt'], { proposals: [{ from: 'a.txt', to: 'Documents/a.pdf', excerpt: 'page' }], content: 'full text' })
    expect(dirty.contractError).toContain('other than proposals')

    const extension = acceptProposals(['a.txt'], { proposals: [{ from: 'a.txt', to: 'Documents/a.pdf' }] })
    expect(extension.proposals).toEqual([])
    expect(extension.rejected[0]?.reason).toContain('extension')
  })
})
