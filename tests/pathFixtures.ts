export interface PathFixture {
  input: string
  ok: boolean
  reason?: string
  path?: string
}

/** Shared by the frontend path tests and the edge-function contract test. */
export const pathFixtures: PathFixture[] = [
  { input: 'Photos/cat.jpg', ok: true, path: 'Photos/cat.jpg' },
  { input: 'report final.pdf', ok: true, path: 'report final.pdf' },
  { input: '../outside.txt', ok: false, reason: 'empty, dot, or parent segment' },
  { input: '/etc/passwd', ok: false, reason: 'absolute path' },
  { input: 'C:/Windows/a.txt', ok: false, reason: 'absolute path' },
  { input: '', ok: false, reason: 'empty path' },
  { input: 'Documents/CON.txt', ok: false, reason: 'reserved Windows name' },
  { input: 'COM1.txt', ok: false, reason: 'reserved Windows name' },
  { input: 'notes.', ok: false, reason: 'trailing dot' },
  { input: ' notes.txt', ok: false, reason: 'leading or trailing space' },
  { input: 'a\\b.txt', ok: false, reason: 'backslash is not allowed' },
  { input: 'a//b.txt', ok: false, reason: 'empty, dot, or parent segment' },
  { input: 'a/./b.txt', ok: false, reason: 'empty, dot, or parent segment' },
  { input: 'file:name.txt', ok: false, reason: 'illegal character' },
]
