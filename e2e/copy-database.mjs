// Copy Database of MySQL and MariaDB against the docker test servers (the mysqldump or
// mariadb-dump and mysql or mariadb clients must be installed locally):
//   pnpm exec electron-vite build && node e2e/copy-database.mjs
// The script loads e2e/fixture-copy.sql (schemas dbm_test_cp_a and dbm_test_cp_b) on both
// containers and drops every dbm_test_cp* schema at the start and at the end.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { answerMessages, checker, chooseFromContextMenu, connect, launch, menu, mysqlCli, profileWith, recordedMessages, servers, shot, uiText } from './lib.mjs'

const mysql = 'dbm-test-mysql'
const mariadb = 'dbm-test-mariadb'
const fixture = readFileSync(join(import.meta.dirname, 'fixture-copy.sql'), 'utf8')

function dropCopies() {
  for (const container of [mysql, mariadb]) {
    const schemas = mysqlCli(container, "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'dbm\\_test\\_cp%'")
    for (const s of schemas.split('\n').filter(Boolean)) mysqlCli(container, `DROP DATABASE IF EXISTS \`${s}\``)
  }
}

dropCopies()
mysqlCli(mysql, fixture)
mysqlCli(mariadb, fixture)
const result = checker()
const { check } = result
const scripts = mkdtempSync(join(tmpdir(), 'dbm-e2e-copy-'))

const { app, page, errors } = await launch(profileWith([servers.mysql, servers.mariadb]))
const ws = page.locator('.workspace:visible')
const editor = () => ws.locator('.editor-page:visible')
const node = (label) => ws.locator('.node', { has: page.locator('.label', { hasText: new RegExp(`^${label}$`) }) }).first()
const startButton = () => editor().getByRole('button', { name: 'Start Copy' })
const text = async (locator) => (await locator.innerText()).replace(/ /g, ' ')
/** Every job log, for the check on secrets. */
const logs = []

/** Checks the schema `source` and gives its copy the name `target`. */
async function pick(source, target) {
  const box = editor().locator(`input[aria-label="Copy schema ${source}"]`)
  if (!(await box.isChecked())) await box.check()
  await editor().locator(`input[aria-label="Target name for ${source}"]`).fill(target)
}

/** Waits for the collation preview, which follows the choices after a pause. */
const settle = () => page.waitForTimeout(1500)

/** Starts the copy and waits for its end; returns the status line, whether it shows an error, and the log. */
async function runCopy() {
  const log = editor().locator('.log')
  const before = await text(log)
  await startButton().click()
  for (const end = Date.now() + 120000; ; ) {
    const now = await text(log)
    if (now !== before && /has finished|^Error: /m.test(now)) {
      logs.push(now)
      const status = editor().locator('.status')
      return { status: await text(status), failed: await status.evaluate((e) => e.classList.contains('error')), log: now }
    }
    if (Date.now() > end) throw new Error(`copy did not end:\n${now}`)
    await page.waitForTimeout(250)
  }
}

const rows = (container, sql) => mysqlCli(container, sql)
const count = (container, table) => rows(container, `SELECT COUNT(*) FROM ${table}`)
/** Tables, routines and triggers of the schemas with their creation times, to tell whether a copy touched them. */
const fingerprint = (schemas) =>
  rows(
    mysql,
    `SELECT CONCAT_WS(' ', TABLE_SCHEMA, TABLE_NAME, CREATE_TIME) FROM information_schema.TABLES WHERE TABLE_SCHEMA IN (${schemas}) UNION ALL
     SELECT CONCAT_WS(' ', ROUTINE_SCHEMA, ROUTINE_NAME, CREATED) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA IN (${schemas}) UNION ALL
     SELECT CONCAT_WS(' ', TRIGGER_SCHEMA, TRIGGER_NAME, CREATED) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA IN (${schemas}) ORDER BY 1`
  )

