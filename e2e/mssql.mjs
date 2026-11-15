// End-to-end check of SQL Server support against the SQL Server test host
// (DBM_MSSQL_HOST, port 1433, login dbm_test/test, Italian login language):
//   pnpm exec electron-vite build && DBM_MSSQL_HOST=<host> node e2e/mssql.mjs
// The script recreates the dbm_test database (or DBM_MSSQL_DATABASE, another dbm_test* name)
// from e2e/fixture-mssql.sql on every run.
import {
  answerMessages,
  checker,
  checkSafeUpdates,
  chooseFromContextMenu,
  editorText,
  launch,
  loadMssqlFixture,
  menu,
  mssqlQuery,
  outputEntries,
  outputMessages,
  profileWith,
  recordedMessages,
  runSql,
  servers,
  shot,
  suggestions,
  uiText
} from './lib.mjs'

const server = { ...servers.mssql, database: process.env.DBM_MSSQL_DATABASE || 'dbm_test' }
await loadMssqlFixture(server.database)
const result = checker()
const { check } = result
/** First column of the first row of a batch run outside the app. */
const scalar = async (sql) => {
  const [row] = await mssqlQuery(sql, server.database)
  return row ? Object.values(row)[0] : undefined
}
const flat = (s) => s.replace(/ /g, ' ').replace(/\s+/g, ' ').trim()

const { app, page, errors } = await launch(profileWith([server]))
const ws = page.locator('.workspace:visible')
/** The active tab's page (query editor and its results). */
const ed = ws.locator('.editor-page:visible')
const review = page.locator('[role=dialog]')
const node = (label) => ws.locator('.node', { has: page.locator('.label', { hasText: new RegExp(`^${label}$`) }) }).first()
const expand = (label) => node(label).locator('.twisty').dispatchEvent('mousedown')
const rows = () => ed.locator('.grid .row')
/** Cell of the visible grid by row number and column name. */
const cell = async (r, name) => {
  const names = await ed.locator('.grid .hcell .hname').allInnerTexts()
  return rows().nth(r).locator('.cell').nth(names.indexOf(name))
}
const editCell = async (r, name, text) => {
  await (await cell(r, name)).dblclick()
  await page.keyboard.press('Meta+A')
  await page.keyboard.insertText(text)
  await page.keyboard.press('Enter')
}
/** Applies the grid changes through the review dialog and returns its script. */
async function applyGrid() {
  await ed.getByRole('button', { name: 'Apply', exact: true }).click()
  await review.waitFor()
  await page.waitForTimeout(300)
  const script = flat(await review.locator('.view-lines').innerText())
  await review.getByRole('button', { name: 'Apply' }).click()
  await review.waitFor({ state: 'detached', timeout: 10000 })
  await page.waitForTimeout(300)
  return script
}
const clearEditor = async () => {
  await ws.locator('.editor-page:visible .monaco-editor').first().click()
  await page.keyboard.press('Meta+A')
  await page.keyboard.press('Backspace')
}
/** Text of the editor lines carrying an error marker. */
const markedLines = () =>
  ws.locator('.editor-page:visible .monaco-editor').first().evaluate((root) => {
    const lines = [...root.querySelectorAll('.view-line')].map((l) => ({ top: parseInt(l.style.top), text: l.textContent.replace(/\u00a0/g, ' ') }))
    return [...root.querySelectorAll('.view-overlays .squiggly-error')].map((s) => lines.find((l) => l.top === parseInt(s.parentElement.style.top))?.text)
  })
const queryTab = (label) => ws.locator('.editors > .tabbar .tab', { hasText: label })

