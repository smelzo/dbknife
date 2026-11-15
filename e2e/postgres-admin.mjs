// Administration pages and data export/import of PostgreSQL, against the
// dbm-test-postgres container (pg_dump and psql must be installed locally,
// e.g. brew install libpq):
//   pnpm exec electron-vite build && node e2e/postgres-admin.mjs
// The script reloads e2e/fixture-postgres.sql (schema "shop") on every run and
// leaves the server settings and roles as it found them.
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  answerMessages,
  checker,
  launch,
  loadPostgresFixture,
  menu,
  outputMessages,
  pgServer,
  profileWith,
  psql,
  recordedMessages,
  shot,
  uiText
} from './lib.mjs'

loadPostgresFixture()
psql('DROP ROLE IF EXISTS e2e_role, e2e_renamed')
const result = checker()
const { check } = result
const dumps = mkdtempSync(join(tmpdir(), 'dbm-e2e-dump-'))

const { app, page, errors } = await launch(profileWith([pgServer]))
const ws = page.locator('.workspace:visible')
const editor = () => ws.locator('.editor-page:visible')
const review = page.locator('[role=dialog]')
const text = async (locator) => (await locator.innerText()).replace(/ /g, ' ')

async function applyReview() {
  await review.waitFor()
  await page.waitForTimeout(300)
  const script = (await text(review.locator('.view-lines'))).replace(/\s+/g, ' ')
  await review.getByRole('button', { name: 'Apply' }).click()
  await review.waitFor({ state: 'detached', timeout: 10000 })
  await page.waitForTimeout(300)
  return script
}

/** Runs the export or import job of the open page and waits for its end; returns its status line and whether it shows an error. */
async function runJob(button) {
  await editor().getByRole('button', { name: button }).click()
  await editor().locator('.status', { hasText: /has finished|Error|Cancelled|failed|not found/ }).waitFor({ timeout: 60000 })
  const status = editor().locator('.status')
  return { text: await status.innerText(), failed: await status.evaluate((e) => e.classList.contains('error')) }
}