/** The copy `a`+`b` of dbm_test_cp_a and dbm_test_cp_b on `container` (MySQL), compared with the source on `from`. */
function verifyCopy(label, a, b, from = mysql) {
  const tables = [
    ['dbm_test_cp_a', a, 'customer'],
    ['dbm_test_cp_a', a, 'orders'],
    ['dbm_test_cp_b', b, 'price']
  ]
  const counts = tables.map(([s, t, name]) => [count(from, `${s}.${name}`), count(mysql, `${t}.${name}`)])
  check(`${label}: row counts match`, counts.every(([x, y]) => x === y), JSON.stringify(counts))
  for (const view of ['v_price', 'w_base', 'v_total']) {
    const order = view === 'v_price' ? 'id' : 'name'
    const source = rows(from, `SELECT * FROM dbm_test_cp_a.${view} ORDER BY ${order}`)
    let copied = ''
    try {
      copied = rows(mysql, `SELECT * FROM ${a}.${view} ORDER BY ${order}`)
    } catch (e) {
      copied = e.message
    }
    check(`${label}: view ${view} answers as the source`, copied === source, `${copied} vs ${source}`)
  }
  const definition = rows(mysql, `SELECT VIEW_DEFINITION FROM information_schema.VIEWS WHERE TABLE_SCHEMA = '${a}' AND TABLE_NAME = 'v_price'`)
  check(`${label}: v_price reads ${b}`, definition.includes(`\`${b}\`.\`price\``) && !/`dbm_test_cp_[ab]`/.test(definition), definition)
  const codes = (s) => rows(s === a ? mysql : from, `SELECT GROUP_CONCAT(code ORDER BY id) FROM ${s}.customer`)
  check(`${label}: trigger did not fire on the copied rows`, codes(a) === codes('dbm_test_cp_a') && !codes(a).includes('by-trigger'), codes(a))
  check(`${label}: trigger copied`, rows(mysql, `SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = '${a}'`) === '1')
  let report = ''
  try {
    report = rows(mysql, `CALL ${a}.a_report()`)
  } catch (e) {
    report = e.message
  }
  check(`${label}: procedure calls the function defined after it`, report === count(mysql, `${a}.orders`), report)
  let fk = ''
  try {
    rows(mysql, `INSERT INTO ${a}.orders (customer_id, price_id, qty) VALUES (999, 1, 1)`)
  } catch (e) {
    fk = e.message
  }
  check(`${label}: foreign key enforced`, /foreign key constraint fails/i.test(fk), fk || 'insert accepted')
}

