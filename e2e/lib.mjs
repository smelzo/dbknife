// Helpers to drive the built app with Playwright against the docker test servers
// (see e2e/fixture.sql): MySQL 8.4 on 127.0.0.1:33061, MariaDB 11.4 on 127.0.0.1:33062;
// SQL Server runs on the host named by DBM_MSSQL_HOST, port 1433 (see tcpRelay, loadMssqlFixture).
import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, connect as tcpConnect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
export const outDir = join(root, 'e2e/output')
mkdirSync(outDir, { recursive: true })

const english = JSON.parse(readFileSync(join(root, 'src/shared/i18n/en_US.json'), 'utf8')).messages
const englishPlurals = new Intl.PluralRules('en')

/**
 * English text of an i18n key with its parameters, as the app shows it (launch() forces
 * en_US): checks name the message they expect, so rewording it does not break them and a
 * removed key fails here. Same placeholder and plural rules as src/shared/i18n.
 */
export function uiText(key, params = {}) {
  const message = english[key]
  if (message === undefined) throw new Error(`unknown i18n key: ${key}`)
  const form = typeof message === 'string' ? message : (message[englishPlurals.select(Number(params.count))] ?? message.other)
  return form.replace(/\{(\w+)\}/g, (match, name) => (Object.hasOwn(params, name) ? String(params[name]) : match))
}

/** uiText(key, params) as a RegExp of the whole message, each placeholder not given matching any text. */
export const uiPattern = (key, params = {}) =>
  new RegExp(`^${uiText(key, params).replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{\w+\}/g, '.+')}$`)

const conn = (id, name, port) => ({
  id,
  name,
  method: 'tcp',
  host: '127.0.0.1',
  port,
  socket: '',
  user: 'root',
  defaultSchema: 'shop',
  ssl: { mode: 'preferred', ca: '', cert: '', key: '', cipher: '' },
  ssh: { host: '', port: 22, user: '', keyFile: '' },
  options: { compress: false, connectTimeout: 10, sqlMode: '', others: '' }
})

/** SQL Server test host and its login (sysadmin), see loadMssqlFixture(). */
const mssqlHost = process.env.DBM_MSSQL_HOST
const mssqlLogin = { user: 'dbm_test', password: 'test' }

/**
 * A loopback port of this process relayed to `host:port`; resolves with the port.
 * macOS "Local Network" privacy keeps Electron away from LAN hosts (EHOSTUNREACH) until
 * someone allows it in a system prompt, which nobody answers on the e2e machine; the test
 * process itself may reach them, so the app connects to the relay instead. The host is
 * reached only when the app connects, and the relay ends with the script: it does not
 * keep the process alive.
 */
export async function tcpRelay(host, port) {
  const relay = createServer((client) => {
    const upstream = tcpConnect(port, host)
    client.pipe(upstream).pipe(client)
    client.on('error', () => upstream.destroy())
    upstream.on('error', () => client.destroy())
  })
  await new Promise((ok) => relay.listen(0, '127.0.0.1', ok))
  relay.unref()
  return relay.address().port
}

export const servers = {
  mysql: conn('test-mysql', 'Test/MySQL 8.4', 33061),
  mariadb: conn('test-mariadb', 'Test/MariaDB 11.4', 33062),
  // the VM through a relay
  mssql: { ...conn('test-mssql', 'Test/SQL Server 2019', await tcpRelay(mssqlHost, 1433)), engine: 'mssql', user: mssqlLogin.user, database: 'dbm_test', defaultSchema: '', file: '' }
}

/**
 * servers.mssql bound to another dbm_test* database, so that scripts loading
 * their own copy of the fixture (loadMssqlFixture) can run in parallel.
 */
export const mssqlServer = (database = 'dbm_test') =>
  database === 'dbm_test' ? servers.mssql : { ...servers.mssql, id: `test-mssql-${database}`, name: `Test/SQL Server (${database})`, database }

/** MySQL 8.4 reached through the dbm-test-ssh container (sshd on 127.0.0.1:32222, root/test). */
export const sshServer = {
  ...conn('test-ssh', 'Test/MySQL via SSH', 3306),
  method: 'ssh',
  host: 'dbm-test-mysql',
  ssh: { host: '127.0.0.1:32222', port: 22, user: 'root', keyFile: '' }
}

