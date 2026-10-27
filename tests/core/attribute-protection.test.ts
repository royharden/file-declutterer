import { expect, it } from 'vitest'
import { MemoryFs } from '../../src/adapters/memory-fs'
import { scanRoot } from '../../src/core/scan'
it('protects platform attribute files and entire directories before reading their bytes', async () => {
  // what_bug_this_catches: native attributes were absent from scan entries, exposing non-dot hidden/system data.
  const fs = new MemoryFs('attribute-contract')
  fs.writeFile('ordinary.pdf',new Uint8Array([1]))
  fs.writeFile('secret.pdf',new Uint8Array([2]))
  fs.writeFile('system-folder/nested.pdf',new Uint8Array([3]))
  const list=fs.list.bind(fs);const entered:string[]=[];const hashed:string[]=[]
  fs.list=async dir=>{entered.push(dir);return (await list(dir)).map(e=>({...e,hidden:e.name==='secret.pdf',system:e.name==='system-folder'}))}
  const hash=fs.sha256.bind(fs);fs.sha256=async rel=>{hashed.push(rel);return hash(rel)}
  const scan=await scanRoot(fs,{scanId:'attributes'})
  expect(scan.status).toBe('complete')
  expect(hashed).toEqual(['ordinary.pdf'])
  expect(entered).not.toContain('system-folder')
  expect(scan.files.map(f=>f.relPath)).toEqual(['ordinary.pdf'])
  expect(scan.skipped.filter(s=>s.reason==='hidden').map(s=>s.relPath).sort()).toEqual(['secret.pdf','system-folder'])
})
