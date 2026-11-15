// Table editor, inspector, Search Table Data, table maintenance and autocommit
// off on SQLite, on a disposable database file built from e2e/fixture-sqlite.sql:
//   pnpm exec electron-vite build && node e2e/sqlite-editors.mjs
import { basename } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  answerMessages,
  checker,
  chooseFromContextMenu,
  connectWithoutPassword,
  launch,
  menu,
  outputEntries,
  outputMessages,
  recordedMessages,
  runSql,
  shot,
  sqliteFixture
} from './lib.mjs'

const { userData, file, server } = await sqliteFixture()
/** Reads the database file directly, as a separate client. */
const cli = (sql) => {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return db.prepare(sql).all()
  } finally {
    db.close()
  }
}
const result = checker()
const { check } = result

const { app, page, errors } = await launch(userData)
const ws = page.locator('.workspace:visible')
const editor = () => ws.locator('.editor-page:visible')
const node = (label) => ws.locator('.node', { has: page.locator('.label', { hasText: new RegExp(`^${label}$`) }) }).first()
const expand = (label) => node(label).locator('.twisty').dispatchEvent('mousedown')
const subTab = (label) => editor().locator('.tabbar .tab', { hasText: label }).dispatchEvent('mousedown')
const review = page.locator('[role=dialog]')
const text = async (locator) => (await locator.innerText()).replace(/ /g, ' ')
/** Types into a cell input of the editor, committed as on leaving the field. */
const type = async (input, value) => {
  await input.fill(value)
  await input.press('Tab')
}

async function applyReview() {
  await review.waitFor()
  await page.waitForTimeout(300)
  const script = (await text(review.locator('.view-lines'))).replace(/\s+/g, ' ')
  await review.getByRole('button', { name: 'Apply' }).click()
  await review.waitFor({ state: 'detached', timeout: 10000 })
  await page.waitForTimeout(300)
  return script
}

