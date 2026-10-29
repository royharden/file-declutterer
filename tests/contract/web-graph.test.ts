import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// T31 (browser half): the web import graph must not reach Node/platform APIs, the CLI or the
// inactive legacy sources. Static source scan; the built-bundle check is pending.

const WEB_ROOTS = ['src/core', 'src/adapters', 'src/ui', 'src/main.tsx']
const FORBIDDEN = [/from\s+['"]node:/, /from\s+['"](fs|path|os|crypto|child_process)['"]/, /from\s+['"][./]*\/?cli\//, /from\s+['"].*\/engine\//, /from\s+['"].*supabase/, /\bprocess\./, /\bDeno\./]

function files(path: string): string[] {
  const st = statSync(path)
  if (st.isFile()) return [path]
  return readdirSync(path).flatMap((name) => files(join(path, name)))
}

describe('web import graph', () => {
  it('core, adapters and UI import no Node, CLI or legacy modules', () => {
    const offenders: string[] = []
    for (const file of WEB_ROOTS.flatMap(files).filter((f) => /\.(ts|tsx)$/.test(f))) {
      const text = readFileSync(file, 'utf8')
      for (const pattern of FORBIDDEN) if (pattern.test(text)) offenders.push(`${file}: ${pattern}`)
    }
    expect(offenders).toEqual([])
  })

  it('UI never renders HTML from strings', () => {
    const ui = files('src/ui').map((f) => readFileSync(f, 'utf8')).join('\n')
    expect(ui).not.toMatch(/dangerouslySetInnerHTML|innerHTML\s*=/)
  })
})