try {
  await answerMessages(app)
  // wrong password: the prompt comes back with the server's message
  await page.locator('.tile.folder', { hasText: 'Test' }).click()
  await page.locator('.tile', { hasText: 'SQL Server 2019' }).dblclick()
  await page.locator('input[type=password]').fill('wrong')
  await page.keyboard.press('Enter')
  // the login error (18456) comes in the login's language: it names the user between quotes
  await page.locator('[role=dialog]', { hasText: "'dbm_test'" }).waitFor({ timeout: 10000 })
  check('wrong password asks again', (await page.locator('input[type=password]').count()) === 1)
  await page.locator('input[type=password]').fill('test')
  await page.keyboard.press('Enter')
  await page.locator('.workspace:visible .editor-page:visible .monaco-editor').first().waitFor()
  const conn = await ws.locator('.conn').innerText()
  check('connected, showing the server and the default schema', /SQL Server 2019/.test(conn) && /dbo/.test(conn), conn)

  // --- navigator: schemas of dbm_test without the system ones, objects of shop ------------------
  await node('shop').waitFor()
  const schemas = await ws.locator('.node .label').allInnerTexts()
  check('navigator lists dbo and shop without system schemas', schemas.includes('dbo') && schemas.includes('shop') && !schemas.some((s) => /^(sys|INFORMATION_SCHEMA|db_owner|guest)$/.test(s)), schemas.join(','))
  await expand('shop')
  await expand('Tables')
  await node('customer').waitFor()
  await expand('customer')
  await expand('Columns')
  await node('balance').waitFor()
  check('navigator shows columns with types', /decimal\(10,2\)/.test(await node('balance').innerText()), await node('balance').innerText())
  await expand('Triggers')
  await node('customer_ai').waitFor()
  check('navigator shows the trigger', /AFTER INSERT/.test(await node('customer_ai').innerText()), await node('customer_ai').innerText())
  await expand('Views')
  await expand('Functions')
  await expand('Stored Procedures')
  await node('add_customer').waitFor()
  const labels = await ws.locator('.node .label').allInnerTexts()
  for (const name of ['orders', 'log_nopk', 'v_customer_orders', 'customer_count', 'customer_orders', 'order_totals', 'add_customer'])
    check(`navigator shows ${name}`, labels.includes(name), labels.join(','))
  await shot(page, 'mssql-tree')

  // --- DDL: Copy to Clipboard of the table runs as is; Send to Editor of a procedure ends with GO -
  await chooseFromContextMenu(app, 'copy:create')
  await node('customer').dispatchEvent('contextmenu')
  await page.waitForTimeout(500)
  const tableDdl = await app.evaluate(({ clipboard }) => clipboard.readText())
  check(
    'table Create Statement',
    tableDdl.includes('CREATE TABLE [shop].[customer] (') && /CONSTRAINT \[pk_customer\] PRIMARY KEY CLUSTERED \(\[id\]\)/.test(tableDdl) && /CREATE NONCLUSTERED INDEX \[idx_name\]/.test(tableDdl),
    tableDdl
  )
  // the same DDL creates a twin table in dbo: it is valid T-SQL
  const twin = tableDdl.replaceAll('[shop].[customer]', '[dbo].[customer_twin]').replaceAll("N'shop'", "N'dbo'").replaceAll("N'customer'", "N'customer_twin'")
  const twinError = await mssqlQuery(twin, server.database).then(
    () => '',
    (e) => e.message
  )
  check('copied table DDL runs', !twinError && (await scalar("SELECT COUNT(*) FROM sys.columns WHERE object_id = OBJECT_ID('dbo.customer_twin')")) === 9, twinError)
  await chooseFromContextMenu(app, 'send:create')
  await clearEditor()
  await node('add_customer').dispatchEvent('contextmenu')
  await page.waitForTimeout(500)
  let text = flat(await editorText(page))
  check('procedure Create Statement sent to the editor with GO', text.startsWith('CREATE PROCEDURE shop.add_customer @name nvarchar(100)') && /END GO$/.test(text), text)

  // --- execution: GO batches, procedure body with ;, result sets, PRINT --------------------------
  await runSql(
    page,
    [
      'CREATE TABLE #tmp (id int, label nvarchar(10));',
      "INSERT INTO #tmp VALUES (1, N'a'), (2, N'b');",
      'GO',
      'CREATE PROCEDURE dbo.e2e_twice @n int',
      'AS',
      'BEGIN',
      '  SET NOCOUNT ON;',
      "  PRINT 'twice of ' + CAST(@n AS varchar(10));",
      '  SELECT @n AS n;',
      '  IF @n > 0',
      '    SELECT @n * 2 AS twice;',
      '  ELSE',
      '  BEGIN',
      '    SELECT 0 AS twice;',
      '  END;',
      'END',
      'GO',
      'EXEC dbo.e2e_twice 21;'
    ].join('\n')
  )
  let out = await outputMessages(page)
  const procBody = await scalar("SELECT definition FROM sys.sql_modules WHERE object_id = OBJECT_ID('dbo.e2e_twice')")
  check('procedure with ; in its body created whole', typeof procBody === 'string' && /END;\s*END\s*$/.test(procBody), String(procBody))
  check('no errors in the GO script', !(await outputEntries(page)).some((e) => e.status === 'err'), out.join('\n'))
  const resultTabs = await ed.locator('.results .tabbar .tab').allInnerTexts()
  check('EXEC returns both result sets', resultTabs.length === 2, resultTabs.join(','))
  check('PRINT shown in the output', out.some((l) => /twice of 21/.test(l)), out.join('\n'))

  // error in a multi line batch: the message has the line, the editor marks that line only
  await runSql(page, 'SELECT 1 AS a\nSELECT 2 AS b\nSELECT nope FROM shop.customer')
  out = await outputMessages(page)
  check('error reported with number and line', out.some((l) => l.includes(uiText('output.errorCode', { code: 207, message: '' }).trim()) && l.includes(uiText('main.mssql.errorLine', { message: '', line: 3 }).trim())), out.slice(-3).join('\n'))
  await page.waitForTimeout(300)
  let marked = await markedLines()
  check('error marker on the failing line', marked.join('|') === 'SELECT nope FROM shop.customer', marked.join('|'))
  // the line counts from the start of the failed statement, the second one here (TOP added on its first line)
  await runSql(page, 'SELECT 0 AS z;\nSELECT name\nFROM shop.customer\nWHERE name = = 1')
  await page.waitForTimeout(300)
  marked = await markedLines()
  check('error marker on the failing line of a later statement', marked.join('|') === 'WHERE name = = 1', marked.join('|'))

  // Stop: the attention ends WAITFOR at once and the session stays usable
  await clearEditor()
  await page.keyboard.insertText("WAITFOR DELAY '00:00:30'")
  const t0 = Date.now()
  await page.keyboard.press('Meta+Shift+Enter')
  await page.waitForTimeout(800)
  await ws.getByTitle('Stop the query being executed').click()
  await page.waitForFunction(() => !document.querySelector('.workspace .running'), null, { timeout: 15000 })
  out = await outputMessages(page)
  check('stop cancels the batch quickly', Date.now() - t0 < 6000 && !!out.at(-1)?.includes(uiText('main.mssql.canceled')), `${Date.now() - t0} ms ${out.at(-1)}`)
  await runSql(page, 'SELECT 1 AS alive')
  check('connection usable after stop', (await rows().count()) === 1 && (await (await cell(0, 'alive')).innerText()) === '1', (await outputMessages(page)).at(-1))

  // --- row limit with TOP ---------------------------------------------------------------------
  /** Statement of an Output line. */
  const statement = (line) => line?.split(' | ')[0]
  await runSql(page, 'SELECT * FROM shop.orders')
  out = await outputMessages(page)
  check('TOP added to a query without limit', statement(out.at(-1)) === 'SELECT TOP (1000) * FROM shop.orders' && (await rows().count()) === 3, out.at(-1))
  await runSql(page, 'SELECT TOP 2 name FROM shop.customer ORDER BY id')
  out = await outputMessages(page)
  check('query with TOP left as is', statement(out.at(-1)) === 'SELECT TOP 2 name FROM shop.customer ORDER BY id' && (await rows().count()) === 2, out.at(-1))
  await chooseFromContextMenu(app, 'select')
  await node('orders').dispatchEvent('contextmenu')
  await queryTab('orders').waitFor()
  await page.waitForFunction(() => !document.querySelector('.workspace:not([style*="display: none"]) .running'))
  await page.waitForTimeout(300)
  out = await outputMessages(page)
  check('Select Rows limited with TOP', statement(out.at(-1)) === 'SELECT TOP (1000) * FROM [shop].[orders]' && (await rows().count()) === 3, out.at(-1))
  await queryTab('Query 1').click()

  // --- grid editing ---------------------------------------------------------------------------
  await runSql(page, 'SELECT id, name, email, balance FROM shop.customer ORDER BY id')
  await page.waitForFunction(() => document.querySelector('.workspace .status')?.textContent === '')
  await editCell(1, 'name', 'Bobby ✓')
  let script = await applyGrid()
  check('review shows UPDATE by primary key with an N literal', script.includes("UPDATE [shop].[customer] SET [name] = N'Bobby ✓' WHERE ([id] = 2)"), script)
  check('nvarchar edit applied', (await scalar('SELECT name FROM shop.customer WHERE id = 2')) === 'Bobby ✓')

  // insert a row (identity, computed column and defaults left out), then delete it
  // (one NULL email is already there: the unique constraint wants another value)
  await ed.getByTitle('Add new row').click()
  await page.keyboard.press('Escape')
  await editCell(3, 'name', 'Dora')
  await editCell(3, 'email', 'dora@example.com')
  await applyGrid()
  check('row inserted through the grid', (await scalar("SELECT COUNT(*) FROM shop.customer WHERE name = N'Dora' AND active = 1 AND balance = 0")) === 1)
  await runSql(page, 'SELECT id, name, email, balance FROM shop.customer ORDER BY id')
  const last = (await rows().count()) - 1
  await rows().nth(last).locator('.gutter').dispatchEvent('mousedown')
  await ed.getByTitle('Delete selected rows').click()
  script = await applyGrid()
  check('review shows the DELETE by primary key', /DELETE FROM \[shop\]\.\[customer\] WHERE \(\[id\] = \d+\)/.test(script), script)
  check('row deleted through the grid', (await scalar("SELECT COUNT(*) FROM shop.customer WHERE name = N'Dora'")) === 0)

  await checkSafeUpdates(page, check, 'shop.orders', () => scalar("SELECT STRING_AGG(status, ',') WITHIN GROUP (ORDER BY id) FROM shop.orders"))

  // exact decimals and dates: decimal(38,10) beyond a double, datetime under DATEFORMAT dmy, datetime2(7)
  await runSql(page, 'SELECT id, amount, price, at_datetime, at_datetime2, body FROM dbo.type_samples ORDER BY id')
  await page.waitForFunction(() => document.querySelector('.workspace .status')?.textContent === '')
  const shown = await Promise.all(['amount', 'price', 'at_datetime', 'at_datetime2'].map(async (c) => (await cell(0, c)).innerText()))
  check(
    'exact decimal, money and dates shown',
    shown.join('|') === '1234567890123456789012345678.0123456789|922337203685477.5807|2026-10-05 14:30:00.000|2026-10-05 14:30:00.1234567',
    shown.join('|')
  )
  await editCell(0, 'amount', '9876543210987654321098765432.1234567891')
  await editCell(0, 'at_datetime', '2026-10-07 09:15:00')
  await editCell(0, 'at_datetime2', '2026-10-08 10:20:30.7654321')
  await editCell(0, 'body', 'èé € ✓')
  await applyGrid()
  const [saved] = await mssqlQuery(
    `SELECT CAST(amount AS varchar(60)) AS amount, CONVERT(varchar(30), at_datetime, 126) AS dt, CONVERT(varchar(30), at_datetime2, 126) AS dt2, body
     FROM dbo.type_samples WHERE id = 1`,
    server.database
  )
  check('decimal(38,10) saved exactly', saved.amount === '9876543210987654321098765432.1234567891', saved.amount)
  check('datetime saved with day and month as typed', saved.dt === '2026-10-07T09:15:00', saved.dt)
  check('datetime2(7) saved with its 7 digits', saved.dt2 === '2026-10-08T10:20:30.7654321', saved.dt2)
  check('nvarchar(max) saved with its non Latin-1 characters', saved.body === 'èé € ✓', saved.body)

  // a table without primary key is read only
  await runSql(page, 'SELECT * FROM shop.log_nopk')
  await page.waitForTimeout(300)
  check('table without PK is read only', (await ed.locator('.status').innerText()) === uiText('results.readOnly.noPrimaryKey'), await ed.locator('.status').innerText())

  // --- explain: the showplan tree, and the session back to running statements -------------------
  await runSql(page, 'SELECT c.name, o.total FROM shop.customer c JOIN shop.orders o ON o.customer_id = c.id', 'Meta+Alt+X')
  await page.waitForTimeout(400)
  const plan = await ed.locator('.plan').innerText().catch(() => '')
  check('visual explain shows the plan tree', (await ed.locator('.plan .step').count()) >= 3 && (await ed.locator('.plan .access.bad').count()) > 0, plan)
  await shot(page, 'mssql-explain')
  await runSql(page, 'SELECT * FROM shop.customer WHERE id = 1', 'Meta+Alt+X')
  await page.waitForTimeout(400)
  check('index seek shown as good access', (await ed.locator('.plan .access.good', { hasText: 'Clustered Index Seek' }).count()) === 1, await ed.locator('.plan').innerText().catch(() => ''))
  // a failing statement must not leave the session in SHOWPLAN mode
  await runSql(page, 'SELECT nope FROM shop.orders', 'Meta+Alt+X')
  await runSql(page, 'SELECT COUNT(*) AS n FROM shop.orders')
  out = await outputMessages(page)
  check('statements run normally after explain', (await rows().count()) === 1 && (await (await cell(0, 'n')).innerText()) === '3', out.at(-1))

  // --- autocommit off: IMPLICIT_TRANSACTIONS, Rollback, Commit, back on ---------------------------
  const pending = async (msg) => [
    await scalar(`SELECT COUNT(*) FROM shop.log_nopk WITH (NOLOCK) WHERE msg = '${msg}'`),
    await scalar(`SELECT COUNT(*) FROM shop.log_nopk WITH (READPAST) WHERE msg = '${msg}'`)
  ]
  await menu(app, 'query.toggleAutocommit')
  await page.waitForTimeout(300)
  await runSql(page, "INSERT INTO shop.log_nopk VALUES ('pending')")
  check('autocommit off: insert left uncommitted', (await pending('pending')).join() === '1,0', (await pending('pending')).join())
  await menu(app, 'query.rollback')
  await page.waitForTimeout(500)
  check('rollback discards the insert', (await pending('pending')).join() === '0,0', (await pending('pending')).join())
  await runSql(page, "INSERT INTO shop.log_nopk VALUES ('kept')")
  await menu(app, 'query.commit')
  await page.waitForTimeout(500)
  check('commit keeps the insert', (await pending('kept')).join() === '1,1', `${(await pending('kept')).join()}\n${(await outputMessages(page)).slice(-6).join('\n')}`)
  await runSql(page, "INSERT INTO shop.log_nopk VALUES ('on')")
  await menu(app, 'query.toggleAutocommit')
  await page.waitForTimeout(500)
  check('autocommit on commits the open transaction', (await pending('on')).join() === '1,1', (await pending('on')).join())

  // --- USE: the navigator and the auxiliary connection follow the database ------------------------
  await runSql(page, 'USE master')
  await page.waitForTimeout(1000)
  let tree = await ws.locator('.node .label').allInnerTexts()
  check('USE master: the navigator shows master', !tree.includes('shop') && tree.includes('dbo'), tree.join(','))
  await runSql(page, 'SELECT DB_NAME() AS db')
  check('USE master: the session is on master', (await ed.locator('.grid .row').first().locator('.cell').first().innerText()) === 'master')
  await runSql(page, `USE ${server.database}`)
  await node('shop').waitFor({ timeout: 5000 }).catch(() => undefined)
  tree = await ws.locator('.node .label').allInnerTexts()
  check('USE back: the navigator is back on the test database', tree.includes('shop'), tree.join(','))

  // --- Search Table Data ------------------------------------------------------------------------
  // rows opened from the results: a datetime key (read as day/month by the Italian login), ntext without a key
  await runSql(
    page,
    "CREATE TABLE dbo.search_dt (at datetime PRIMARY KEY, note nvarchar(20));\nINSERT INTO dbo.search_dt VALUES ('2026-10-05T14:30:00', N'zqkey');\n" +
      "CREATE TABLE dbo.search_nopk (memo ntext);\nINSERT INTO dbo.search_nopk VALUES (N'zqmemo')"
  )
  await menu(app, 'db.searchData')
  const search = ed
  await search.locator('#sd-text').waitFor()
  // the default schema (dbo) comes selected; shop is added
  await search.locator('.schemas label', { hasText: /^\s*shop\s*$/ }).locator('input').check()
  const searchFor = async (value) => {
    await search.locator('#sd-text').fill(value)
    await search.getByRole('button', { name: 'Start Search' }).click()
    await page.waitForTimeout(2000)
    return search.locator('.results').innerText().catch(() => '')
  }
  let found = await searchFor('VIP')
  check('search is case insensitive', /customer/.test(found) && /notes/.test(found), found)
  found = await searchFor('€')
  check('search with non Latin-1 text', /type_samples/.test(found) && /body/.test(found), found)
  found = await searchFor('e_a')
  check('search escapes LIKE wildcards', !/customer/.test(found), found)
  found = await searchFor('zq')
  for (const table of ['search_dt', 'search_nopk']) {
    await search.locator('.results .row', { hasText: table }).first().dblclick()
    await queryTab(table).waitFor({ timeout: 5000 })
    await page.waitForFunction(() => !document.querySelector('.workspace:not([style*="display: none"]) .running'))
    await page.waitForTimeout(300)
    const out = (await outputMessages(page)).at(-1)
    check(`search result opens its row (${table})`, (await rows().count()) === 1, `${found}\n${out}`)
    await queryTab('Search Table Data').click()
  }
  await shot(page, 'mssql-search')
  await queryTab('Query 1').click()

  // --- completion: statements with #temp tables, procedures after EXEC ----------------------------------------
  // #tmp is a name, not a comment as in MySQL: the tables after it are still known
  let offered = await suggestions(page, 'SELECT * FROM #tmp t JOIN shop.orders o ON o.')
  check('completion after a #temp table reference', offered.includes('customer_id'), offered.join(','))
  offered = await suggestions(page, 'EXEC shop.')
  check('completion offers the procedures after EXEC schema.', offered.includes('add_customer'), offered.join(','))
  offered = await suggestions(page, 'EXEC ')
  check('completion offers the procedures of the default schema after EXEC', offered.includes('e2e_twice'), offered.join(','))

  await shot(page, 'mssql-final')
  const messages = await recordedMessages(app)
  check('no message boxes', messages.length === 0, messages.join('\n'))
  check('no renderer errors', errors.length === 0, errors.join('\n'))
} catch (e) {
  result.failures++
  console.log('FAIL exception', e.message)
  await shot(page, 'mssql-exception')
} finally {
  await app.close()
}
const failures = result.failures
console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed')
process.exit(failures ? 1 : 0)
