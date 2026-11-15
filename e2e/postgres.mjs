// End-to-end check of PostgreSQL support against a disposable docker server:
//   docker run -d --name dbm-test-postgres -e POSTGRES_PASSWORD=test -p 127.0.0.1:33063:5432 postgres:17
//   pnpm exec electron-vite build && node e2e/postgres.mjs
// The script reloads e2e/fixture-postgres.sql (schema "shop" of the "postgres" database) on every run.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkImportFile, checkSafeUpdates, editorText, importFile, launch, outputMessages, pgServer, profileWith, runSql, shot, suggestions, uiText } from './lib.mjs'

const psql = (sql) =>
  execFileSync('docker', ['exec', '-i', 'dbm-test-postgres', 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qAt', '-c', sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()

execFileSync('docker', ['exec', '-i', 'dbm-test-postgres', 'psql', '-U', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1'], {
  input: readFileSync(new URL('./fixture-postgres.sql', import.meta.url)),
  stdio: ['pipe', 'ignore', 'ignore']
})
// a date column for the xlsx import (the fixture has none); gone with the schema when the fixture reloads
psql('CREATE TABLE shop.import_dates (id serial PRIMARY KEY, label text NOT NULL, due date)')

/** An xlsx file of one sheet holding `rows` from A1, written by d-spread-write; `dates` is a range given a date format. */
const xlsx = (rows, dates) => {
  const lines = [
    { protocol: 1, format: 'xlsx' },
    { sheet: { title: 'Data' } },
    ...rows.map((r, i) => [i + 1, r]),
    { style: dates, format: 'yyyy-mm-dd' }
  ].map((l) => JSON.stringify(l))
  lines.push(JSON.stringify({ end: true, lines: lines.length }))
  const tool = join(import.meta.dirname, '../bin', `${process.platform}-${process.arch}`, 'd-spread-write')
  return execFileSync(tool, [], { input: lines.join('\n') + '\n' })
}

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` — ${detail}`}`)
}

/** Makes the next navigator context menus answer `choice` instead of opening the native menu. */
const chooseFromContextMenu = (app, choice) =>
  app.evaluate(({ ipcMain }, c) => {
    ipcMain.removeHandler('ui:contextMenu')
    ipcMain.handle('ui:contextMenu', () => c)
  }, choice)

const { app, page, errors, userData } = await launch(profileWith([pgServer]))
try {
  // wrong password: the prompt comes back with the server's message
  await page.locator('.tile.folder', { hasText: 'Test' }).click()
  await page.locator('.tile', { hasText: 'PostgreSQL 17' }).dblclick()
  await page.locator('input[type=password]').fill('wrong')
  await page.keyboard.press('Enter')
  await page.locator('[role=dialog]', { hasText: 'password authentication failed' }).waitFor({ timeout: 10000 })
  check('wrong password asks again', (await page.locator('input[type=password]').count()) === 1)
  await page.locator('input[type=password]').fill('test')
  await page.keyboard.press('Enter')
  await page.locator('.workspace').last().waitFor()
  await page.locator('.workspace:visible .editor-page:visible .monaco-editor').first().waitFor()
  const ws = page.locator('.workspace:visible')
  check('connected with the default schema first in search_path', /PostgreSQL 17.*shop/.test(await ws.locator('.conn').innerText()), await ws.locator('.conn').innerText())

  // multi statement script, auto LIMIT, error stops the script with the SQLSTATE
  await runSql(page, 'SELECT * FROM customer;\nSELECT nope FROM customer;\nSELECT 1;')
  let out = await outputMessages(page)
  check('auto LIMIT appended', out.some((l) => l.startsWith(`SELECT * FROM customer LIMIT 1000 | ${uiText('output.rowsReturned', { count: 3 })}`)), out.join('\n'))
  check('error reported with SQLSTATE', out.some((l) => l.includes(uiText('output.errorCode', { code: '42703', message: 'column "nope" does not exist' }))), out.join('\n'))

  // dollar-quoted bodies containing `;` run as one statement; notices become warnings
  await runSql(
    page,
    "DO $$\nBEGIN\n  RAISE NOTICE 'hello %', 1;\nEND\n$$;\nCREATE FUNCTION twice(x int) RETURNS int LANGUAGE plpgsql AS $$\nBEGIN\n  x := x * 2;\n  RETURN x;\nEND\n$$;\nSELECT twice(21) AS v;"
  )
  out = await outputMessages(page)
  check('notice shown as warning', out.some((l) => l.includes('| NOTICE hello 1')), out.slice(-5).join('\n'))
  const twice = await ws.locator('.grid .row').first().locator('.cell').first().innerText({ timeout: 5000 }).catch(() => '')
  check('function body with ; created and callable', twice === '42', out.slice(-3).join('\n'))

  // values: booleans and bytea
  await runSql(page, 'SELECT id, active, avatar, balance FROM customer WHERE id = 1')
  const cells = await ws.locator('.grid .row').first().locator('.cell').allInnerTexts()
  check('bool, bytea and numeric cells', cells.join('|') === '1|true|0x89504E47|10.50', cells.join('|'))

  // grid editing: change Bob's name, review dialog, apply
  await runSql(page, 'SELECT * FROM customer ORDER BY id')
  await page.waitForFunction(() => document.querySelector('.workspace .status')?.textContent === '')
  const cell = ws.locator('.grid .row').nth(1).locator('.cell').nth(1)
  await cell.dblclick()
  await page.keyboard.press('Meta+A')
  await page.keyboard.insertText('Bobby')
  await page.keyboard.press('Enter')
  await ws.getByRole('button', { name: 'Apply', exact: true }).click()
  const review = page.locator('[role=dialog]')
  await review.waitFor()
  await page.waitForTimeout(300)
  const script = await review.locator('.view-lines').innerText()
  check('review shows UPDATE by primary key', /UPDATE "shop"\."customer" SET "name" = 'Bobby' WHERE \("id" = 2\)/.test(script.replace(/\s+/g, ' ')), script)
  await shot(page, 'postgres-review')
  await review.getByRole('button', { name: 'Apply' }).click()
  await review.waitFor({ state: 'detached' })
  await page.waitForTimeout(300)
  check('edit applied to the database', psql('SELECT name FROM shop.customer WHERE id = 2') === 'Bobby')

  // add a row through the grid (id and the other columns take their defaults)
  await ws.getByTitle('Add new row').click()
  await page.keyboard.press('Tab')
  await page.keyboard.type('Dora')
  await page.keyboard.press('Enter')
  await ws.getByRole('button', { name: 'Apply', exact: true }).click()
  await page.locator('[role=dialog]').getByRole('button', { name: 'Apply' }).click()
  await page.locator('[role=dialog]').waitFor({ state: 'detached' })
  await page.waitForTimeout(300)
  check('row inserted through the grid', psql("SELECT count(*) FROM shop.customer WHERE name = 'Dora' AND active") === '1')

  await checkSafeUpdates(page, check, 'orders', () => psql("SELECT string_agg(status, ',' ORDER BY id) FROM shop.orders"))

  // a table without primary key is read only
  await runSql(page, 'SELECT * FROM log_nopk')
  await page.waitForTimeout(300)
  const readOnly = await ws.locator('.status').innerText()
  check('table without PK is read only', readOnly === uiText('results.readOnly.noPrimaryKey'), readOnly)

  // navigator: schemas of the database, tables, columns, view, routines, trigger
  const node = (text) => ws.locator('.node', { hasText: text })
  const expand = (locator) => locator.locator('.twisty').dispatchEvent('mousedown')
  await node(/^shop$/).waitFor()
  const schemas = await ws.locator('.node').allInnerTexts()
  check('navigator lists the schemas without system ones', schemas.includes('shop') && schemas.includes('public') && !schemas.some((s) => s.startsWith('pg_')), schemas.join(','))
  await expand(node(/^shop$/))
  await expand(node('Tables'))
  await node(/^customer$/).first().waitFor()
  await expand(node(/^customer$/).first())
  await expand(node('Columns').first())
  await node('balance').waitFor()
  check('navigator shows columns with types', /numeric\(10,2\)/.test(await node('balance').innerText()))
  await expand(node('Triggers').first())
  await node('customer_bi').waitFor()
  check('navigator shows the trigger', /BEFORE INSERT/.test(await node('customer_bi').innerText()))
  await expand(node('Views'))
  await expand(node('Functions'))
  await expand(node('Stored Procedures'))
  await node('customer_trim_name').waitFor()
  const labels = await ws.locator('.node .label').allInnerTexts()
  for (const name of ['v_customer_orders', 'customer_count', 'twice', 'add_customer']) check(`navigator shows ${name}`, labels.includes(name), labels.join(','))
  // PostgreSQL only: sequences and types of the schema, extensions of the database
  const byKey = (key) => ws.locator(`[data-key="${key}"]`)
  await expand(byKey('s:shop/sequences'))
  await expand(byKey('s:shop/types'))
  await byKey('y:shop.dbm_positive').waitFor()
  check('Sequences of the schema list dbm_seq', (await byKey('q:shop.dbm_seq').count()) === 1, (await ws.locator('[data-key^="q:"]').allInnerTexts()).join(','))
  const typeKind = (name) => byKey(`y:shop.${name}`).locator('.detail').innerText().catch(() => '(missing)')
  const kinds = { dbm_mood: 'enum', dbm_positive: 'domain' }
  const shownKinds = {}
  for (const name of Object.keys(kinds)) shownKinds[name] = await typeKind(name)
  check('Types of the schema show their kind', Object.entries(kinds).every(([name, kind]) => shownKinds[name] === uiText(`schemaTree.typeKind.${kind}`)), JSON.stringify(shownKinds))
  await expand(byKey('db/extensions'))
  await byKey('x:plpgsql').waitFor()
  const plpgsql = psql("SELECT extversion FROM pg_extension WHERE extname = 'plpgsql'")
  check('Extensions of the database list plpgsql with its version', (await byKey('x:plpgsql').locator('.detail').innerText()) === plpgsql, `${await byKey('x:plpgsql').innerText()} (server: ${plpgsql})`)
  // the Extensions group belongs to no schema; an extension is no schema object to inspect
  await byKey('db/extensions').dispatchEvent('mousedown')
  await page.waitForTimeout(200)
  const groupInfo = await ws.locator('.info .body').innerText()
  check('Extensions group info has no empty Schema line', !groupInfo.split('\n').some((l) => l.trim() === uiText('info.schema')), groupInfo)
  await byKey('x:plpgsql').dispatchEvent('mousedown')
  await page.waitForTimeout(200)
  check('toolbar Inspector disabled on an extension', await ws.getByTitle('Open the inspector for the selected object', { exact: true }).isDisabled())
  await node(/^customer$/).first().dispatchEvent('mousedown')
  await page.waitForTimeout(200)
  check('object info shows the table columns', /balance/.test(await ws.locator('.info .body').innerText()))
  await shot(page, 'postgres-tree')

  // Import Data from File… of the navigator: CSV into the fixture's tables, then xlsx date cells into a date column
  await checkImportFile(app, page, check, {
    dir: userData,
    customerNode: node(/^customer$/).first(),
    ordersNode: node(/^orders$/).first(),
    query: (sql) => psql(`SET search_path TO shop; ${sql}`)
  })
  const dates = join(userData, 'import-dates.xlsx')
  // Excel's 1900 date system: serial 45000 is 2023-03-15, 45351 is 2024-02-29
  writeFileSync(dates, xlsx([['label', 'due'], ['first', 45000], ['leap', 45351]], 'B2:B3'))
  const failed = await importFile(app, page, node(/^import_dates$/), dates)
  const due = psql("SELECT label || '=' || to_char(due, 'YYYY-MM-DD') FROM shop.import_dates ORDER BY id")
  check('xlsx date cells stored as their dates', failed === '' && due === 'first=2023-03-15\nleap=2024-02-29', failed || due)

  // Create Statement of a table and of a function, sent to the editor
  const clearEditor = async () => {
    await ws.locator('.editor-page:visible .monaco-editor').first().click()
    await page.keyboard.press('Meta+A')
    await page.keyboard.press('Backspace')
  }
  await chooseFromContextMenu(app, 'send:create')
  await clearEditor()
  await node(/^customer$/).first().dispatchEvent('contextmenu')
  await page.waitForTimeout(400)
  let text = (await editorText(page)).replace(/\s+/g, ' ')
  check('table Create Statement', text.includes('CREATE TABLE "shop"."customer" ( "id" integer GENERATED BY DEFAULT AS IDENTITY NOT NULL,') && text.includes('CONSTRAINT "customer_pkey" PRIMARY KEY (id)') && text.includes('CREATE INDEX idx_name ON shop.customer USING btree (name);'), text)
  await clearEditor()
  await node('customer_count').dispatchEvent('contextmenu')
  await page.waitForTimeout(400)
  text = (await editorText(page)).replace(/\s+/g, ' ')
  check('function Create Statement', text.startsWith('CREATE OR REPLACE FUNCTION shop.customer_count() RETURNS integer') && text.includes('$function$;'), text)

  // Alter Function on a trigger function: replaced in place, not dropped
  await chooseFromContextMenu(app, 'alter-routine')
  await node('customer_trim_name').dispatchEvent('contextmenu')
  await ws.locator('.page-header', { hasText: 'function shop.customer_trim_name' }).waitFor()
  await page.waitForTimeout(300)
  await ws.locator('.page:visible').getByRole('button', { name: 'Apply' }).click()
  await review.waitFor()
  await page.waitForTimeout(300)
  const alter = (await review.locator('.view-lines').innerText()).replace(/\s+/g, ' ')
  check('alter function keeps the function (no DROP)', !/DROP FUNCTION/.test(alter) && alter.includes('CREATE OR REPLACE FUNCTION shop.customer_trim_name()'), alter)
  await review.getByRole('button', { name: 'Apply' }).click()
  await review.waitFor({ state: 'detached', timeout: 5000 }).catch(() => undefined)
  check('alter function applied', (await review.count()) === 0, await review.innerText().catch(() => ''))
  await ws.locator('.editors > .tabbar .tab', { hasText: 'Query 1' }).click()

  // explain: plan tree with a full scan and an index scan
  await runSql(page, 'SELECT * FROM customer c JOIN orders o ON o.customer_id = c.id', 'Meta+Alt+X')
  await page.waitForTimeout(400)
  check('visual explain shows the plan tree', (await ws.locator('.plan .step').count()) >= 3 && (await ws.locator('.plan .access.bad', { hasText: 'Seq Scan' }).count()) > 0, await ws.locator('.plan').innerText())
  await shot(page, 'postgres-explain')
  await runSql(page, 'SELECT * FROM customer WHERE id = 1', 'Meta+Alt+X')
  await page.waitForTimeout(400)
  check('index scan shown as index access', (await ws.locator('.plan .access.good', { hasText: 'Index Scan' }).count()) === 1, await ws.locator('.plan').innerText())

  // Stop: pg_cancel_backend on a running statement
  await clearEditor()
  await page.keyboard.insertText('SELECT pg_sleep(30)')
  const t0 = Date.now()
  await page.keyboard.press('Meta+Shift+Enter')
  await page.waitForTimeout(800)
  await ws.getByTitle('Stop the query being executed').click()
  await page.waitForFunction(() => !document.querySelector('.workspace .running'), null, { timeout: 15000 })
  out = await outputMessages(page)
  check('stop cancels the statement quickly', Date.now() - t0 < 6000 && /57014/.test(out.at(-1)), `${Date.now() - t0} ms ${out.at(-1)}`)
  await runSql(page, 'SELECT 1 AS alive')
  out = await outputMessages(page)
  check('connection usable after stop', (out.at(-1) ?? '').includes(`| ${uiText('output.rowsReturned', { count: 1 })}`), out.at(-1))

  // the server drops the connections: the next statement reconnects
  psql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'DBKnife'")
  await page.waitForTimeout(300)
  await runSql(page, 'SELECT current_schema() AS s')
  out = await outputMessages(page)
  check(
    'reconnects after the server closed the session',
    out.some((l) => l.startsWith(`${uiText('output.reconnect')} | ${uiText('output.reconnected')}`)) &&
      out.some((l) => l.startsWith(`SELECT current_schema() AS s LIMIT 1000 | ${uiText('output.rowsReturned', { count: 1 })}`)),
    out.slice(-3).join('\n')
  )
  check('default schema kept after reconnect', (await ws.locator('.grid .row').first().locator('.cell').first().innerText()) === 'shop')

  // completion offers PostgreSQL's keywords, not MySQL's
  const ili = await suggestions(page, 'SELECT * FROM customer WHERE name ili')
  const ye = await suggestions(page, 'SELECT ye')
  check("completion uses PostgreSQL's dictionary, not MySQL's", ili.some((l) => /^ilike$/i.test(l)) && !ye.some((l) => /^YEAR(_MONTH|WEEK)$/i.test(l)), `${ili.join(',')} / ${ye.join(',')}`)

  await shot(page, 'postgres-final')
  check('no renderer errors', errors.length === 0, errors.join('\n'))
} catch (e) {
  failures++
  console.log('FAIL exception', e.message)
  await shot(page, 'postgres-exception')
} finally {
  await app.close()
}
console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed')
process.exit(failures ? 1 : 0)
