// End-to-end check of a SQLite connection on a disposable database file
// built from e2e/fixture-sqlite.sql:
//   pnpm exec electron-vite build && node e2e/sqlite.mjs
import { basename, dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { answerMessages, checkImportFile, checkSafeUpdates, chooseFromContextMenu, connectWithoutPassword, launch, menu, outputMessages, runSql, shot, sqliteFixture, suggestions, uiText } from './lib.mjs'

const { userData, file, server } = await sqliteFixture()
// a view saved with mixed line ends, as a Windows client may leave it
{
  const db = new DatabaseSync(file)
  db.exec('CREATE VIEW v_crlf AS\r\nSELECT 1\nUNION ALL SELECT 2')
  db.close()
}
/** Reads the database file directly, as a separate client. */
const cli = (sql) => {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return db.prepare(sql).get()
  } finally {
    db.close()
  }
}
/** All the rows of a query on the file, joined by \n, their columns by |. */
const query = (sql) => {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return db.prepare(sql).all().map((r) => Object.values(r).join('|')).join('\n')
  } finally {
    db.close()
  }
}

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` — ${detail}`}`)
}

const { app, page, errors } = await launch(userData)
try {
  await connectWithoutPassword(page, server)
  const ws = page.locator('.workspace:visible')

  // multi statement script, auto LIMIT, error stops the script
  await runSql(page, 'SELECT * FROM customer;\nSELECT nope FROM customer;\nSELECT 1;')
  let out = await outputMessages(page)
  check('auto LIMIT appended', out.some((l) => l.startsWith(`SELECT * FROM customer LIMIT 1000 | ${uiText('output.rowsReturned', { count: 3 })}`)), out.join('\n'))
  check('error reported with code', out.some((l) => l.includes(uiText('output.errorCode', { code: 1, message: 'no such column: nope' }))), out.join('\n'))

  // grid editing: change Bob's name, review dialog, apply
  await runSql(page, 'SELECT * FROM customer ORDER BY id')
  await page.waitForFunction(() => document.querySelector('.workspace .status')?.textContent === '')
  const cell = ws.locator('.grid .row').nth(1).locator('.cell').nth(1)
  await cell.dblclick()
  await page.keyboard.press('Meta+A')
  await page.keyboard.insertText('Bobby')
  await page.keyboard.press('Enter')
  // a restart asks once about the changes not applied (2f383eb: the unsaved-work question, not a list
  // of its own first); Cancel (response 1) keeps the app and the change
  await app.evaluate(({ dialog }) => {
    globalThis.originalShowMessageBox = dialog.showMessageBox
    globalThis.restartBoxes = []
    dialog.showMessageBox = async (_win, o) => {
      globalThis.restartBoxes.push(o.message)
      return { response: 1, checkboxChecked: false }
    }
  })
  await menu(app, 'app.restart')
  await page.waitForTimeout(500)
  const boxes = await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = globalThis.originalShowMessageBox
    return globalThis.restartBoxes
  })
  check('restart asks once about unapplied result changes', boxes.length === 1 && boxes[0] === uiText('workspace.pendingOnClose', { name: server.name }), boxes.join('\n'))
  check('cancelled restart keeps the change', (await ws.locator('.cell.modified').count()) === 1)
  await ws.getByRole('button', { name: 'Apply', exact: true }).click()
  const review = page.locator('[role=dialog]')
  await review.waitFor()
  await page.waitForTimeout(300)
  const script = await review.locator('.view-lines').innerText()
  check(
    'review shows UPDATE by primary key',
    /UPDATE "customer" SET "name" = 'Bobby' WHERE \("id" = 2\)/.test(script.replace(/\s+/g, ' ')),
    script
  )
  await review.getByRole('button', { name: 'Apply' }).click()
  await review.waitFor({ state: 'detached' })
  await page.waitForTimeout(300)
  check('edit applied to the file', cli('SELECT name FROM customer WHERE id = 2').name === 'Bobby')

  // add a row through the grid
  await ws.getByTitle('Add new row').click()
  await page.keyboard.press('Tab')
  await page.keyboard.type('Dora')
  await page.keyboard.press('Enter')
  await ws.getByRole('button', { name: 'Apply', exact: true }).click()
  await page.locator('[role=dialog]').getByRole('button', { name: 'Apply' }).click()
  await page.locator('[role=dialog]').waitFor({ state: 'detached' })
  await page.waitForTimeout(300)
  check('row inserted through the grid', cli("SELECT COUNT(*) AS n FROM customer WHERE name = 'Dora'").n === 1)

  await checkSafeUpdates(page, check, 'orders', () => cli("SELECT group_concat(status, ',') AS s FROM (SELECT status FROM orders ORDER BY id)").s)

  // a table without primary key is read only
  await runSql(page, 'SELECT * FROM log_nopk')
  await page.waitForTimeout(300)
  const readOnly = await ws.locator('.status').innerText()
  check('table without PK is read only', readOnly === uiText('results.readOnly.noPrimaryKey'), readOnly)

  // navigator: schema, tables, columns, view, trigger
  await ws.locator('.node', { hasText: basename(file) }).locator('.twisty').dispatchEvent('mousedown')
  await ws.locator('.node', { hasText: 'Tables' }).locator('.twisty').dispatchEvent('mousedown')
  await ws.locator('.node', { hasText: /^customer$/ }).first().waitFor()
  const tables = await ws.locator('.node').allInnerTexts()
  check('navigator lists the tables, no internal ones', ['orders', 'log_nopk'].every((t) => tables.some((l) => l.trim() === t)) && !tables.some((l) => l.includes('sqlite_')), tables.join(','))
  await ws.locator('.node').filter({ hasText: 'customer' }).first().locator('.twisty').dispatchEvent('mousedown')
  await ws.locator('.node', { hasText: 'Columns' }).first().locator('.twisty').dispatchEvent('mousedown')
  await ws.locator('.node', { hasText: 'balance' }).waitFor()
  check('navigator shows columns with types', /DECIMAL\(10,2\)/.test(await ws.locator('.node', { hasText: 'balance' }).innerText()))
  await ws.locator('.node', { hasText: 'Triggers' }).first().locator('.twisty').dispatchEvent('mousedown')
  await ws.locator('.node', { hasText: 'customer_bi' }).waitFor()
  check('navigator shows the trigger with timing', /AFTER INSERT/.test(await ws.locator('.node', { hasText: 'customer_bi' }).innerText()))
  await ws.locator('.node', { hasText: 'Indexes' }).first().locator('.twisty').dispatchEvent('mousedown')
  await ws.locator('.node', { hasText: 'idx_name' }).waitFor()
  const indexes = await ws.locator('.node').allInnerTexts()
  check('navigator shows the rowid primary key and the indexes', indexes.some((l) => /^PRIMARY\s+id$/.test(l.trim())) && indexes.some((l) => /sqlite_autoindex_customer_\d+\s+email/.test(l)), indexes.join(','))
  await ws.locator('.node', { hasText: /^orders$/ }).locator('.twisty').dispatchEvent('mousedown')
  await ws.locator('.node', { hasText: 'Foreign Keys' }).nth(1).locator('.twisty').dispatchEvent('mousedown')
  /** The node appears within a few seconds; a missing one fails its check instead of stopping the script. */
  const shown = (locator) => locator.waitFor({ timeout: 5000 }).then(() => true, () => false)
  check('navigator shows the foreign key', await shown(ws.locator('.node', { hasText: '→ customer' })))
  await ws.locator('.node', { hasText: 'Views' }).locator('.twisty').dispatchEvent('mousedown')
  check('navigator shows the view', await shown(ws.locator('.node', { hasText: 'v_customer_orders' })))
  await shot(page, 'sqlite-tree')

  // a view with mixed CRLF/LF line ends opens in the routine editor without changes
  await chooseFromContextMenu(app, 'alter-routine')
  await ws.locator('.node', { hasText: 'v_crlf' }).dispatchEvent('contextmenu')
  await ws.locator('.page-header', { hasText: 'v_crlf' }).waitFor()
  await ws.locator('.editor-page:visible .view-lines', { hasText: 'UNION ALL' }).waitFor()
  await page.waitForTimeout(300)
  const crlfTab = ws.locator('.editors > .tabbar .tab', { hasText: 'v_crlf' })
  const crlfDirty = (await crlfTab.locator('.dirty').count()) > 0
  check('view with mixed line ends opens unmodified', !crlfDirty)
  // a modified tab would ask before closing: Discard
  if (crlfDirty) await answerMessages(app)
  await crlfTab.locator('button.close').click()
  await crlfTab.waitFor({ state: 'detached' })

  // Import Data from File… of the navigator, into the fixture's tables
  await checkImportFile(app, page, check, {
    dir: dirname(file),
    customerNode: ws.locator('.node', { hasText: /^customer$/ }).first(),
    ordersNode: ws.locator('.node', { hasText: /^orders$/ }).first(),
    query
  })

  // CREATE TRIGGER with a BEGIN ... END body runs as one statement
  await runSql(
    page,
    "CREATE TABLE audit (msg TEXT);\nCREATE TRIGGER orders_ai AFTER INSERT ON orders\nBEGIN\n  INSERT INTO audit VALUES ('order ' || NEW.id);\n  INSERT INTO audit VALUES ('second');\nEND;\nINSERT INTO orders (customer_id, total) VALUES (1, 3);"
  )
  out = await outputMessages(page)
  // the count of the previous DML must not leak into the CREATE TRIGGER line (sqlite3_changes)
  check('trigger body runs as one statement and DDL reports no affected rows', out.some((l) => /^CREATE TRIGGER orders_ai .* END \| /.test(l) && l.includes(`| ${uiText('output.rowsAffected', { count: 0 })}`)), out.slice(-3).join('\n'))
  check('insert reports one affected row', out.at(-1)?.startsWith(`INSERT INTO orders (customer_id, total) VALUES (1, 3) | ${uiText('output.rowsAffected', { count: 1 })}`), out.at(-1))
  check('trigger fired in the file', cli('SELECT COUNT(*) AS n FROM audit').n === 2)

  // explain
  await runSql(page, 'SELECT * FROM customer c JOIN orders o ON o.customer_id = c.id', 'Meta+Alt+X')
  await page.waitForTimeout(400)
  check('full scan and key lookup highlighted', (await ws.locator('.plan .plan-node.bad').count()) >= 1 && (await ws.locator('.plan .plan-node.good').count()) >= 1, await ws.locator('.plan').innerText())
  await shot(page, 'sqlite-explain')

  // Stop a long running statement; the main process stays responsive meanwhile
  const ed = ws.locator('.editor-page:visible .monaco-editor').first()
  await ed.click()
  await page.keyboard.press('Meta+A')
  await page.keyboard.press('Backspace')
  await page.keyboard.insertText('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c')
  const t0 = Date.now()
  await page.keyboard.press('Meta+Shift+Enter')
  await page.waitForTimeout(800)
  const tMain = Date.now()
  await app.evaluate(() => 1)
  check('main process responsive while a statement runs', Date.now() - tMain < 500, `${Date.now() - tMain} ms`)
  await ws.getByTitle('Stop the query being executed').click()
  await page.waitForFunction(() => !document.querySelector('.workspace .running'), null, { timeout: 15000 })
  check('stop interrupts a running query quickly', Date.now() - t0 < 6000, `${Date.now() - t0} ms`)
  out = await outputMessages(page)
  check('interruption reported', (out.at(-1) ?? '').includes(uiText('output.errorCode', { code: 9, message: uiText('main.sqlite.interrupted') })), out.at(-1))
  await runSql(page, 'SELECT COUNT(*) FROM customer')
  out = await outputMessages(page)
  check('session usable after stop', (out.at(-1) ?? '').includes(`| ${uiText('output.rowsReturned', { count: 1 })}`), out.at(-1))
  // with Stop on Error off, Stop still skips the statements after the interrupted one
  const stopOnErrorTitle = 'Toggle whether execution of SQL script should continue after failed statements'
  await ws.getByTitle(stopOnErrorTitle).click()
  await ws.locator(`button.active[title="${stopOnErrorTitle}"]`).waitFor({ state: 'hidden' })
  await ed.click()
  await page.keyboard.press('Meta+A')
  await page.keyboard.press('Backspace')
  await page.keyboard.insertText('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c;\nCREATE TABLE stop_marker (x);')
  await page.keyboard.press('Meta+Shift+Enter')
  await page.waitForTimeout(800)
  await ws.getByTitle('Stop the query being executed').click()
  await page.waitForFunction(() => !document.querySelector('.workspace .running'), null, { timeout: 15000 })
  check('stop skips the next statement with stop on error off', cli("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name = 'stop_marker'").n === 0)
  await ws.getByTitle(stopOnErrorTitle).click()
  await ws.locator(`button.active[title="${stopOnErrorTitle}"]`).waitFor()
  // completion offers SQLite's functions, not MySQL's
  const ye = await suggestions(page, 'SELECT * FROM customer WHERE ye')
  const strf = await suggestions(page, 'SELECT strf')
  check("completion uses SQLite's dictionary, not MySQL's", strf.some((l) => /^strftime$/i.test(l)) && !ye.some((l) => /^YEAR/i.test(l)), `${strf.join(',')} / ${ye.join(',')}`)

  await shot(page, 'sqlite-final')
  check('no renderer errors', errors.length === 0, errors.join('\n'))
} catch (e) {
  failures++
  console.log('FAIL exception', e.message)
  await shot(page, 'sqlite-exception')
} finally {
  await app.close()
}
console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed')
process.exit(failures ? 1 : 0)