export async function launch(existingUserData) {
  const userData = existingUserData ?? mkdtempSync(join(tmpdir(), 'dbm-e2e-'))
  if (!existingUserData) writeFileSync(join(userData, 'connections.json'), JSON.stringify([...Object.values(servers), sshServer]))
  // English whatever the system language, since an Italian pack is built in: the tests find elements by their English text
  const settings = join(userData, 'settings.json')
  if (!existsSync(settings)) writeFileSync(settings, JSON.stringify({ language: 'en_US' }))
  const app = await electron.launch({
    // DBM_OUT lets parallel builds (electron-vite build --outDir X) be tested side by side
    args: [join(root, process.env.DBM_OUT ?? 'out', 'main/index.js')],
    env: { ...process.env, DBM_USER_DATA: userData, DBM_TEST_HIDDEN: process.env.DBM_TEST_VISIBLE ? '' : '1' },
    cwd: root
  })
  const page = await app.firstWindow()
  await page.waitForSelector('.home-screen')
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  return { app, page, userData, errors }
}

export const shot = (page, name) => page.screenshot({ path: join(outDir, `${name}.png`) })

/** Opens a connection from the home screen, answering the password prompt. */
export async function connect(page, server) {
  await page.locator('.home-screen').waitFor()
  const tile = page.locator('.tile', { hasText: server.name.split('/')[1] })
  if (!(await tile.count())) await page.locator('.tile.folder', { hasText: 'Test' }).click()
  await tile.dblclick()
  await page.locator('input[type=password]').fill('test')
  await page.keyboard.press('Enter')
  await page.locator('.workspace').last().waitFor()
  await page.locator('.workspace:visible .editor-page:visible .monaco-editor').first().waitFor()
}

/** Replaces the active query editor content and runs it with the given shortcut. */
export async function runSql(page, sql, shortcut = 'Meta+Shift+Enter') {
  const ed = page.locator('.workspace:visible .editor-page:visible .monaco-editor').first()
  await ed.click()
  await page.keyboard.press('Meta+A')
  await page.keyboard.press('Backspace')
  await page.keyboard.insertText(sql)
  await page.keyboard.press(shortcut)
  await page.waitForFunction(() => !document.querySelector('.workspace:not([style*="display: none"]) .running'))
  await page.waitForTimeout(200)
}

export const outputMessages = (page) =>
  page.locator('.workspace:visible .output tbody tr').evaluateAll((rows) =>
    rows.map((r) => [...r.querySelectorAll('td')].slice(3).map((td) => td.textContent.trim()).join(' | '))
  )

/**
 * The Output lines of outputMessages() with the status icon of each ('ok', 'err', 'warn', 'run'
 * or ''): a check reads whether a statement failed from the status, not from the wording.
 */
export const outputEntries = (page) =>
  page.locator('.workspace:visible .output tbody tr').evaluateAll((rows) =>
    rows.map((r) => ({
      text: [...r.querySelectorAll('td')].slice(3).map((td) => td.textContent.trim()).join(' | '),
      status: ['ok', 'err', 'warn', 'run'].find((c) => r.querySelector(`td.st .${c}`)) ?? ''
    }))
  )

/** True when the last Output line has the success icon: the last statement ran without error. */
export const lastOutputOk = async (page) => (await outputEntries(page)).at(-1)?.status === 'ok'

/**
 * Safe Updates, on by default: an UPDATE of `table` (the fixture's orders, ids 1-3) without WHERE
 * is refused with an error line in the Output and changes no row; with a WHERE it runs.
 * `statuses()` reads the order statuses by id, comma separated, outside the app.
 */
export async function checkSafeUpdates(page, check, table, statuses) {
  const before = await statuses()
  const refused = `UPDATE ${table} SET status = 'shipped'`
  await runSql(page, refused)
  let line = (await outputMessages(page)).at(-1) ?? ''
  check('Safe Updates refuses UPDATE without WHERE', line.startsWith(`${refused} | `) && line.includes(uiText('main.session.safeUpdates')), line)
  check('refused UPDATE leaves the rows unchanged', (await statuses()) === before, `${before} -> ${await statuses()}`)
  await runSql(page, `UPDATE ${table} SET status = 'paid' WHERE id = 2`)
  line = (await outputMessages(page)).at(-1) ?? ''
  const expected = before.split(',').map((s, i) => (i === 1 ? 'paid' : s)).join(',')
  check('UPDATE with WHERE runs', (await statuses()) === expected, `${line}\n${before} -> ${await statuses()}`)
}

/** Sends a native menu command, as clicking the menu item does. */
export const menu = (app, command) =>
  app.evaluate(({ BrowserWindow }, c) => BrowserWindow.getAllWindows()[0].webContents.send('menu-command', c, false), command)