try {
  await answerMessages(app)
  await connectWithoutPassword(page, server)
  await expand(basename(file))
  await expand('Tables')
  await node('customer').waitFor()

  // --- table editor: a type change and a dropped column rebuild the table ---------------------
  await chooseFromContextMenu(app, 'alter-table')
  await node('customer').dispatchEvent('contextmenu')
  await editor().locator('.columns-tab').waitFor()
  await page.waitForTimeout(300)
  const rows = editor().locator('.columns-tab tbody tr')
  await type(rows.filter({ has: page.locator('input[value="name"]') }).locator('input[type=text]').nth(1), 'VARCHAR(200)')
  await rows.filter({ has: page.locator('input[value="avatar"]') }).dispatchEvent('mousedown')
  await editor().locator('button[title="Remove the selected column"]').click()
  await shot(page, 'sqlite-editors-01-columns')
  await editor().locator('.actions button.primary').click()
  await applyReview()
  const columns = cli("SELECT group_concat(name || ':' || type, ',') AS c FROM pragma_table_info('customer')")[0].c
  check('table rebuilt with the new type, without the column', columns.includes('name:VARCHAR(200)') && !columns.includes('avatar'), columns)
  check('rows kept, children kept', cli('SELECT count(*) AS n FROM customer')[0].n === 3 && cli('SELECT count(*) AS n FROM orders')[0].n === 3)
  check('index and trigger recreated', cli("SELECT count(*) AS n FROM sqlite_master WHERE name IN ('idx_name', 'customer_bi')")[0].n === 2)

  // renaming a column and adding one at the end is an ALTER TABLE
  await chooseFromContextMenu(app, 'alter-table')
  await node('orders').dispatchEvent('contextmenu')
  await editor().locator('.columns-tab').waitFor()
  await page.waitForTimeout(300)
  await type(rows.filter({ has: page.locator('input[value="status"]') }).locator('input[type=text]').first(), 'state')
  await rows.last().dispatchEvent('mousedown')
  await editor().locator('button[title="Add a column after the selected one"]').click()
  await type(rows.last().locator('input[type=text]').first(), 'note')
  await editor().locator('.actions button.primary').click()
  const ddl = await applyReview()
  check('rename and add without a rebuild', /RENAME COLUMN "status" TO "state"/.test(ddl) && /ADD COLUMN "note"/.test(ddl) && !/DROP TABLE/.test(ddl), ddl)
  check('orders changed in the file', cli("SELECT count(*) AS n FROM pragma_table_info('orders') WHERE name IN ('state', 'note')")[0].n === 2)

  // --- inspector ------------------------------------------------------------------------------
  await chooseFromContextMenu(app, 'inspect')
  await node('customer').dispatchEvent('contextmenu')
  await page.waitForTimeout(800)
  // the page header names the table anyway: the values must come from the Info query
  const info = await editor().locator('.info table.kv td').allInnerTexts()
  check('inspector info', (await editor().locator('p.error').count()) === 0 && info.includes('customer'), info.join(' | ') || (await text(editor())))
  await subTab('Indexes')
  await page.waitForTimeout(500)
  check('inspector indexes', /idx_name/.test(await text(editor())), await text(editor()))
  await subTab('DDL')
  await page.waitForTimeout(500)
  check('inspector DDL', /CREATE TABLE/.test(await text(editor())))
  await shot(page, 'sqlite-editors-02-inspector')

  // --- maintenance: integrity check in a query tab --------------------------------------------
  await chooseFromContextMenu(app, 'm:2')
  await node('customer').dispatchEvent('contextmenu')
  await page.waitForFunction(() => !document.querySelector('.workspace:not([style*="display: none"]) .running'))
  await page.waitForTimeout(500)
  const integrity = await outputMessages(page)
  const firstCell = (await text(editor().locator('.grid .row').first().locator('.cell').first()).catch(() => '')).trim()
  check('integrity check of the table returns ok', firstCell === 'ok', integrity.slice(-3).join('\n'))

  // --- Vacuum Database on the database file's node: run at once, no query tab -----------------
  const tabs = await ws.locator('.tabbar .tab:not(.add)').count()
  await chooseFromContextMenu(app, 'vacuum')
  await node(basename(file)).dispatchEvent('contextmenu')
  await page.waitForFunction(() => !document.querySelector('.workspace:not([style*="display: none"]) .running'))
  await page.waitForTimeout(500)
  const vacuum = (await outputEntries(page)).filter((e) => /^VACUUM\b/.test(e.text)).at(-1)
  check('Vacuum Database runs', vacuum?.status === 'ok', JSON.stringify(vacuum))
  check('Vacuum Database opens no query tab', (await ws.locator('.tabbar .tab:not(.add)').count()) === tabs)

  // --- Truncate Table: a DELETE without WHERE, exempt from Safe Updates (on by default) --------
  // answerMessages picks the first button of the confirmation, Review
  await chooseFromContextMenu(app, 'truncate')
  await node('log_nopk').dispatchEvent('contextmenu')
  const truncate = await applyReview()
  check('Truncate Table reviews a DELETE without WHERE', /^DELETE FROM "log_nopk";?$/.test(truncate.trim()), truncate)
  check('Truncate Table empties the table with Safe Updates on', cli('SELECT count(*) AS n FROM log_nopk')[0].n === 0, (await outputMessages(page)).slice(-2).join('\n'))
  const asked = await recordedMessages(app)
  check('Truncate Table asks for confirmation', asked.length === 1 && /log_nopk/.test(asked[0]), asked.join('\n'))
  // the final check counts the unexpected message boxes only
  await app.evaluate(() => (globalThis.dbmMessages = []))

  // --- Search Table Data --------------------------------------------------------------------
  await menu(app, 'db.searchData')
  await editor().locator('#sd-text').waitFor()
  await editor().locator('#sd-text').fill('VIP')
  await editor().getByRole('button', { name: 'Start Search' }).click()
  await page.waitForTimeout(1500)
  let grid = await text(editor().locator('.results'))
  check('search is case insensitive', /customer/.test(grid) && /notes/.test(grid), grid)
  await editor().locator('#sd-mode').selectOption('regexp')
  await editor().locator('#sd-text').fill('^b.b')
  await editor().getByRole('button', { name: 'Start Search' }).click()
  await page.waitForTimeout(1500)
  grid = await text(editor().locator('.results'))
  check('regexp search (case insensitive)', /Bob/.test(grid), grid)
  await shot(page, 'sqlite-editors-03-search')

  // --- autocommit off -------------------------------------------------------------------------
  await ws.locator('.tab', { has: page.locator('.label', { hasText: /^Query 1$/ }) }).dispatchEvent('mousedown')
  await menu(app, 'query.toggleAutocommit')
  await page.waitForTimeout(300)
  await runSql(page, "INSERT INTO log_nopk VALUES ('pending')")
  check('autocommit off: insert not visible to other clients', cli("SELECT count(*) AS n FROM log_nopk WHERE msg = 'pending'")[0].n === 0)
  await menu(app, 'query.rollback')
  await page.waitForTimeout(500)
  await runSql(page, "INSERT INTO log_nopk VALUES ('kept')")
  await menu(app, 'query.commit')
  await page.waitForTimeout(500)
  const kept = cli("SELECT group_concat(msg) AS m FROM log_nopk WHERE msg IN ('pending', 'kept')")[0].m
  check('rollback discards, commit keeps', kept === 'kept', `${kept}\n${(await outputMessages(page)).slice(-6).join('\n')}`)
  await runSql(page, "INSERT INTO log_nopk VALUES ('on')")
  await menu(app, 'query.toggleAutocommit')
  await page.waitForTimeout(500)
  check('autocommit on commits the open transaction', cli("SELECT count(*) AS n FROM log_nopk WHERE msg = 'on'")[0].n === 1)

  await shot(page, 'sqlite-editors-final')
  const messages = await recordedMessages(app)
  check('no message boxes', messages.length === 0, messages.join('\n'))
  check('no renderer errors', errors.length === 0, errors.join('\n'))
} catch (e) {
  result.failures++
  console.log('FAIL exception', e.message)
  await shot(page, 'sqlite-editors-exception')
} finally {
  await app.close()
}
console.log(result.failures ? `\n${result.failures} failure(s)` : '\nall checks passed')
process.exit(result.failures ? 1 : 0)
