import { chromium } from 'playwright'
const browser = await chromium.launch({ channel:'msedge', headless:true, timeout:120000 })
const page = await browser.newPage()
const errors=[]; const external=[]
page.on('pageerror',e=>errors.push(e.message))
await page.route('**/*', async route => {
 const url=new URL(route.request().url())
 if(url.origin==='http://127.0.0.1:22901') await route.continue()
 else {external.push(url.origin); await route.abort()}
})
try {
 await page.goto('http://127.0.0.1:22901/',{timeout:120000})
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
} finally {await browser.close()}