try {
  await answerMessages(app)
  await page.locator('.tile.folder', { hasText: 'Test' }).click()
  await page.locator('.tile', { hasText: 'PostgreSQL 17' }).dblclick()
  await page.locator('input[type=password]').fill('test')
  await page.keyboard.press('Enter')
  await page.locator('.workspace:visible .editor-page:visible .monaco-editor').first().waitFor()

  // --- Server Status -----------------------------------------------------------------------
  await menu(app, 'server.status')
  await editor().locator('.page-header', { hasText: 'Server Status' }).waitFor()
  await page.waitForTimeout(3500)
  const status = await text(editor())
  // a row of the page is shown only when its value was read from the server
  const statusError = (await editor().locator('.error').count()) > 0
  check('status: version and start time', !statusError && /PostgreSQL 17/.test(status) && status.includes(uiText('admin.status.runningSince')), status.slice(0, 500))
  // a whole cell: the configuration file's path contains the data directory too
  const statusValues = await editor().locator('table.kv td').allInnerTexts()
  check('status: settings sections', statusValues.includes(psql('SHOW data_directory')) && status.includes(uiText('admin.status.sharedBuffers')), status.slice(0, 800))
  await shot(page, 'pg-admin-01-status')

  // --- Client Connections: cancel a running query of another session --------------------------
  const sleeper = execFile('docker', ['exec', '-e', 'PGAPPNAME=e2e_sleeper', 'dbm-test-postgres', 'psql', '-U', 'postgres', '-c', 'SELECT pg_sleep(30)'])
  const sleeperEnd = new Promise((resolve) => sleeper.on('close', resolve))
  await menu(app, 'server.connections')
  await editor().locator('.summary', { hasText: 'Client Connections' }).waitFor()
  await editor().locator('.grid .row', { hasText: 'e2e_sleeper' }).waitFor({ timeout: 10000 })
  const grid = await text(editor().locator('.list'))
  check('connections: client backends listed', /client backend/.test(grid) && /DBKnife/.test(grid), grid.slice(0, 400))
  check('connections: background processes hidden', !/checkpointer/.test(grid))
  await editor().locator('.grid .row', { hasText: 'e2e_sleeper' }).locator('.cell').first().click()
  await editor().getByRole('button', { name: 'Kill Queries' }).click()
  const t0 = Date.now()
  await sleeperEnd
  check('connections: kill query cancels the statement', Date.now() - t0 < 10000, `${Date.now() - t0} ms`)
  await shot(page, 'pg-admin-02-connections')

  // --- Users and Privileges: create, change and drop a role ---------------------------------------
  await menu(app, 'server.users')
  await editor().locator('.accounts tbody tr', { hasText: 'postgres' }).first().waitFor()
  await editor().getByRole('button', { name: 'Add Role' }).click()
  await editor().locator('#pr-name').fill('e2e_role')
  await editor().locator('#pr-pw').fill("it's secret")
  await editor().locator('#pr-pw2').fill("it's secret")
  await editor().locator('#pr-limit').fill('3')
  await editor().getByRole('tab', { name: 'Privileges' }).click()
  await editor().locator('input[aria-label="USAGE on shop"]').check()
  await editor().getByRole('button', { name: 'Apply' }).click()
  await applyReview()
  const logged = (await outputMessages(page)).find((l) => l.startsWith('CREATE ROLE')) ?? ''
  check('roles: password hidden in the output', /PASSWORD '\*{4}'/.test(logged) && !logged.includes('secret'), logged)
  check('roles: role created', psql("SELECT rolcanlogin || ',' || rolconnlimit FROM pg_roles WHERE rolname = 'e2e_role'") === 'true,3')
  check('roles: schema privilege granted', psql("SELECT has_schema_privilege('e2e_role', 'shop', 'USAGE')") === 't')
  const login = execFile('docker', ['exec', '-e', "PGPASSWORD=it's secret", 'dbm-test-postgres', 'psql', '-h', '127.0.0.1', '-U', 'e2e_role', '-d', 'postgres', '-Atc', 'SELECT current_user'])
  const loginOut = await new Promise((resolve) => {
    let out = ''
    login.stdout.on('data', (d) => (out += d))
    login.on('close', () => resolve(out.trim()))
  })
  check('roles: the password works', loginOut === 'e2e_role', loginOut)

  await editor().getByRole('tab', { name: 'Login' }).click()
  await editor().locator('#pr-name').fill('e2e_renamed')
  await editor().getByRole('tab', { name: 'Attributes' }).click()
  await editor().locator('label', { hasText: 'CREATEDB' }).locator('input').check()
  await editor().getByRole('tab', { name: 'Member Of' }).click()
  await editor().locator('label', { hasText: /^\s*pg_read_all_data\s*$/ }).locator('input').check()
  await editor().getByRole('button', { name: 'Apply' }).click()
  await applyReview()
  check('roles: changes in the database', psql("SELECT rolcreatedb || ',' || pg_has_role('e2e_renamed', 'pg_read_all_data', 'MEMBER') FROM pg_roles WHERE rolname = 'e2e_renamed'") === 'true,true')
  await shot(page, 'pg-admin-03-roles')
  // a table it owns: DROP ROLE fails and the dialog shows why
  psql('CREATE TABLE shop.owned (); ALTER TABLE shop.owned OWNER TO e2e_renamed')
  await editor().getByRole('button', { name: 'Delete' }).click()
  await review.waitFor()
  await page.waitForTimeout(300)
  await review.getByRole('button', { name: 'Apply' }).click()
  await review.locator('.error').waitFor({ timeout: 10000 })
  check('roles: drop refused while the role owns objects', /depend/.test(await review.locator('.error').innerText()), await review.locator('.error').innerText())
  await review.getByRole('button', { name: 'Cancel' }).click()
  check('roles: the failed delete was rolled back', psql("SELECT has_schema_privilege('e2e_renamed', 'shop', 'USAGE')") === 't')
  psql('DROP TABLE shop.owned')
  await editor().getByRole('button', { name: 'Refresh' }).click()
  await editor().locator('.accounts tbody tr', { hasText: 'e2e_renamed' }).dispatchEvent('mousedown')
  await page.waitForTimeout(300)
  await editor().getByRole('button', { name: 'Delete' }).click()
  await applyReview()
  check('roles: role dropped', psql("SELECT count(*) FROM pg_roles WHERE rolname LIKE 'e2e_%'") === '0')

  // --- Status and System Variables: ALTER SYSTEM on a setting --------------------------------
  await menu(app, 'server.variables')
  await editor().locator('.tab', { hasText: 'Settings' }).dispatchEvent('mousedown')
  await editor().locator('input.search').fill('work_mem')
  await page.waitForTimeout(300)
  const row = editor().locator('.grid .row', { has: page.locator('.cell', { hasText: /^work_mem$/ }) })
  await row.locator('.cell').nth(1).dblclick()
  const prompt = page.locator('[role=dialog]')
  await prompt.locator('input').fill('6MB')
  await prompt.getByRole('button', { name: 'OK' }).click()
  await page.waitForTimeout(800)
  check('variables: setting changed and reloaded', psql('SHOW work_mem') === '6MB', psql('SHOW work_mem'))
  await editor().locator('.tab', { hasText: 'Statistics' }).dispatchEvent('mousedown')
  await editor().locator('input.search').fill('xact_commit')
  await page.waitForTimeout(300)
  check('variables: statistics of the database', /database\.xact_commit/.test(await text(editor().locator('.list'))))
  await shot(page, 'pg-admin-04-variables')

  // --- Data Export and Import: self-contained file, then project folder ----------------------
  psql('ALTER TABLE shop.orders ADD CONSTRAINT orders_total_positive CHECK (total > 0)')
  const before = psql('SELECT (SELECT count(*) FROM shop.customer) || \',\' || (SELECT count(*) FROM shop.orders) || \',\' || shop.customer_count()')
  const restored = () => psql('SELECT (SELECT count(*) FROM shop.customer) || \',\' || (SELECT count(*) FROM shop.orders) || \',\' || shop.customer_count()')
  const file = join(dumps, 'shop.sql')
  const folder = join(dumps, 'project')
  // a standalone sequence: in the schema objects, with its current value
  psql("SELECT setval('shop.dbm_seq', 42)")
  const sequenceValue = () => psql("SELECT coalesce((SELECT last_value FROM shop.dbm_seq)::text, 'missing')")

  await menu(app, 'server.export')
  await editor().locator('input[aria-label="Export schema shop"]').check()
  await page.waitForTimeout(300)
  await editor().locator('label', { hasText: 'Dump Functions, Types, Sequences' }).locator('input').check()
  await editor().locator('label', { hasText: 'Include Create Schema' }).locator('input').check()
  await editor().locator('input[type=radio][value=file]').check()
  await editor().locator('input[aria-label="Self-contained file"]').fill(file)
  let outcome = await runJob('Start Export')
  check('export: file finished', !outcome.failed, `${outcome.text}\n${await text(editor().locator('.log'))}`)
  const dump = existsSync(file) ? readFileSync(file, 'utf8') : ''
  check('export: file holds tables, data, functions and triggers', /CREATE TABLE shop\.customer/.test(dump) && /COPY shop\.customer/.test(dump) && /CREATE FUNCTION shop\.customer_count/.test(dump) && /CREATE TRIGGER customer_bi/.test(dump))
  check('export: no owners', !/OWNER TO/.test(dump))
  await shot(page, 'pg-admin-05-export')

  await editor().locator('input[type=radio][value=folder]').check()
  await editor().locator('input[aria-label="Dump project folder"]').fill(folder)
  outcome = await runJob('Start Export')
  check('export: folder finished', !outcome.failed, outcome.text)
  const files = existsSync(folder) ? readdirSync(folder).sort() : []
  check('export: one file per table, post-data apart, schema objects', files.includes('shop_customer.sql') && files.includes('shop_customer.post-data.sql') && files.includes('shop_schema.sql') && files.includes('shop_v_customer_orders.sql'), files.join(','))

  psql('DROP SCHEMA shop CASCADE')
  await menu(app, 'server.import')
  await editor().locator('input[type=radio][value=file]').check()
  await editor().locator('input[aria-label="Self-contained file"]').fill(file)
  outcome = await runJob('Start Import')
  check('import: file finished', !outcome.failed, `${outcome.text}\n${await text(editor().locator('.log'))}`)
  check('import: file restored rows and functions', restored() === before, `${restored()} vs ${before}`)
  check('import: file restored the standalone sequence and its value', sequenceValue() === '42', sequenceValue())

  psql('DROP SCHEMA shop CASCADE')
  await editor().locator('input[type=radio][value=folder]').check()
  await editor().locator('input[aria-label="Dump project folder"]').fill(folder)
  outcome = await runJob('Start Import')
  check('import: folder finished', !outcome.failed, `${outcome.text}\n${await text(editor().locator('.log'))}`)
  check('import: folder restored rows and functions', restored() === before, `${restored()} vs ${before}`)
  check('import: constraints and triggers restored', psql("SELECT count(*) FROM pg_constraint WHERE conname IN ('orders_total_positive', 'fk_orders_customer')") === '2' && psql("SELECT count(*) FROM pg_trigger WHERE tgname = 'customer_bi'") === '1')
  check('import: folder restored the standalone sequence and its value', sequenceValue() === '42', sequenceValue())
  await shot(page, 'pg-admin-06-import')

  // one table with the schema objects: the standalone sequence once, the other tables' sequences not at all
  const oneTable = join(dumps, 'shop-log.sql')
  await menu(app, 'server.export')
  await editor().locator('input[aria-label="Export schema shop"]').uncheck()
  await editor().locator('tr', { has: page.locator('input[aria-label="Export schema shop"]') }).locator('td').nth(1).click()
  await editor().locator('input[aria-label="Export log_nopk"]').check()
  await editor().locator('label', { hasText: 'Dump Functions, Types, Sequences' }).locator('input').check()
  await editor().locator('input[type=radio][value=file]').check()
  await editor().locator('input[aria-label="Self-contained file"]').fill(oneTable)
  outcome = await runJob('Start Export')
  check('export: one table finished', !outcome.failed, `${outcome.text}\n${await text(editor().locator('.log'))}`)
  const oneDump = existsSync(oneTable) ? readFileSync(oneTable, 'utf8') : ''
  check(
    'export: one table holds the standalone sequence once',
    oneDump.match(/CREATE SEQUENCE shop\.dbm_seq\b/g)?.length === 1 && !/orders_id_seq|CREATE TABLE shop\.customer/.test(oneDump) && /CREATE TABLE shop\.log_nopk/.test(oneDump)
  )
  psql('DROP SCHEMA shop CASCADE')
  await menu(app, 'server.import')
  await editor().locator('input[type=radio][value=file]').check()
  await editor().locator('input[aria-label="Self-contained file"]').fill(oneTable)
  outcome = await runJob('Start Import')
  check('import: one table finished', !outcome.failed, `${outcome.text}\n${await text(editor().locator('.log'))}`)
  check('import: one table with the standalone sequence and its value', psql('SELECT count(*) FROM shop.log_nopk') === '2' && sequenceValue() === '42', sequenceValue())
  loadPostgresFixture()

  const messages = await recordedMessages(app)
  check('only the expected message boxes', messages.length === 1 && messages[0].startsWith(uiText('admin.connections.confirmKillQuery', { count: 1 })), messages.join('\n'))
  check('no renderer errors', errors.length === 0, errors.join('\n'))
} catch (e) {
  result.failures++
  console.log('FAIL exception', e.message)
  await shot(page, 'pg-admin-exception')
} finally {
  await app.close()
  psql('ALTER SYSTEM RESET work_mem')
  psql('SELECT pg_reload_conf()')
  psql('DROP ROLE IF EXISTS e2e_role, e2e_renamed')
}
console.log(result.failures ? `\n${result.failures} failure(s)` : '\nall checks passed')
process.exit(result.failures ? 1 : 0)
