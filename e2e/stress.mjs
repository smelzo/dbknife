// Stop a running query, large result sets, dark theme: node e2e/stress.mjs
import { connect, lastOutputOk, launch, outputMessages, runSql, servers, shot, uiText } from './lib.mjs'

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` — ${detail}`}`)
}
const { app, page, errors } = await launch()
try {
  await connect(page, servers.mysql)
  const ws = page.locator('.workspace:visible')

  // Stop: KILL QUERY on a SLEEP
  const ed = ws.locator('.editor-page:visible .monaco-editor').first()
  await ed.click()
  await page.keyboard.insertText('SELECT SLEEP(20)')
  const t0 = Date.now()
  await page.keyboard.press('Meta+Shift+Enter')
  await page.waitForTimeout(800)
  await ws.getByTitle('Stop the query being executed').click()
  await page.waitForFunction(() => !document.querySelector('.workspace .running'), null, { timeout: 15000 })
  const out = await outputMessages(page)
  check('stop interrupts a running query quickly', Date.now() - t0 < 6000, `${Date.now() - t0} ms`)
  console.log('   ', out.at(-1))
  // the session keeps working after the kill
  await runSql(page, 'SELECT 1')
  check('session usable after stop', await lastOutputOk(page), (await outputMessages(page)).at(-1))

  // 200k rows with the limit disabled
  await page.locator('select[title="Set limit for executed queries"]').first().selectOption('0')
  const t1 = Date.now()
  await runSql(page, `SET SESSION cte_max_recursion_depth = 300000; WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 200000)
SELECT n, CONCAT('row ', n) AS label, n * 1.5 AS price, NOW() AS ts FROM seq`.replace(/\n/g, ' '))
  console.log(`    total ${Date.now() - t1} ms`)
  const grid = ws.locator('.grid .scroller').first()
  const t2 = Date.now()
  await grid.evaluate((el) => (el.scrollTop = el.scrollHeight))
  await page.waitForTimeout(100)
  const last = await ws.locator('.grid .row').last().locator('.gutter').innerText()
  check('virtual scroll reaches the last row', last === '200000', last)
  console.log(`    scroll ${Date.now() - t2} ms`)
  await ws.locator('input.filter').fill('row 19999')
  await page.waitForTimeout(500)
  check('filter rows', (await ws.locator('.results .footer span').first().innerText()) === uiText('results.footer.filtered', { shown: 11, count: 200000 }), await ws.locator('.results .footer').innerText())
  await page.locator('select[title="Set limit for executed queries"]').first().selectOption('1000')

  // dark theme
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'))
  await page.emulateMedia({ colorScheme: 'dark' })
  await runSql(page, 'SELECT * FROM customer')
  await shot(page, 'stress-dark')
  check('no renderer errors', errors.length === 0, errors.join('\n'))
} finally {
  await app.close()
}
process.exit(failures ? 1 : 0)
