import { expect, it } from 'vitest'
import { readLocalAiConfig, runLocalAi } from '../../cli/local-ai'
const config = { endpoint: new URL('http://127.0.0.1:22999/v1/chat/completions'), model: 'fake-no-model' }
const item = {fileId:'f1', basename:'report', extension:'.pdf', folder:'inbox'}
it('refuses unconfigured, remote and credential-bearing model URLs', () => {
 expect(readLocalAiConfig({} as NodeJS.ProcessEnv).ok).toBe(false)
 for(const url of ['https://example.com','http://user:pass@127.0.0.1']) {
  expect(readLocalAiConfig({DECLUTTER_MODEL_URL:url, DECLUTTER_MODEL_NAME:'fake'}).ok).toBe(false)
 }
})
it('uses a bounded explicit disclosure with no redirect following or retries', async () => {
 let calls=0
 const fake: typeof fetch = async (_, init) => {
  calls++
  expect(init?.redirect).toBe('manual')
  const body=JSON.parse(String(init?.body))
  expect(JSON.parse(body.messages[1].content)).toEqual({items:[item]})
  expect(body.stream).toBe(false)
  return new Response('',{status:302,headers:{location:'https://example.com'}})
 }
 const result=await runLocalAi(config,[item],fake)
 expect(calls).toBe(1); expect(result.partial).toBe(true); expect(result.parsed.accepted).toEqual([])
})
it('rejects oversized singleton disclosure before calling any transport', async () => {
 // what_bug_this_catches: planBatches emitted one oversize row which bypassed request byte cap.
 let calls=0
 const result=await runLocalAi(config,[{...item,basename:'x'.repeat(40000)}],async()=>{calls++; return new Response('{}')})
 expect(calls).toBe(0); expect(result.partial).toBe(true)
})
it('accepts schema-valid fake completion and preserves malformed failures as partial', async () => {
 const fake: typeof fetch = async () => new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({proposals:[{
  fileId:'f1',categoryId:'documents',basename:'report',confidence:0.8,reason:'Name only',
 }]})}}]}))
 const valid=await runLocalAi(config,[item],fake)
 expect(valid.parsed.accepted).toHaveLength(1); expect(valid.partial).toBe(false)
 const bad=await runLocalAi(config,[item],async()=>new Response('not JSON'))
 expect(bad.partial).toBe(true); expect(bad.parsed.accepted).toEqual([])
})
