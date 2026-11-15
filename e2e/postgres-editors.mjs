// Table editor, inspector, Search Table Data, table maintenance and autocommit
// off on PostgreSQL, against the dbm-test-postgres container:
//   pnpm exec electron-vite build && node e2e/postgres-editors.mjs
// The script reloads e2e/fixture-postgres.sql (schema "shop") on every run.
import {
  answerMessages,
  checker,
  chooseFromContextMenu,
  launch,
  loadPostgresFixture,
  menu,
  outputEntries,
  outputMessages,
  pgServer,
  profileWith,
  psql,
  recordedMessages,
  runSql,
  shot
} from './lib.mjs'

loadPostgresFixture()
const result = checker()
const { check } = result

const { app, page, errors } = await launch(profileWith([pgServer]))
const ws = page.locator('.workspace:visible')
const editor = () => ws.locator('.editor-page:visible')
const node = (label) => ws.locator('.node', { has: page.locator('.label', { hasText: new RegExp(`^${label}$`) }) }).first()
const expand = (label) => node(label).locator('.twisty').dispatchEvent('mousedown')
const subTab = (label) => editor().locator('.tabbar .tab', { hasText: label }).dispatchEvent('mousedown')
const review = page.locator('[role=dialog]')
/** Types into a cell input of the editor, committed as on leaving the field. */
const type = async (input, text) => {
  await input.fill(text)
  await input.press('Tab')
}

async function applyReview() {
  await review.waitFor()
  await page.waitForTimeout(300)
  const text = (await review.locator('.view-lines').innerText()).replace(/ /g, ' ').replace(/\s+/g, ' ')
  await review.getByRole('button', { name: 'Apply' }).click()
  await review.waitFor({ state: 'detached', timeout: 10000 })
  await page.waitForTimeout(300)
  return text
}

