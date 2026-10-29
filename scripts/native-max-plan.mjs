// Construction-only real Win32 roundtrip, never independent release acceptance.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { WindowsPlatformHelper } from '../dist-cli/cli/platform/windows-native.js'
import { qualifyRoot } from '../dist-cli/cli/qualify.js'
import { NodeFs } from '../dist-cli/cli/node-fs.js'
import { acquireRootLock } from '../dist-cli/cli/lock.js'
import { FileJournalStore, registerRoot, rootStateDir } from '../dist-cli/cli/state.js'
import { scanRoot } from '../dist-cli/src/core/scan.js'
import { heuristicProposals } from '../dist-cli/src/core/heuristic.js'
import { approve, buildPlan } from '../dist-cli/src/core/plan.js'
import { applyPlan, reverseRun } from '../dist-cli/src/core/runs.js'
import { DEFAULT_ROOT_CONFIG } from '../dist-cli/src/core/scan-policy.js'
import { buildOrganizeRows, defaultSelection, observeDestinations, validateRows } from '../dist-cli/src/core/validate.js'

const count=500
const sandbox=await realpath(await mkdtemp(path.join(tmpdir(),'s13-win32-roundtrip-')))
const root=path.join(sandbox,'inbox'); await mkdir(root)
for(let i=0;i<count;i++) await writeFile(path.join(root,`report-${i}.pdf`),`synthetic byte-bearing report ${i}`)
async function manifest() {
 const values=[]
 async function walk(dir,rel='') {for(const e of await readdir(dir,{withFileTypes:true})) {
  const name=rel?`${rel}/${e.name}`:e.name
  if(e.isDirectory()) await walk(path.join(dir,e.name),name)
  else values.push([name,createHash('sha256').update(await readFile(path.join(dir,e.name))).digest('hex')])
 }}
 await walk(root);return JSON.stringify(values.sort())
}
const original=await manifest()
const helper=new WindowsPlatformHelper(); let lock
try {
 const q=await qualifyRoot(root,helper,{unmanaged:true})
 assert.equal(q.writeOk,true,JSON.stringify(q))
 const env={LOCALAPPDATA:path.join(sandbox,'state')}
 await registerRoot(q.rootId,root,new Date().toISOString(),env,helper)
 const state=rootStateDir(q.rootId,env)
 lock=await acquireRootLock(state,q.rootId,helper)
 const fs=new NodeFs({root,rootId:q.rootId,writesEnabled:true,identityQualified:true,helper})
 const store=new FileJournalStore(state,helper)
 const ctx={fs,store,assertOwnership:()=>lock.assert()}
 const scan=await scanRoot(fs,{scanId:'win32-scan'})
 const validate=async rows=>validateRows(rows,{kind:'organize',config:DEFAULT_ROOT_CONFIG,existing:await observeDestinations(fs,rows),extOf:id=>scan.files.find(f=>f.id===id)?.ext??''})
 const rows=await validate(defaultSelection(await validate(buildOrganizeRows(scan,{accepted:heuristicProposals(scan),rejected:[],fatal:null},'heuristic','construction',DEFAULT_ROOT_CONFIG))))
 const plan=buildPlan({planId:'win32-max-plan',kind:'organize',scan,config:DEFAULT_ROOT_CONFIG,rows})
 const applied=await applyPlan(ctx,plan,approve(plan,'explicit-synthetic-test'))
 assert.equal(applied.status,'committed',JSON.stringify(applied))
 assert.equal(applied.counts.applied,count)
 for(let i=0;i<count;i++) assert.equal(await readFile(path.join(root,`_Organized/Documents/report-${i}.pdf`),'utf8'),`synthetic byte-bearing report ${i}`)
 const reversed=await reverseRun(ctx,plan.planId,'undo')
 assert.equal(reversed.status,'undone',JSON.stringify(reversed))
 assert.equal(await manifest(),original)
 console.log(JSON.stringify({result:'PASS',scope:'500-file real Win32 maximum-plan apply/undo with mkdir counted beyond 500 operations',rootId:q.rootId,sandbox,applied:applied.counts,reversed:reversed.counts}))
} finally {if(lock) await lock.release();await helper.close()}
