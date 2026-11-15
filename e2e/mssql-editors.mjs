// Table editor, inspector, routine editor, schema dialog and table maintenance on
// SQL Server, against the test VM (database dbm_test_ed):
//   pnpm exec electron-vite build && node e2e/mssql-editors.mjs
// The script recreates dbm_test_ed from e2e/fixture-mssql.sql on every run.
import {
  answerMessages,
  checker,
  chooseFromContextMenu,
  connect,
  launch,
  loadMssqlFixture,
  mssqlQuery,
  mssqlServer,
  outputEntries,
  profileWith,
  recordedMessages,
  shot,
  uiText
} from './lib.mjs'

const database = 'dbm_test_ed'
await loadMssqlFixture(database)
await mssqlQuery('CREATE USER ed_owner WITHOUT LOGIN', database)
const q = (sql) => mssqlQuery(sql, database)
/** First column of the first row of `sql`. */
const value = async (sql) => {
  const [row] = await q(sql)
  return row ? Object.values(row)[0] : undefined
}
const result = checker()
const { check } = result

const server = mssqlServer(database)
const { app, page, errors } = await launch(profileWith([server]))
const ws = page.locator('.workspace:visible')
const editor = () => ws.locator('.editor-page:visible')
const node = (label) => ws.locator('.node', { has: page.locator('.label', { hasText: new RegExp(`^${label}$`) }) }).first()
const expand = (label) => node(label).locator('.twisty').dispatchEvent('mousedown')
const subTab = (label) => editor().locator('.tabbar .tab', { hasText: label }).dispatchEvent('mousedown')
const review = page.locator('[role=dialog]').filter({ has: page.locator('.monaco-editor') })
/** Types into a cell input of the editor, committed as on leaving the field. */
const type = async (input, text) => {
  await input.fill(text)
  await input.press('Tab')
}
/** Output lines of the statements run since `from` lines were there. */
const ranSince = async (from) => (await outputEntries(page)).slice(from)
const outputLength = async () => (await outputEntries(page)).length
/** Output lines with their status, for the failure detail. */
const lines = (entries) => entries.map((e) => `${e.status} ${e.text}`).join('\n')
/** A statement starting with `prefix` ran without error since the last ranSince. */
const ranOk = (prefix) => ran.some((e) => e.text.startsWith(prefix) && e.status !== 'err')
/** A statement starting with `prefix` was run since the last ranSince. */
const ranAny = (prefix) => ran.some((e) => e.text.startsWith(prefix))
let from = 0
let ran = []

/** Applies the review dialog. */
async function applyReview() {
  await review.waitFor()
  await page.waitForTimeout(300)
  await review.getByRole('button', { name: 'Apply' }).click()
  await review.waitFor({ state: 'detached', timeout: 15000 })
  await page.waitForTimeout(400)
}
/** Replaces the text of the routine editor. */
async function setRoutineText(text) {
  await editor().locator('.monaco-editor').first().click()
  await page.keyboard.press('Meta+A')
  await page.keyboard.press('Backspace')
  await page.keyboard.insertText(text)
}