try {
  await answerMessages(app)
  await page.locator('.tile.folder', { hasText: 'Test' }).click()
  await page.locator('.tile', { hasText: 'PostgreSQL 17' }).dblclick()
  await page.locator('input[type=password]').fill('test')
  await page.keyboard.press('Enter')
  await page.locator('.workspace:visible .editor-page:visible .monaco-editor').first().waitFor()
  await expand('shop')
  await expand('Tables')
  await node('customer').waitFor()

  // --- table editor: rename a column, add one, change a type, drop an index ---------------
  await chooseFromContextMenu(app, 'alter-table')
  await node('customer').dispatchEvent('contextmenu')
  await editor().locator('.columns-tab').waitFor()
  await page.waitForTimeout(300)
  const rows = editor().locator('.columns-tab tbody tr')
  const notes = rows.filter({ has: page.locator('input[value="notes"]') })
  await type(notes.locator('input[type=text]').first(), 'remark')
  await rows.last().dispatchEvent('mousedown')
  await editor().locator('button[title="Add a column after the selected one"]').click()
  const added = rows.last()
  await type(added.locator('input[type=text]').first(), 'score')
  await type(added.locator('input[type=text]').nth(1), 'smallint')
  await shot(page, 'pg-editors-01-columns')
  await subTab('Indexes')
  await page.waitForTimeout(200)
  const indexRows = editor().locator('.indexes-tab .side tbody tr')
  const idx = await indexRows.evaluateAll((trs) => trs.findIndex((tr) => tr.querySelector('input')?.value === 'idx_name'))
  await indexRows.nth(idx).dispatchEvent('mousedown')
  await editor().locator('.indexes-tab button[title="Remove the selected index"]').click()
  await shot(page, 'pg-editors-02-indexes')
  await editor().locator('.actions button.primary').click()
  await applyReview()
  const columns = psql("SELECT string_agg(column_name || ':' || data_type, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'shop' AND table_name = 'customer'")
  check('columns changed in the database', columns.includes('remark:text') && columns.endsWith('score:smallint') && !columns.includes('notes'), columns)
  check('index dropped in the database', psql("SELECT count(*) FROM pg_indexes WHERE schemaname = 'shop' AND indexname = 'idx_name'") === '0')

  // a failing script is rolled back as a whole
  await chooseFromContextMenu(app, 'alter-table')
  await node('orders').dispatchEvent('contextmenu')
  await editor().locator('.columns-tab').waitFor()
  await page.waitForTimeout(300)
  const status = rows.filter({ has: page.locator('input[value="status"]') })
  await type(status.locator('input[type=text]').first(), 'state')
  const total = rows.filter({ has: page.locator('input[value="total"]') })
  await type(total.locator('input[type=text]').nth(1), 'integer[]')
  await editor().locator('.actions button.primary').click()
  await review.waitFor()
  await page.waitForTimeout(300)
  await review.getByRole('button', { name: 'Apply' }).click()
  await review.locator('.error').waitFor({ timeout: 10000 })
  await page.waitForTimeout(500)
  await shot(page, 'pg-editors-03-failed')
  check('failed alter rolled back (rename undone)', psql("SELECT count(*) FROM information_schema.columns WHERE table_schema = 'shop' AND table_name = 'orders' AND column_name = 'status'") === '1')
  check('error shown in the review dialog', /integer\[\]|cannot|cast/i.test(await review.locator('.error').innerText()), await review.locator('.error').innerText())
  await review.getByRole('button', { name: 'Cancel' }).click()
  await review.waitFor({ state: 'detached' })

  // create a table with a foreign key
  await chooseFromContextMenu(app, 'create-table')
  await node('customer').dispatchEvent('contextmenu')
  await editor().locator('.columns-tab').waitFor()
  await type(editor().locator('.header input[type=text]').first(), 'note')
  await rows.last().dispatchEvent('mousedown')
  await editor().locator('button[title="Add a column after the selected one"]').click()
  await type(rows.last().locator('input[type=text]').first(), 'customer_id')
  await type(rows.last().locator('input[type=text]').nth(1), 'integer')
  await editor().locator('.actions button.primary').click()
  await applyReview()
  check('table created in the database', psql("SELECT count(*) FROM pg_tables WHERE schemaname = 'shop' AND tablename = 'note'") === '1')

  // --- inspector ------------------------------------------------------------------------------
  await chooseFromContextMenu(app, 'inspect')
  await node('customer').dispatchEvent('contextmenu')
  await page.waitForTimeout(800)
  // the page header names the table anyway: the values must come from the Info query
  const info = await editor().locator('.info table.kv td').allInnerTexts()
  check('inspector info', (await editor().locator('p.error').count()) === 0 && info.includes('customer'), info.join(' | ') || (await editor().innerText()))
  await subTab('Columns')
  await page.waitForTimeout(500)
  check('inspector columns', /balance/.test(await editor().innerText()))
  await subTab('Constraints')
  await page.waitForTimeout(500)
  check('inspector constraints', /customer_pkey/.test(await editor().innerText()), await editor().innerText())
  await subTab('DDL')
  await page.waitForTimeout(500)
  check('inspector DDL', /CREATE TABLE/.test((await editor().innerText()).replace(/\u00a0/g, ' ')))
  await shot(page, 'pg-editors-04-inspector')

  // --- maintenance: VACUUM (VERBOSE) in a query tab, its notices in the output -------------------
  await chooseFromContextMenu(app, 'm:0')
  await node('customer').dispatchEvent('contextmenu')
  await page.waitForFunction(() => !document.querySelector('.workspace:not([style*="display: none"]) .running'))
  await page.waitForTimeout(800)
  // VACUUM fails inside a transaction block; its VERBOSE notices make the line a warning, not an error
  const vacuum = (await outputEntries(page)).filter((e) => /^VACUUM \(VERBOSE\) "shop"\."customer"/.test(e.text)).at(-1)
  check('vacuum ran outside a transaction', vacuum?.status === 'ok' || vacuum?.status === 'warn', JSON.stringify(vacuum))

  // --- Search Table Data --------------------------------------------------------------------
  await menu(app, 'db.searchData')
  await editor().locator('#sd-text').waitFor()
  await editor().locator('#sd-text').fill('VIP')
  await editor().getByRole('button', { name: 'Start Search' }).click()
  await page.waitForTimeout(1500)
  let grid = await editor().locator('.results').innerText()
  check('search is case insensitive (ILIKE)', /customer/.test(grid) && /remark/.test(grid), grid)
  await editor().locator('#sd-mode').selectOption('regexp')
  await editor().locator('#sd-text').fill('^b.b')
  await editor().getByRole('button', { name: 'Start Search' }).click()
  await page.waitForTimeout(1500)
  grid = await editor().locator('.results').innerText()
  check('regexp search', /Bob/.test(grid), grid)
  await shot(page, 'pg-editors-05-search')

  // --- autocommit off: changes wait for COMMIT / ROLLBACK -------------------------------------
  await ws.locator('.tab', { has: page.locator('.label', { hasText: /^Query 1$/ }) }).dispatchEvent('mousedown')
  await menu(app, 'query.toggleAutocommit')
  await page.waitForTimeout(300)
  await runSql(page, "INSERT INTO log_nopk VALUES ('pending')")
  check('autocommit off: insert not visible to other sessions', psql("SELECT count(*) FROM shop.log_nopk WHERE msg = 'pending'") === '0')
  await menu(app, 'query.rollback')
  await page.waitForTimeout(500)
  await runSql(page, "INSERT INTO log_nopk VALUES ('kept')")
  await menu(app, 'query.commit')
  await page.waitForTimeout(500)
  const kept = psql("SELECT string_agg(msg, ',') FROM shop.log_nopk WHERE msg IN ('pending', 'kept')")
  check('rollback discards, commit keeps', kept === 'kept', `${kept}\n${(await outputMessages(page)).filter((l) => !l.startsWith(' | INFO')).slice(-8).join('\n')}`)
  await runSql(page, "INSERT INTO log_nopk VALUES ('on')")
  await menu(app, 'query.toggleAutocommit')
  await page.waitForTimeout(500)
  check('autocommit on commits the open transaction', psql("SELECT count(*) FROM shop.log_nopk WHERE msg = 'on'") === '1')

  await shot(page, 'pg-editors-final')
  const messages = await recordedMessages(app)
  check('no message boxes', messages.length === 0, messages.join('\n'))
  check('no renderer errors', errors.length === 0, errors.join('\n'))
} catch (e) {
  result.failures++
  console.log('FAIL exception', e.message)
  await shot(page, 'pg-editors-exception')
} finally {
  await app.close()
}
const failures = result.failures
console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed')
process.exit(failures ? 1 : 0)
