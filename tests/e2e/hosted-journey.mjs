// RV-owned browser acceptance. Synthetic in-page operations only; static loopback assets only.
import assert from 'node:assert/strict'
import { writeFile, mkdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright'

const origin = process.env.S13_RV_TEST_URL ?? 'http://127.0.0.1:22921'
const selected = new URL(origin)
assert.equal(selected.hostname, '127.0.0.1')
assert.ok(Number(selected.port) >= 22900 && Number(selected.port) <= 22999)
assert.equal(selected.username + selected.password, '')
const observations = []
const errors = []
const external = []
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage()
page.setDefaultTimeout(15000)
page.on('pageerror', error => errors.push(error.message))
await page.route('**/*', async route => {
  if (new URL(route.request().url()).origin === origin) await route.continue()
  else { external.push(route.request().url()); await route.abort() }
})
const tab = name => page.getByRole('tab', { name, exact: true }).click()
const button = name => page.getByRole('button', { name, exact: true })
const waitText = text => page.getByText(text, { exact: true }).first().waitFor()
const check = (name, detail) => observations.push({ name, result: 'pass', detail })
async function reset() {
  await tab('Home / Scan')
  await button('Reset sandbox').click()
}
async function propose() {
  await button('Scan sandbox').click()
  await waitText('Scan complete.')
  await tab('Propose')
  await button('Heuristic (extension rules)').click()
  await page.getByRole('heading', { name: 'Approve', exact: true }).waitFor()
  assert.equal(await page.locator('input[type=checkbox]:checked').count(), 0)
}
async function selectApproveApply() {
  await button('Select rows without issues').click()
  await button('Approve this exact plan').click()
  await button('Go to Apply').click()
  await button('Apply approved plan').click()
  await waitText('committed')
}

try {
  await page.goto(origin)
  await waitText('Sandbox — simulated file operations; no disk changes')
  await page.getByRole('tab', { name: 'Home / Scan', exact: true }).focus()
  await page.keyboard.press('ArrowRight')
  assert.equal(await page.locator(':focus').innerText(), 'Propose')
  await tab('Home / Scan')
  check('zero-config banner and keyboard tab navigation')
  await propose()
  assert.equal(await button('Approve this exact plan').isDisabled(), true)
  assert.equal(await page.getByRole('checkbox', { name: 'Include Downloads/old/report final.pdf', exact: true }).isDisabled(), true)
  await button('Select rows without issues').click()
  assert.equal(await page.getByRole('checkbox', { name: 'Include mystery.xyz', exact: true }).isChecked(), false)
  await button('Approve this exact plan').click()
  await button('Clear selection').click()
  assert.equal(await button('Approve this exact plan').isDisabled(), true)
  check('explicit inclusion, blocked collision, warnings unselected and approval revoked')
  await selectApproveApply()
  await button('Runs and undo').click()
  await button('Show journal').click()
  await waitText('intent')
  await waitText('outcome')
  check('apply commits and journal displays intent/outcome')

  await page.getByRole('combobox', { name: 'Sandbox path', exact: true }).selectOption('_Organized/Documents/Q3 report.pdf')
  await button('Edit bytes').click()
  await button('Preview undo').click()
  await waitText('refuse')
  await button('Confirm undo').click()
  await waitText('needs_attention')
  check('changed destination is refused during undo; unresolved run retained')

  await reset()
  await propose()
  await button('Select rows without issues').click()
  await button('Approve this exact plan').click()
  await button('Go to Apply').click()
  await page.getByLabel('Interrupt at boundary', { exact: true }).fill('12')
  await button('Arm').click()
  await button('Apply approved plan').click()
  await page.getByRole('heading', { name: 'Recovery required', exact: true }).waitFor()
  await button('Recover (roll back)').click()
  await waitText('rolled_back')
  check('interruption 12 and explicit recovery finish rolled_back')

  await reset()
  await propose()
  await selectApproveApply()
  await tab('Duplicates / Restore')
  await button('Find duplicates').click()
  await page.getByText(' (suggested keeper)', { exact: true }).first().waitFor()
  assert.equal(await page.locator('input[type=checkbox]:checked').count(), 0)
  // Choose the non-keeper member of the first displayed verified group.
  const group = page.locator('fieldset').first()
  const extras = group.locator('div').filter({ hasNot: page.locator('strong') })
  await extras.first().getByRole('checkbox').check()
  await page.getByRole('button', { name: /^Review quarantine plan \(/ }).click()
  await button('Approve this exact plan').click()
  await button('Apply quarantine').click()
  await page.getByRole('combobox', { name: 'Quarantine run', exact: true }).waitFor()
  await tab('Runs / Undo')
  assert.match(await page.getByRole('row').filter({ hasText: 'organize' }).first().innerText(), /newer/i)
  check('duplicates unselected, separate quarantine, newer-run undo dependency')
  await tab('Duplicates / Restore')
  const select = page.getByRole('combobox', { name: 'Quarantine run', exact: true })
  const runId = await select.locator('option').nth(1).getAttribute('value')
  await select.selectOption(runId)
  const restore = page.getByRole('region', { name: 'Restore from quarantine', exact: true })
  await restore.getByRole('checkbox').first().check()
  await button('Review restore plan').click()
  await button('Approve this exact plan').click()
  await button('Apply restore').click()
  await tab('Runs / Undo')
  await page.getByRole('row').filter({ hasText: 'restore of' }).first().waitFor()
  check('named quarantine entry restored through reviewed pipeline')

  await tab('Traps')
  await button('Run sandbox traps').click()
  await page.getByRole('status').filter({ hasText: 'Profile:' }).waitFor()
  const score = await page.getByRole('status').filter({ hasText: 'Profile:' }).innerText()
  assert.match(score, /failed\s*0|0\s*failed/i)
  assert.match(await page.locator('main').innerText(), /Not run/)
  check('trap scorecard reports actual sandbox result and native Not run', score)
  await page.reload()
  await tab('Runs / Undo')
  await waitText('No runs yet.')
  check('reload discards in-memory state')
  assert.deepEqual(errors, [])
  assert.deepEqual(external, [])
  check('no page errors or external asset/API requests')
} catch (error) {
  observations.push({ name: 'journey failure', result: 'fail', detail: String(error) })
  await page.screenshot({ path: 'evals/hosted-failure.png', fullPage: true }).catch(() => {})
  process.exitCode = 1
} finally {
  await mkdir('evals', { recursive: true })
  const report = { candidate: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), origin, browser: browser.version(), observations, errors, external }
  await writeFile(`evals/hosted-journey-result-${Date.now()}.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  await browser.close()
}
