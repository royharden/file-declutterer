// Construction-only helper parent-loss test. Owns and terminates only its child parent process.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const worker=fileURLToPath(new URL('../cli/platform/windows-worker.ps1',import.meta.url))
const identity='s13-lifecycle-probe-'+process.pid+'-'+Date.now()
const ownerCode=`const {spawn}=require('node:child_process');const {createInterface}=require('node:readline');const c=spawn('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',${JSON.stringify(worker)},'-ParentPid',String(process.pid)],{windowsHide:true,stdio:['pipe','pipe','pipe'],shell:false});c.stderr.on('data',b=>process.stderr.write(b));createInterface({input:c.stdout}).on('line',s=>{const r=JSON.parse(s);if(r.ok){console.log(JSON.stringify({ready:true,workerPid:c.pid,name:r.value}));}else{console.error(r.error);process.exit(2)}});c.stdin.write(JSON.stringify({id:1,op:'acquire',arg:${JSON.stringify(identity)}})+String.fromCharCode(10));setInterval(()=>{},1000);`
const owner=spawn(process.execPath,['-e',ownerCode],{windowsHide:true,stdio:['ignore','pipe','pipe'],shell:false})
let detail=''; owner.stderr.on('data',b=>{detail+=b.toString()})
let ready
try {
  ready=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Owner worker did not become ready: '+detail)),60000)
    createInterface({input:owner.stdout}).on('line',s=>{try{const r=JSON.parse(s);if(r.ready){clearTimeout(timer);resolve(r)}}catch{}})
    owner.on('exit',code=>{clearTimeout(timer);reject(new Error('Owner exited '+code+': '+detail))})
  })
  const ended=new Promise(resolve=>owner.once('exit',resolve)); owner.kill(); await ended
  const child=spawn('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',worker,'-ParentPid',String(process.pid)],{windowsHide:true,stdio:['pipe','pipe','pipe'],shell:false})
  try {
    let id=0;const pending=new Map()
    createInterface({input:child.stdout}).on('line',s=>{const r=JSON.parse(s);const p=pending.get(r.id);if(p){clearTimeout(p.timer);pending.delete(r.id);r.ok?p.resolve(r.value):p.reject(new Error(r.error))}})
    child.stderr.on('data',b=>{detail+=b.toString()})
    function call(op,arg){return new Promise((resolve,reject)=>{const seq=++id;const timer=setTimeout(()=>reject(new Error('Successor timeout: '+detail)),60000);pending.set(seq,{resolve,reject,timer});child.stdin.write(JSON.stringify({id:seq,op,arg})+'\n')})}
    const name=await call('acquire',identity)
    assert.equal(name,ready.name)
    await call('release',name)
    console.log(JSON.stringify({parentLoss:'owned parent killed; successor acquired same OS mutex',ownerPid:owner.pid,workerPid:ready.workerPid,identity},null,2))
  } finally {child.stdin.end()}
} finally {if(owner.exitCode===null&&!owner.killed)owner.kill()}