export const editorText = (page) =>
  page.locator('.workspace:visible .editor-page:visible .view-lines').first().innerText().then((t) => t.replace(/\u00a0/g, ' '))

/** SQLite connection; `file` is set by sqliteFixture(). */
/** Replaces the active editor content with `text` and returns the completion labels offered at its end. */
export async function suggestions(page, text) {
  const ed = page.locator('.workspace:visible .editor-page:visible .monaco-editor').first()
  await ed.click()
  await page.keyboard.press('Meta+A')
  await page.keyboard.press('Backspace')
  await page.keyboard.insertText(text)
  await page.keyboard.press('Control+Space')
  await page.locator('.suggest-widget.visible').waitFor()
  await page.waitForTimeout(300)
  const labels = await page.locator('.suggest-widget .monaco-list-row .label-name').allInnerTexts()
  await page.keyboard.press('Escape')
  return labels
}

export const sqliteServer = { ...conn('test-sqlite', 'Test/SQLite', 0), engine: 'sqlite', file: '', defaultSchema: '' }

/**
 * Builds a disposable SQLite database from e2e/fixture-sqlite.sql and a profile
 * whose only connection opens it: pass `userData` to launch().
 */
export async function sqliteFixture() {
  const { DatabaseSync } = await import('node:sqlite')
  const { readFileSync } = await import('node:fs')
  const userData = mkdtempSync(join(tmpdir(), 'dbm-e2e-'))
  const file = join(userData, 'shop.sqlite')
  const db = new DatabaseSync(file)
  db.exec(readFileSync(join(root, 'e2e/fixture-sqlite.sql'), 'utf8'))
  db.close()
  const server = { ...sqliteServer, file }
  writeFileSync(join(userData, 'connections.json'), JSON.stringify([server]))
  return { userData, file, server }
}

/** Opens a connection that asks for no password (SQLite) from the home screen. */
export async function connectWithoutPassword(page, server) {
  await page.locator('.home-screen').waitFor()
  const tile = page.locator('.tile', { hasText: server.name.split('/')[1] })
  if (!(await tile.count())) await page.locator('.tile.folder', { hasText: server.name.split('/')[0] }).click()
  await tile.dblclick()
  await page.locator('.workspace').last().waitFor()
  await page.locator('.workspace:visible .editor-page:visible .monaco-editor').first().waitFor()
}

/** PostgreSQL 17 in the dbm-test-postgres container (127.0.0.1:33063, postgres/test, e2e/fixture-postgres.sql). */
export const pgServer = { ...conn('test-postgres', 'Test/PostgreSQL 17', 33063), engine: 'postgres', user: 'postgres', database: 'postgres', file: '' }

/** A throw-away profile with only the given connections, to pass to launch(). */
export function profileWith(connections) {
  const userData = mkdtempSync(join(tmpdir(), 'dbm-e2e-'))
  writeFileSync(join(userData, 'connections.json'), JSON.stringify(connections))
  return userData
}

