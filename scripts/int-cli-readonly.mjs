import { mkdtemp, mkdir, writeFile, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
const sandbox = await realpath(await mkdtemp(join(tmpdir(),'s13-cli-readonly-')))
const root=join(sandbox,'inbox'); await mkdir(root)
await writeFile(join(root,'report.pdf'),'synthetic PDF bytes')
await writeFile(join(root,'photo.jpg'),'synthetic JPEG bytes')
const env={...process.env,LOCALAPPDATA:join(sandbox,'state')}
const execute=(args,expected=0)=>{
 const result=spawnSync(process.execPath,['dist-cli/main.js',...args],{env,encoding:'utf8',timeout:120000,windowsHide:true})
 if(result.error) throw result.error
 console.log('COMMAND',args[0],'EXIT',result.status)
 if(result.status!==expected) throw new Error(result.stderr)
 return result.stdout
}
const qualification = execute(['qualify',root,'--unmanaged'])
if(!qualification.includes('read-only: yes; native writes: no')) throw new Error('Expected readable root with native writes disabled')
execute(['scan',root,'--unmanaged','--json',join(sandbox,'scan.json')])
execute(['propose',root,'--unmanaged','--mode','heuristic','--out',join(sandbox,'plan.json')])
const validation=execute(['validate',root,'--unmanaged','--plan',join(sandbox,'plan.json')])
if(!validation.includes('digest')) throw new Error('Missing validation digest')
if(await readFile(join(root,'report.pdf'),'utf8')!=='synthetic PDF bytes') throw new Error('Unexpected root change')
console.log('PASS read-only CLI qualify/scan/propose/validate; sandbox preserved:',sandbox)
