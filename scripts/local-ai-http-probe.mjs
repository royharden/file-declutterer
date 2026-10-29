// Real loopback HTTP protocol tests with a synthetic server; never a model/provider call.
import assert from 'node:assert/strict'
import http from 'node:http'
import { readLocalAiConfig, runLocalAi } from '../dist-cli/cli/local-ai.js'
const port=Number(process.argv[2]);assert.ok(Number.isInteger(port)&&port>=22900&&port<23000,'claimed S13 port required')
let mode='valid',calls=0
const observations=[]
const server=http.createServer(async(req,res)=>{
 calls++;let text='';for await(const chunk of req) text+=chunk
 assert.ok(Buffer.byteLength(text)<=32768)
 const request=JSON.parse(text)
 const items=JSON.parse(request.messages[1].content).items
 assert.equal(req.url,'/v1/chat/completions');assert.equal(req.headers.authorization,undefined)
 assert.deepEqual(Object.keys(items[0]).sort(),['basename','extension','fileId','folder'])
 if(mode==='timeout') return
 if(mode==='redirect'){res.writeHead(302,{location:'http://s13.invalid/never-follow'});res.end();return}
 if(mode==='oversize'){res.end('x'.repeat(70*1024));return}
 if(mode==='malformed'){res.end('not JSON');return}
 res.setHeader('content-type','application/json')
 res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({proposals:items.map(item=>({fileId:item.fileId,categoryId:'other',basename:item.basename,confidence:0.7,reason:'Synthetic fixture only'}))})}}]}))
})
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)})
try {
 const cfg=readLocalAiConfig({DECLUTTER_MODEL_URL:`http://127.0.0.1:${port}`,DECLUTTER_MODEL_NAME:'synthetic-no-model'})
 assert.equal(cfg.ok,true);const items=[{fileId:'synthetic-1',basename:'sample',extension:'.xyz',folder:'synthetic'}]
 for(const selected of ['valid','malformed','oversize','redirect']) {
  mode=selected;calls=0
  const result=await runLocalAi(cfg.config,items)
  assert.equal(calls,1,'no retries')
  assert.equal(result.partial,selected!=='valid')
  assert.equal(result.parsed.accepted.length,selected==='valid'?1:0)
  observations.push({name:selected,result:'pass',calls})
 }
 mode='valid';calls=0
 const many=Array.from({length:640},(_,i)=>({...items[0],fileId:`synthetic-${i}`}))
 const bounded=await runLocalAi(cfg.config,many)
 assert.equal(calls,7);assert.equal(bounded.parsed.accepted.length,560);assert.equal(bounded.partial,true)
 assert.equal(bounded.batches.filter(b=>b.status==='unattempted').length,1)
 observations.push({name:'80-row batches and seven-attempt ceiling',result:'pass',calls})
 mode='timeout';calls=0;const started=Date.now()
 const timed=await runLocalAi(cfg.config,items)
 const elapsedMs=Date.now()-started
 assert.equal(calls,1);assert.equal(timed.partial,true);assert.equal(timed.parsed.accepted.length,0)
 assert.ok(elapsedMs>=29000&&elapsedMs<45000,`actual timeout ${elapsedMs}`)
 observations.push({name:'actual fetch timeout without fabricated proposals',result:'pass',calls,elapsedMs})
 console.log(JSON.stringify({profile:'CLI / Node global fetch / own loopback synthetic HTTP server',port,observations}))
} finally {
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve))
}