/** PASS/FAIL lines and the failure count of a script. */
export function checker() {
  const state = { failures: 0 }
  state.check = (label, ok, detail = '') => {
    if (!ok) state.failures++
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` — ${detail}`}`)
  }
  return state
}

/** Makes the next navigator context menus answer `choice` instead of opening the native menu. */
export const chooseFromContextMenu = (app, choice) =>
  app.evaluate(({ ipcMain }, c) => {
    ipcMain.removeHandler('ui:contextMenu')
    ipcMain.handle('ui:contextMenu', () => c)
  }, choice)

/**
 * "Import Data from File…" on the navigator node of a table, with `file` as the file chosen: imports it with the
 * mapping proposed by the dialog. Returns the dialog's error, '' when the import succeeded and closed it.
 */
export async function importFile(app, page, tableNode, file) {
  await app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] })
  }, file)
  await chooseFromContextMenu(app, 'import-file')
  await tableNode.dispatchEvent('contextmenu')
  const dialog = page.locator('[role=dialog]')
  await dialog.getByRole('button', { name: 'Choose File…' }).click()
  await dialog.locator('#if-header').waitFor()
  await dialog.locator('#if-col-0').waitFor()
  await dialog.locator('button.primary').click()
  await page.waitForFunction(() => !document.querySelector('[role=dialog]') || document.querySelector('[role=dialog] p.error'), null, { timeout: 30000 })
  const error = dialog.locator('p.error')
  if (!(await error.count())) return ''
  const message = (await error.innerText()) || '(empty error)'
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
  return message
}

/**
 * Import of a CSV file into the fixture's tables (plan, Phase 6), files written in `dir`:
 * - 501 orders, the last one breaking the status CHECK: two INSERTs, the first one rolled back, the error in the dialog;
 * - 3 customers under a header of column names: 3 more rows holding the file's values;
 * - values like +39123456 and 1.10 into a text column: kept as the file's text;
 * - a customer with the id of an existing one: the key the server fills is skipped, the row gets a new id.
 * The failed import runs first: a transaction it left open would make the second one fail or commit its rows.
 * `query(sql)` reads the database outside the app: rows joined by \n, columns by |.
 */
export async function checkImportFile(app, page, check, { dir, customerNode, ordersNode, query }) {
  const count = (table) => Number(query(`SELECT COUNT(*) FROM ${table}`))
  const orders = join(dir, 'import-orders.csv')
  writeFileSync(orders, ['customer_id,total,status', ...Array(500).fill('1,1.5,new'), '1,1.5,bogus', ''].join('\n'))
  const ordersBefore = count('orders')
  const error = await importFile(app, page, ordersNode, orders)
  check('failed import shows the error in the dialog', /check constraint/i.test(error), error)
  check('failed import of 501 rows leaves no row', count('orders') === ordersBefore, `${ordersBefore} -> ${count('orders')}`)

  const customers = join(dir, 'import-customers.csv')
  writeFileSync(
    customers,
    'name,email,balance,notes,active\nErin,erin@example.com,12.5,"a, b",true\nFrank,frank@example.com,0,"say ""hi""",false\nGina,gina@example.com,7,plain,true\n'
  )
  const before = count('customer')
  const failed = await importFile(app, page, customerNode, customers)
  check('CSV import closes the dialog', failed === '', failed)
  check('CSV import adds its 3 rows', count('customer') === before + 3, `${before} -> ${count('customer')}`)
  const imported = query(
    "SELECT name || '|' || email || '|' || CAST(balance * 100 AS integer) || '|' || notes || '|' || CASE WHEN active THEN 1 ELSE 0 END FROM customer WHERE email IN ('erin@example.com', 'frank@example.com', 'gina@example.com') ORDER BY id"
  )
  check('CSV import stores the values of the file', imported === 'Erin|erin@example.com|1250|a, b|1\nFrank|frank@example.com|0|say "hi"|0\nGina|gina@example.com|700|plain|1', imported)
  check('no row of the failed import committed afterwards', count('orders') === ordersBefore, `${ordersBefore} -> ${count('orders')}`)

  // the CSV values a spreadsheet reader would type (number, boolean) stay the file's text in a text column
  const texts = ['+39123456', '1.10', '1e3', 'TRUE']
  const textual = join(dir, 'import-texts.csv')
  writeFileSync(textual, ['name,email,notes', ...texts.map((v, i) => `Text${i},text${i}@example.com,${v}`), ''].join('\n'))
  const textFailed = await importFile(app, page, customerNode, textual)
  check('CSV import of text values closes the dialog', textFailed === '', textFailed)
  const notes = query("SELECT notes FROM customer WHERE email LIKE 'text_@example.com' ORDER BY email")
  check('CSV import keeps the exact text in a text column', notes === texts.join('\n'), notes)

  // the file's id of an existing row: the key column the server fills is skipped, the row gets a new id
  const ids = join(dir, 'import-ids.csv')
  writeFileSync(ids, 'id,name,email\n1,Ivo,ivo@example.com\n')
  const idsBefore = count('customer')
  const idsFailed = await importFile(app, page, customerNode, ids)
  check('CSV import with an existing id closes the dialog', idsFailed === '', idsFailed)
  check('CSV import with an existing id adds its row', count('customer') === idsBefore + 1, `${idsBefore} -> ${count('customer')}`)
  const newId = query("SELECT id FROM customer WHERE email = 'ivo@example.com'")
  const ones = query('SELECT COUNT(*) FROM customer WHERE id = 1')
  check('CSV import gives the row a new id, not the file one', newId !== '' && newId !== '1' && ones === '1', `id ${newId}, rows with id 1: ${ones}`)
}

/** Answers native message boxes with their first button, recording them in globalThis.dbmMessages of the main process. */
export const answerMessages = (app) =>
  app.evaluate(({ ipcMain }) => {
    globalThis.dbmMessages = []
    ipcMain.removeHandler('ui:message')
    ipcMain.handle('ui:message', (_e, o) => {
      globalThis.dbmMessages.push(`${o.message}${o.detail ? ` — ${o.detail}` : ''}`)
      return 0
    })
  })

export const recordedMessages = (app) => app.evaluate(() => globalThis.dbmMessages ?? [])

/** psql in the dbm-test-postgres container; returns the unaligned output. */
export const psql = (sql) =>
  execFileSync('docker', ['exec', '-i', 'dbm-test-postgres', 'psql', '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qAt', '-c', sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()

/** Reloads e2e/fixture-postgres.sql (schema "shop"). */
export const loadPostgresFixture = () =>
  execFileSync('docker', ['exec', '-i', 'dbm-test-postgres', 'psql', '-U', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1'], {
    input: readFileSync(join(root, 'e2e/fixture-postgres.sql')),
    stdio: ['pipe', 'ignore', 'ignore']
  })

const mysqlTestSchema = (schema) => {
  // the containers also hold the shop fixture of the other scripts
  if (!/^dbm_test\w*$/.test(schema)) throw new Error(`not a test database: ${schema}`)
  return schema
}

/**
 * Runs `sql` with the command-line client of a docker test server (dbm-test-mysql or
 * dbm-test-mariadb) as root, `database` as the default one; returns the tab-separated rows.
 * Only dbm_test* schemas may be the default, created, dropped or used.
 */
export function mysqlCli(container, sql, database) {
  if (database) mysqlTestSchema(database)
  const statements = /^\s*(?:(?:CREATE|ALTER|DROP)\s+(?:DATABASE|SCHEMA)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?|USE\s+)`?(\w+)/gim
  for (const m of sql.matchAll(statements)) mysqlTestSchema(m[1])
  const client = container === 'dbm-test-mariadb' ? 'mariadb' : 'mysql'
  return execFileSync('docker', ['exec', '-i', container, client, '-uroot', '-ptest', '-N', '-B', ...(database ? [database] : [])], {
    input: sql,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim()
}

const mssqlDatabase = (database) => {
  // the VM also holds databases that the tests must not touch
  if (!/^dbm_test\w*$/.test(database)) throw new Error(`not a test database: ${database}`)
  return database
}

/** Runs `fn(run)` on a tedious connection to the test VM; run(sql) resolves with the rows (objects by column name) of the batch. */
async function withMssql(database, fn) {
  if (!mssqlHost) throw new Error('DBM_MSSQL_HOST: set it to the SQL Server test host')
  const tedious = await import('tedious')
  const { Connection, Request } = tedious.default ?? tedious
  const c = new Connection({
    server: mssqlHost,
    authentication: { type: 'default', options: { userName: mssqlLogin.user, password: mssqlLogin.password } },
    options: { port: 1433, database, encrypt: true, trustServerCertificate: true, connectTimeout: 10000, requestTimeout: 60000 }
  })
  await new Promise((ok, ko) => {
    c.on('error', () => undefined)
    c.connect((e) => (e ? ko(e) : ok()))
  })
  const run = (sql) =>
    new Promise((ok, ko) => {
      const rows = []
      const r = new Request(sql, (e) => (e ? ko(new Error(`${e.message}\n${sql.slice(0, 200)}`)) : ok(rows)))
      r.on('row', (cols) => rows.push(Object.fromEntries(cols.map((col) => [col.metadata.colName, col.value]))))
      c.execSqlBatch(r)
    })
  try {
    return await fn(run)
  } finally {
    await new Promise((ok) => {
      c.on('end', ok)
      c.close()
    })
  }
}

/**
 * (Re)creates `database` on the SQL Server VM from e2e/fixture-mssql.sql, logging in
 * as dbm_test/test: the fixture's dbm_test is replaced by `database` and its GO
 * batches are sent one by one. Each script uses its own dbm_test* database.
 */
export const loadMssqlFixture = (database = 'dbm_test') => {
  const sql = readFileSync(join(root, 'e2e/fixture-mssql.sql'), 'utf8').replace(/\bdbm_test\b/g, mssqlDatabase(database))
  const batches = sql.split(/^[ \t]*GO[ \t]*$/im).filter((b) => b.trim())
  return withMssql('master', async (run) => {
    for (const batch of batches) await run(batch)
  })
}

/** Rows of a T-SQL batch run on `database` of the test VM (for checks outside the app). */
export const mssqlQuery = (sql, database = 'dbm_test') => withMssql(mssqlDatabase(database), (run) => run(sql))
