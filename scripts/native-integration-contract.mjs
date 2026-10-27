// Construction contract probe only: fake helper facts are NOT native qualification.
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { NodeFs } from '../dist-cli/cli/node-fs.js'
import { qualifyRoot, qualifiedRootId } from '../dist-cli/cli/qualify.js'
import { acquireRootLock } from '../dist-cli/cli/lock.js'
import { FileJournalStore, registerRoot, rootStateDir } from '../dist-cli/cli/state.js'

const sandbox = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 's13-native-integration-')))
const root = path.join(sandbox,'inbox')
await fs.mkdir(root)
let cloud = false
let foreignVolume = false
let mutexHeld = true
const flushed = []
const helper = {
  available:true, version:'injected-contract-fake', unavailableReason:null,
  async volume() { return {fileSystem:'NTFS',serial:'00000001',remote:false,removable:false} },
  async fileId(file) { const st=await fs.lstat(file,{bigint:true}); return st.dev.toString(16).padStart(16,'0')+':'+st.ino.toString(16).padStart(32,'0') },
  async components(file) { return [{path:file,fileId:foreignVolume?'ffffffffffffffff:'+ '0'.repeat(32):await this.fileId(file),reparse:false,cloudPlaceholder:cloud}] },
  async processStart() { return 'test-process-epoch' },
  async flushDirectory(dir) { flushed.push(dir) },
  async acquireRootMutex() { return {name:'fake-root-mutex',held:()=>mutexHeld,assertHeld:async()=>{if(!mutexHeld) throw new Error('helper communication lost')},release:async()=>{mutexHeld=false}} },
}
try {
  await fs.writeFile(path.join(root,'report.pdf'),'synthetic report bytes')
  const q=await qualifyRoot(root,helper,{unmanaged:true,env:{}})
  assert.equal(q.readOk,true)
  assert.equal(q.rootId,qualifiedRootId(await helper.fileId(root)))
  const adapter=new NodeFs({root,rootId:q.rootId,writesEnabled:true,identityQualified:true,helper})
  assert.equal((await adapter.stat('report.pdf')).identity,await helper.fileId(path.join(root,'report.pdf')))
  assert.equal(await adapter.sha256('report.pdf'),createHash('sha256').update('synthetic report bytes').digest('hex'))
  cloud=true
  await assert.rejects(adapter.sha256('report.pdf'),/reparse\/cloud/)
  await assert.rejects(adapter.link('report.pdf','copy.pdf'),/reparse\/cloud/)
  await assert.rejects(fs.access(path.join(root,'copy.pdf')))
  cloud=false; foreignVolume=true
  await assert.rejects(adapter.mkdir('newdir'),/volume/)
  foreignVolume=false
  await adapter.mkdir('newdir')
  await adapter.link('report.pdf','newdir/copy.pdf')
  assert.equal((await adapter.stat('report.pdf')).identity,(await adapter.stat('newdir/copy.pdf')).identity)
  await adapter.unlink('newdir/copy.pdf')
  await adapter.rmdir('newdir')
  assert.equal(flushed.length,4)
  const state=path.join(sandbox,'probe-state')
  await fs.mkdir(state)
  const lock=await acquireRootLock(state,q.rootId,helper)
  await lock.assert()
  mutexHeld=false
  await assert.rejects(lock.assert(),/mutex lost/)
  mutexHeld=true
  await lock.release()
  // Corrupt path-bearing token must not escape through retired-marker naming.
  await fs.writeFile(path.join(state,'LOCK'),JSON.stringify({token:'../../escape',rootId:q.rootId,host:os.hostname(),pid:999999,processStart:'old',acquiredAt:new Date().toISOString()}))
  mutexHeld=true
  await assert.rejects(acquireRootLock(state,q.rootId,helper),/cannot be read/)
  assert.equal(await fs.readFile(path.join(root,'report.pdf'),'utf8'),'synthetic report bytes')
  const env={LOCALAPPDATA:path.join(sandbox,'synthetic-profile')}
  await registerRoot('test-root',root,new Date().toISOString(),env)
  const recordFile=path.join(rootStateDir('test-root',env),'root.json')
  await fs.writeFile(recordFile,'{broken registration')
  await assert.rejects(registerRoot('test-root',root,new Date().toISOString(),env))
  assert.equal(await fs.readFile(recordFile,'utf8'),'{broken registration')
  const runDir=path.join(state,'runs','linked-plan')
  await fs.mkdir(runDir,{recursive:true})
  await fs.link(path.join(root,'report.pdf'),path.join(runDir,'plan.json'))
  assert.equal(await new FileJournalStore(state).readPlan('linked-plan'),null)

  console.log('PASS: injected helper identity, cloud and volume refusal, link IDs, four metadata flushes, fresh guard loss, corrupt LOCK refusal, corrupt root preservation, linked plan refusal')
} finally {
  // Only this probe-created tree is eligible for removal.
  const temp=await fs.realpath(os.tmpdir())
  if(path.dirname(sandbox)!==temp || !path.basename(sandbox).startsWith('s13-native-integration-')) throw new Error('Unsafe probe cleanup target')
  await fs.rm(sandbox,{recursive:true,force:true})
}
