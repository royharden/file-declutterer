// Disposable construction probe, not independent acceptance or a native safety score.
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, realpath, link, readFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const root=await realpath(await mkdtemp(path.join(tmpdir(),'s13-helper-probe-')))
await writeFile(path.join(root,'long-file-name.txt'),'synthetic helper probe')
await link(path.join(root,'long-file-name.txt'),path.join(root,'second.txt'))
const worker=fileURLToPath(new URL('../cli/platform/windows-worker.ps1',import.meta.url))
function launch() {
  const child=spawn('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',worker,'-ParentPid',String(process.pid)],{windowsHide:true,stdio:['pipe','pipe','pipe'],shell:false})
  const pending=new Map(); let seq=0; let err=''
  child.stderr.on('data',b=>{err+=b.toString()})
  createInterface({input:child.stdout}).on('line',line=>{
    try { const r=JSON.parse(line); const p=pending.get(r.id); if(p){clearTimeout(p.timer);pending.delete(r.id);r.ok?p.resolve(r.value):p.reject(new Error(r.error))} }
    catch(e){console.error('Unexpected worker output',line)}
  })
  child.on('exit',(code)=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error(`helper exit ${code}: ${err}`))}pending.clear()})
  return {child,async call(op,arg=''){return new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>{pending.delete(id);reject(new Error('helper probe timeout: '+err));child.stdin.end()},60000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({id,op,arg})+'\n')})},close(){child.stdin.end()}}
}
const a=launch();let b
const evidence={root,results:{}}
try {
  evidence.results.version=await a.call('ping')
  evidence.results.volume=await a.call('volume',root)
  evidence.results.components=await a.call('components',root)
  const id=await a.call('fileId',path.join(root,'long-file-name.txt'))
  assert.equal(id,await a.call('fileId',path.join(root,'second.txt')))
  evidence.results.hardLinkIdentity=id
  const alias=await a.call('shortPath',root)
  if(alias.toLowerCase()!==root.toLowerCase()) {
    await assert.rejects(a.call('components',alias),/alias refused/)
    evidence.results.shortAlias='existing 8.3 ancestry alias refused'
  } else evidence.results.shortAlias='no alternate short spelling on disposable root'
  await mkdir(path.join(root,'target'))
  await symlink(path.join(root,'target'),path.join(root,'junction'),'junction')
  const junction=await a.call('components',path.join(root,'junction'))
  assert.equal(junction.at(-1).reparse,true)
  evidence.results.junction='real disposable junction reports reparse=true'
  assert.match(await a.call('processStart',String(process.pid)),/^\d+$/)
  assert.equal(await a.call('processStart','2147483647'),null)
  evidence.results.processIdentity='existing epoch and absent PID distinguishable'
  const name=await a.call('acquire','s13-disposable-'+path.basename(root))
  b=launch()
  await assert.rejects(b.call('acquire','s13-disposable-'+path.basename(root)),/held by another/)
  assert.equal(await a.call('held',name),true)
  await a.call('release',name)
  const second=await b.call('acquire','s13-disposable-'+path.basename(root))
  await b.call('release',second)
  evidence.results.mutex='second worker refused; admitted after release'
  try {await a.call('flushDirectory',root);evidence.results.directoryFlush='succeeded'}
  catch(error){evidence.results.directoryFlush='REFUSED: '+error.message}
  assert.equal(await readFile(path.join(root,'second.txt'),'utf8'),'synthetic helper probe')
  console.log(JSON.stringify(evidence,null,2))
} finally {a.close();b?.close()}
