import { mkdir, readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
const browser = await chromium.launch({ executablePath: process.env.DECLUTTER_TEST_BROWSER, headless:true, timeout:120000 })
const page = await browser.newPage()
page.setDefaultTimeout(90000)
const errors=[]; const external=[]
page.on('pageerror',e=>errors.push(e.message))
await page.route('**/*', async route => {
 const url=new URL(route.request().url())
 if(url.origin===new URL(process.env.DECLUTTER_TEST_URL ?? 'http://127.0.0.1:22901/').origin) {
  if(process.env.DECLUTTER_TEST_STATIC==='1') {
   const asset=url.pathname==='/'?'index.html':/^\/assets\/[A-Za-z0-9_.-]+$/.test(url.pathname)?url.pathname.slice(1):null
   if(!asset) {await route.abort();return}
   await route.fulfill({body:await readFile(`dist/${asset}`),contentType:asset.endsWith('.js')?'text/javascript':asset.endsWith('.css')?'text/css':'text/html'})
  } else await route.continue()
 }
 else {external.push(url.origin); await route.abort()}
})
try {
 await page.goto(process.env.DECLUTTER_TEST_URL ?? 'http://127.0.0.1:22901/',{timeout:120000})
 await page.getByText('Sandbox — simulated file operations; no disk changes',{exact:true}).waitFor()
 await page.getByRole('button',{name:'Scan sandbox',exact:true}).click()
 await page.getByText('Scan complete.',{exact:true}).waitFor()
 await page.getByRole('tab',{name:'Propose',exact:true}).click()
 await page.getByRole('button',{name:'Heuristic (extension rules)',exact:true}).click()
 await page.getByRole('heading',{name:'Approve',exact:true}).waitFor()
 if(await page.locator('input[type=checkbox]:checked').count() !== 0) throw new Error('Proposals preselected')
 await page.getByRole('button',{name:'Select rows without issues',exact:true}).click()
 await page.getByRole('button',{name:'Approve this exact plan',exact:true}).click()
 await page.getByRole('button',{name:'Go to Apply',exact:true}).click()
 await page.getByRole('button',{name:'Apply approved plan',exact:true}).click()
 await page.getByText('committed',{exact:true}).waitFor({timeout:120000})
 await page.getByRole('tab',{name:'Traps',exact:true}).click()
 await page.getByRole('button',{name:'Run sandbox traps',exact:true}).click()
 await page.getByRole('status').filter({hasText:'Profile:'}).waitFor({timeout:120000})
 console.log('TRAPS',await page.getByRole('status').innerText())
 console.log('RESULT',JSON.stringify({errors,external}))
 if(errors.length||external.length) process.exitCode=1
} catch(error) {
 console.error('PAGE_ERRORS',JSON.stringify(errors))
 console.error('PAGE_BODY',(await page.locator('body').innerText()).slice(0,8000))
 await mkdir('.agent-work/browser',{recursive:true})
 await page.screenshot({path:'.agent-work/browser/failure.png',fullPage:true}).catch(()=>{})
 throw error
} finally {await browser.close()}