try {
  await answerMessages(app)
  await connect(page, server)
  await expand('shop')
  await expand('Tables')
  await node('customer').waitFor()

  // --- table editor: rename, retype a column with a default, add a column with a default, index, comment ---
  await chooseFromContextMenu(app, 'alter-table')
  await node('customer').dispatchEvent('contextmenu')
  await editor().locator('.columns-tab').waitFor()
  await page.waitForTimeout(500)
  const rows = editor().locator('.columns-tab tbody tr')
  const row = (name) => rows.filter({ has: page.locator(`input[value="${name}"]`) })
  await type(row('notes').locator('input[type=text]').first(), 'remark')
  await type(row('balance').locator('input[type=text]').nth(1), 'decimal(12,2)')
  await rows.last().dispatchEvent('mousedown')
  await editor().locator('button[title="Add a column after the selected one"]').click()
  const added = rows.last()
  await type(added.locator('input[type=text]').first(), 'score')
  await type(added.locator('input[type=text]').nth(1), 'smallint')
  await type(added.locator('input[type=text]').nth(2), '0')
  await editor().locator('.header textarea').fill('Customer list')
  await shot(page, 'mssql-editors-01-columns')
  await subTab('Indexes')
  await page.waitForTimeout(200)
  const indexRows = editor().locator('.indexes-tab .side tbody tr')
  const idx = await indexRows.evaluateAll((trs) => trs.findIndex((tr) => tr.querySelector('input')?.value === 'idx_name'))
  await indexRows.nth(idx).dispatchEvent('mousedown')
  await editor().locator('.indexes-tab button[title="Remove the selected index"]').click()
  await editor().locator('.indexes-tab button[title="Add an index"]').click()
  await editor().locator('.indexes-tab .main tbody tr', { hasText: 'score' }).locator('input[type=checkbox]').check()
  await shot(page, 'mssql-editors-02-indexes')
  from = await outputLength()
  await editor().locator('.actions button.primary').click()
  await applyReview()
  ran = await ranSince(from)
  check('script committed', ranOk('COMMIT'), lines(ran))
  check('rename through sp_rename', ranOk("EXEC sp_rename N'[shop].[customer].[notes]', N'remark', N'COLUMN'"), lines(ran))
  check('type changed', ranOk('ALTER TABLE [shop].[customer] ALTER COLUMN [balance] decimal(12,2) NOT NULL'), lines(ran))
  const columns = (await q("SELECT c.name, TYPE_NAME(c.user_type_id) AS t, c.precision AS p, c.scale AS s FROM sys.columns c WHERE c.object_id = OBJECT_ID('shop.customer') ORDER BY c.column_id")).map(
    (c) => `${c.name}:${c.t}${c.t === 'decimal' ? `(${c.p},${c.s})` : ''}`
  )
  check('columns changed in the database', columns.includes('remark:nvarchar') && columns.includes('balance:decimal(12,2)') && columns.at(-1) === 'score:smallint' && !columns.includes('notes:nvarchar'), columns.join(','))
  const defaults = (await q("SELECT dc.name, dc.definition AS d, c.name AS c FROM sys.default_constraints dc JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id WHERE dc.parent_object_id = OBJECT_ID('shop.customer')")).map(
    (r) => `${r.c}=${r.name}:${r.d}`
  )
  check('defaults in the database', defaults.includes('balance=df_customer_balance:((0.00))') && defaults.includes('score=DF_customer_score:((0))'), defaults.join(','))
  const indexes = (await q("SELECT name FROM sys.indexes WHERE object_id = OBJECT_ID('shop.customer') AND name IS NOT NULL")).map((r) => r.name)
  check('index dropped and created', !indexes.includes('idx_name') && indexes.includes('customer_idx'), indexes.join(','))
  check(
    'table comment changed',
    (await value("SELECT CAST(value AS nvarchar(100)) FROM sys.extended_properties WHERE major_id = OBJECT_ID('shop.customer') AND minor_id = 0 AND name = 'MS_Description'")) === 'Customer list'
  )

  // IDENTITY cannot be added to an existing column: the editor says so and offers nothing to apply
  await subTab('Columns')
  await page.waitForTimeout(300)
  await row('score').locator('td.flag').nth(3).locator('input').check()
  await page.waitForTimeout(200)
  // the wording of the refusal is covered by test/shared/sql/table-ddl-mssql.test.ts
  const refusal = await editor().locator('p.error').innerText().catch(() => '')
  check('identity change refused: reason shown, nothing to apply', refusal !== '' && (await editor().locator('.actions button.primary').isDisabled()), refusal)
  await shot(page, 'mssql-editors-03-identity')
  await editor().getByRole('button', { name: 'Revert' }).click()

  // a failing script is rolled back as a whole: the rename that ran before the error is undone
  // (status could not be renamed at all: its CHECK constraint is a schema-bound reference)
  await chooseFromContextMenu(app, 'alter-table')
  await node('orders').dispatchEvent('contextmenu')
  await editor().locator('.columns-tab').waitFor()
  await page.waitForTimeout(500)
  await type(row('ordered_at').locator('input[type=text]').first(), 'placed_at')
  await type(row('total').locator('input[type=text]').nth(1), 'xml')
  from = await outputLength()
  await editor().locator('.actions button.primary').click()
  await review.waitFor()
  await page.waitForTimeout(300)
  await review.getByRole('button', { name: 'Apply' }).click()
  await review.locator('.error').waitFor({ timeout: 15000 })
  await page.waitForTimeout(500)
  await shot(page, 'mssql-editors-04-failed')
  const failure = await review.locator('.error').innerText()
  check('error shown in the review dialog', /xml|money|conver/i.test(failure), failure)
  ran = await ranSince(from)
  check('the rename ran before the failure', ranOk("EXEC sp_rename N'[shop].[orders].[ordered_at]'"), lines(ran))
  check('failed alter rolled back (rename undone)', (await value("SELECT COUNT(*) FROM sys.columns WHERE object_id = OBJECT_ID('shop.orders') AND name = 'ordered_at'")) === 1)
  check('no transaction left open', (await value("SELECT COUNT(*) FROM sys.dm_tran_session_transactions t JOIN sys.dm_exec_sessions s ON s.session_id = t.session_id WHERE s.program_name = 'DBKnife' AND s.database_id = DB_ID()")) === 0)
  await review.getByRole('button', { name: 'Cancel' }).click()
  await review.waitFor({ state: 'detached' })

  // create a table with a foreign key, then drop it
  await chooseFromContextMenu(app, 'create-table')
  await node('customer').dispatchEvent('contextmenu')
  await editor().locator('.columns-tab').waitFor()
  await type(editor().locator('.header input[type=text]').first(), 'note')
  await rows.last().dispatchEvent('mousedown')
  await editor().locator('button[title="Add a column after the selected one"]').click()
  await type(rows.last().locator('input[type=text]').first(), 'customer_id')
  await type(rows.last().locator('input[type=text]').nth(1), 'int')
  await subTab('Foreign Keys')
  await page.waitForTimeout(200)
  await editor().locator('.fks-tab button[title="Add a foreign key"]').click()
  await type(editor().locator('.fks-tab .side tbody tr').first().locator('input[type=text]').nth(1), 'shop.customer')
  await page.waitForTimeout(800)
  await editor().locator('.fks-tab .main tbody tr', { hasText: 'customer_id' }).locator('input[type=checkbox]').check()
  await editor().locator('.fks-tab .options select').nth(1).selectOption('CASCADE')
  await shot(page, 'mssql-editors-05-fk')
  await editor().locator('.actions button.primary').click()
  await applyReview()
  const fk = await q("SELECT fk.delete_referential_action_desc AS d, OBJECT_NAME(fk.referenced_object_id) AS r FROM sys.foreign_keys fk WHERE fk.parent_object_id = OBJECT_ID('shop.note')")
  check('foreign key in the database', fk.length === 1 && fk[0].d === 'CASCADE' && fk[0].r === 'customer', JSON.stringify(fk))
  await node('note').waitFor()
  await chooseFromContextMenu(app, 'drop')
  await node('note').dispatchEvent('contextmenu')
  await applyReview()
  check('table dropped', (await value("SELECT COUNT(*) FROM sys.tables WHERE name = 'note'")) === 0)

  // --- inspector ------------------------------------------------------------------------------------
  await chooseFromContextMenu(app, 'inspect')
  await node('customer').dispatchEvent('contextmenu')
  await page.waitForTimeout(1000)
  const inspectorText = async () => (await editor().innerText()).replace(/ /g, ' ')
  let text = await inspectorText()
  check('inspector info', /Customer list/.test(text), text)
  await subTab('Columns')
  await page.waitForTimeout(600)
  check('inspector columns', /remark/.test(await inspectorText()) && /IDENTITY\(1,1\)/.test(await inspectorText()))
  await subTab('Indexes')
  await page.waitForTimeout(600)
  check('inspector indexes', /customer_idx/.test(await inspectorText()) && /CLUSTERED/.test(await inspectorText()))
  await subTab('Constraints')
  await page.waitForTimeout(600)
  check('inspector constraints', /df_customer_balance/.test(await inspectorText()) && /pk_customer/.test(await inspectorText()), await inspectorText())
  await subTab('Triggers')
  await page.waitForTimeout(600)
  check('inspector triggers', /customer_ai/.test(await inspectorText()))
  await subTab('DDL')
  await page.waitForTimeout(600)
  check('inspector DDL', /CREATE TABLE \[shop\]\.\[customer\]/.test(await inspectorText()), await inspectorText())
  check('no inspector errors', !(await editor().locator('p.error').count()))
  await shot(page, 'mssql-editors-06-inspector')
  await chooseFromContextMenu(app, 'inspect')
  await node('shop').dispatchEvent('contextmenu')
  await page.waitForTimeout(1000)
  check('schema inspector info', /dbo/.test(await inspectorText()), await inspectorText())
  await subTab('Tables')
  await page.waitForTimeout(600)
  check('schema inspector tables', /orders/.test(await inspectorText()) && /log_nopk/.test(await inspectorText()))
  await subTab('Routines')
  await page.waitForTimeout(600)
  check('schema inspector routines', /add_customer/.test(await inspectorText()) && /SQL_INLINE_TABLE_VALUED_FUNCTION/.test(await inspectorText()))

  // --- routine editor: Alter View, Create Procedure, Alter Procedure, Create Trigger -----------------
  await expand('Views')
  await node('v_customer_orders').waitFor()
  await chooseFromContextMenu(app, 'alter-routine')
  await node('v_customer_orders').dispatchEvent('contextmenu')
  await ws.locator('.page-header', { hasText: 'view shop.v_customer_orders' }).waitFor()
  await page.waitForTimeout(400)
  text = (await editor().locator('.view-lines').innerText()).replace(/ /g, ' ')
  check('view loaded as CREATE OR ALTER', text.startsWith('CREATE OR ALTER VIEW shop.v_customer_orders'), text)
  await setRoutineText(
    'CREATE OR ALTER VIEW shop.v_customer_orders AS\nSELECT c.name, COUNT(o.id) AS n, SUM(o.total) AS spent FROM shop.customer c LEFT JOIN shop.orders o ON o.customer_id = c.id GROUP BY c.name'
  )
  from = await outputLength()
  await editor().getByRole('button', { name: 'Apply' }).click()
  await applyReview()
  ran = await ranSince(from)
  check('alter view keeps the view (no DROP)', !ranAny('DROP') && ranAny('CREATE OR ALTER VIEW shop.v_customer_orders'), lines(ran))
  check('view changed in the database', (await value("SELECT COUNT(*) FROM sys.columns WHERE object_id = OBJECT_ID('shop.v_customer_orders') AND name = 'spent'")) === 1)

  await expand('Stored Procedures')
  await node('add_customer').waitFor()
  await chooseFromContextMenu(app, 'create-procedure')
  await node('Stored Procedures').dispatchEvent('contextmenu')
  await ws.locator('.page-header', { hasText: 'New procedure in shop' }).waitFor()
  await page.waitForTimeout(400)
  await editor().getByRole('button', { name: 'Apply' }).click()
  await applyReview()
  check('procedure created', (await value("SELECT COUNT(*) FROM sys.procedures WHERE object_id = OBJECT_ID('shop.new_procedure')")) === 1)

  await chooseFromContextMenu(app, 'alter-routine')
  await node('add_customer').dispatchEvent('contextmenu')
  await ws.locator('.page-header', { hasText: 'procedure shop.add_customer' }).waitFor()
  await page.waitForTimeout(400)
  from = await outputLength()
  await editor().getByRole('button', { name: 'Apply' }).click()
  await applyReview()
  ran = await ranSince(from)
  check('alter procedure in one batch, no DROP', !ranAny('DROP') && ranOk('CREATE OR ALTER PROCEDURE shop.add_customer'), lines(ran))

  await chooseFromContextMenu(app, 'create-trigger')
  await node('orders').dispatchEvent('contextmenu')
  await ws.locator('.page-header', { hasText: 'New trigger in shop' }).waitFor()
  await page.waitForTimeout(400)
  await editor().getByRole('button', { name: 'Apply' }).click()
  await applyReview()
  check('trigger created on its table', (await value("SELECT OBJECT_NAME(parent_id) FROM sys.triggers WHERE name = 'orders_after_insert'")) === 'orders')
  await shot(page, 'mssql-editors-07-routines')

  // --- schema dialog: create with an owner, change the owner, drop -----------------------------------
  await chooseFromContextMenu(app, 'create-schema')
  await node('shop').dispatchEvent('contextmenu')
  const dialog = page.locator('[role=dialog]').filter({ has: page.locator('#md-name') })
  await dialog.waitFor()
  await page.waitForTimeout(400)
  await dialog.locator('#md-name').fill('ed_schema')
  await dialog.locator('#md-owner').selectOption('dbo')
  await shot(page, 'mssql-editors-08-schema')
  await dialog.getByRole('button', { name: 'Apply' }).click()
  await applyReview()
  await dialog.waitFor({ state: 'detached' })
  check('schema created with its owner', (await value("SELECT USER_NAME(principal_id) FROM sys.schemas WHERE name = 'ed_schema'")) === 'dbo')
  await node('ed_schema').waitFor()
  await chooseFromContextMenu(app, 'alter-schema')
  await node('ed_schema').dispatchEvent('contextmenu')
  await dialog.waitFor()
  await page.waitForTimeout(400)
  check('schema name cannot change', await dialog.locator('#md-name').isDisabled())
  await dialog.locator('#md-owner').selectOption('ed_owner')
  await dialog.getByRole('button', { name: 'Apply' }).click()
  await applyReview()
  await dialog.waitFor({ state: 'detached' })
  check('schema owner in the database', (await value("SELECT USER_NAME(principal_id) FROM sys.schemas WHERE name = 'ed_schema'")) === 'ed_owner')
  await chooseFromContextMenu(app, 'drop')
  await node('ed_schema').dispatchEvent('contextmenu')
  await applyReview()
  check('schema dropped', (await value("SELECT COUNT(*) FROM sys.schemas WHERE name = 'ed_schema'")) === 0)

  // --- table maintenance: statements in a query tab ---------------------------------------------------
  // the navigator was reloaded by the schema changes
  /** Expands `parent` until `child` shows (a reload in progress can collapse it again). */
  const reveal = async (parent, child) => {
    for (let i = 0; i < 5 && !(await node(child).isVisible()); i++) {
      await page.waitForTimeout(1000)
      if (!(await node(child).isVisible())) await expand(parent)
      await node(child).waitFor({ timeout: 3000 }).catch(() => undefined)
    }
  }
  for (const [op, prefix] of [
    ['m:0', 'UPDATE STATISTICS [shop].[customer]'],
    ['m:1', 'ALTER INDEX ALL ON [shop].[customer] REBUILD'],
    ['m:3', "DBCC CHECKTABLE (N'[shop].[customer]')"]
  ]) {
    // ALTER INDEX reloads it too
    await reveal('shop', 'Tables')
    await reveal('Tables', 'customer')
    from = await outputLength()
    await chooseFromContextMenu(app, op)
    await node('customer').dispatchEvent('contextmenu')
    await page.waitForTimeout(500)
    await page.waitForFunction(() => !document.querySelector('.workspace:not([style*="display: none"]) .running'))
    await page.waitForTimeout(500)
    ran = await ranSince(from)
    check(`maintenance ${prefix}`, ranAny(prefix) && !ran.some((e) => e.status === 'err'), lines(ran))
  }

  await shot(page, 'mssql-editors-final')
  const messages = await recordedMessages(app)
  check('only the drop confirmations as message boxes', messages.length === 2 && messages[0].startsWith(uiText('workspace.drop.table', { name: 'shop.note' })) && messages[1].startsWith(uiText('workspace.drop.schema', { name: 'ed_schema' })), messages.join('\n'))
  check('no renderer errors', errors.length === 0, errors.join('\n'))
} catch (e) {
  result.failures++
  console.log('FAIL exception', e.message)
  await shot(page, 'mssql-editors-exception')
} finally {
  await app.close()
}
const failures = result.failures
console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed')
process.exit(failures ? 1 : 0)