try {
  await answerMessages(app)
  await connect(page, servers.mysql)

  // --- 1. same instance: a + b → a2 + b2 ----------------------------------------------------
  await menu(app, 'server.copy')
  await editor().locator('.page-header', { hasText: 'Copy Database' }).waitFor()
  await pick('dbm_test_cp_a', 'dbm_test_cp_a2')
  await pick('dbm_test_cp_b', 'dbm_test_cp_b2')
  await settle()
  let outcome = await runCopy()
  check('instance: copy finished', !outcome.failed, outcome.log)
  await shot(page, 'copy-01-instance')
  verifyCopy('instance', 'dbm_test_cp_a2', 'dbm_test_cp_b2')

  // --- 3. existing targets: Stop, then Recreate its objects ---------------------------------
  rows(mysql, 'INSERT INTO dbm_test_cp_b2.price VALUES (99, 1.00); CREATE TABLE dbm_test_cp_a2.extra (id INT)')
  const targets = "'dbm_test_cp_a2', 'dbm_test_cp_b2'"
  const before = fingerprint(targets)
  outcome = await runCopy()
  check('stop: copy refused', outcome.failed && outcome.status === uiText('tools.copy.targetExists', { schemas: 'dbm_test_cp_a2, dbm_test_cp_b2' }), outcome.log)
  check('stop: targets unchanged', fingerprint(targets) === before && count(mysql, 'dbm_test_cp_b2.price') === '4')

  await editor().locator('#cd-existing').selectOption('recreate')
  await settle()
  outcome = await runCopy()
  check('recreate: copy finished', !outcome.failed, outcome.log)
  const messages = await recordedMessages(app)
  check('recreate: confirmed first', messages.some((m) => m.startsWith(uiText('admin.copy.recreateConfirm', { schemas: 'dbm_test_cp_a2, dbm_test_cp_b2' }))), messages.join('\n'))
  check('recreate: objects found only in the target kept', rows(mysql, "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'dbm_test_cp_a2' AND TABLE_NAME = 'extra'") === '1')
  verifyCopy('recreate', 'dbm_test_cp_a2', 'dbm_test_cp_b2')
  await shot(page, 'copy-02-recreate')

  // --- 4. script file, structure only, imported into new schemas ---------------------------
  const file = join(scripts, 'copy.sql')
  await editor().locator('#cd-existing').selectOption('stop')
  await editor().locator('label', { hasText: 'Copy to SQL Script File' }).locator('input').check()
  await editor().locator('input[aria-label="Script file"]').fill(file)
  await editor().locator('select[aria-label="Copy content"]').selectOption({ label: 'Copy Structure Only' })
  await pick('dbm_test_cp_a', 'dbm_test_cp_a4')
  await pick('dbm_test_cp_b', 'dbm_test_cp_b4')
  await settle()
  outcome = await runCopy()
  check('file: script written', !outcome.failed, outcome.log)
  let imported = ''
  try {
    mysqlCli(mysql, readFileSync(file, 'utf8'))
  } catch (e) {
    imported = e.message
  }
  check('file: script imported', !imported, imported)
  const views = rows(mysql, "SELECT GROUP_CONCAT(TABLE_NAME ORDER BY TABLE_NAME) FROM information_schema.VIEWS WHERE TABLE_SCHEMA = 'dbm_test_cp_a4'")
  check('file: every view created', views === 'v_price,v_total,w_base', views)
  check('file: views answer, tables empty', rows(mysql, 'SELECT COUNT(*) FROM dbm_test_cp_a4.v_total') === '0' && count(mysql, 'dbm_test_cp_a4.customer') === '0')
  await shot(page, 'copy-03-file')

  // --- 2. MariaDB → MySQL, another connection, a missing collation ------------------------
  await page.locator('.mtab.home').dispatchEvent('mousedown')
  await connect(page, servers.mariadb)
  await chooseFromContextMenu(app, 'copy-database')
  await node('dbm_test_cp_a').dispatchEvent('contextmenu')
  await editor().locator('.page-header', { hasText: 'Copy Database' }).waitFor()
  check('connection: schema of the context menu checked', await editor().locator('input[aria-label="Copy schema dbm_test_cp_a"]').isChecked())
  await editor().locator('label', { hasText: 'Copy to Another Connection' }).locator('input').check()
  await pick('dbm_test_cp_a', 'dbm_test_cp_ma')
  await pick('dbm_test_cp_b', 'dbm_test_cp_mb')
  await editor().locator('select[aria-label="Target connection"]').selectOption({ label: servers.mysql.name })
  await page.locator('[role=dialog] input[type=password]').fill('test')
  await page.keyboard.press('Enter')
  const uca = editor().locator('select[aria-label="Replacement for utf8mb4_uca1400_ai_ci"]')
  await uca.waitFor()
  await settle()
  const missing = editor().locator('tr.missing')
  check(
    'connection: missing uca1400 collation highlighted and required, Start Copy disabled until mapped',
    (await missing.filter({ hasText: 'utf8mb4_uca1400_ai_ci' }).count()) === 1 && (await uca.getAttribute('aria-invalid')) === 'true' && (await startButton().isDisabled()),
    await text(editor().locator('.collations'))
  )
  await shot(page, 'copy-04-collations')
  // the target's default collation of the charset, for every missing one
  for (const select of await editor().locator('tr.missing select').all()) await select.selectOption({ index: 1 })
  const chosen = await uca.inputValue()
  await settle()
  outcome = await runCopy()
  check('connection: copy finished', !outcome.failed, outcome.log)
  verifyCopy('mariadb → mysql', 'dbm_test_cp_ma', 'dbm_test_cp_mb', mariadb)
  const collation = rows(mysql, "SELECT TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'dbm_test_cp_mb' AND TABLE_NAME = 'label'")
  check('connection: table has the chosen collation', !!chosen && collation === chosen, `${collation} vs ${chosen}`)
  check('connection: rows of the table copied', count(mysql, 'dbm_test_cp_mb.label') === '2')
  await shot(page, 'copy-05-connection')

  // --- 5. secrets ---------------------------------------------------------------------------
  const all = logs.join('\n')
  check('log: no password', !/\btest\b/.test(all) && !/password/i.test(all), all)
  check('log: no option file path', !/client\.cnf|--defaults-file=[^…]/.test(all), all)

  const boxes = await recordedMessages(app)
  check('only the expected message boxes', boxes.length === 1, boxes.join('\n'))
  check('no renderer errors', errors.length === 0, errors.join('\n'))
} catch (e) {
  result.failures++
  console.log('FAIL exception', e.message)
  await shot(page, 'copy-exception')
} finally {
  await app.close()
  dropCopies()
}
console.log(result.failures ? `\n${result.failures} failure(s)` : '\nall checks passed')
process.exit(result.failures ? 1 : 0)
