// Users and Privileges of SQL Server, against the test VM (database dbm_test_usr):
//   pnpm exec electron-vite build && node e2e/mssql-users.mjs
// Creates the login dbm_e2e_login with its user and the user without login
// dbm_e2e_nologin, checks what they can do by logging in with tedious, and
// drops them at the end, also when a check fails.
import tedious from 'tedious'
import { answerMessages, checker, connect, launch, loadMssqlFixture, menu, mssqlQuery, mssqlServer, outputMessages, profileWith, recordedMessages, shot, uiText } from './lib.mjs'

const database = 'dbm_test_usr'
const server = mssqlServer(database)
const firstPassword = "E2e it's Secret 1!"
const secondPassword = 'E2e Changed 2?'

// principals of this script only: other scripts may create their own dbm_e2e_* logins on the same server
const dropPrincipals = () =>
  mssqlQuery(
    `DECLARE @sql nvarchar(max) = N'';
     SELECT @sql += N'DROP USER ' + QUOTENAME(name) + N'; ' FROM sys.database_principals WHERE name IN (N'dbm_e2e_login', N'dbm_e2e_nologin');
     SELECT @sql += N'DROP LOGIN ' + QUOTENAME(name) + N'; ' FROM sys.server_principals WHERE name = N'dbm_e2e_login';
     EXEC (@sql);`,
    database
  )

/** Logs in as dbm_e2e_login without naming a database (its default one is used) and runs `sql`; resolves with its rows, or the error message. */
function asLogin(password, sql) {
  const { Connection, Request } = tedious
  const c = new Connection({
    server: server.host,
    authentication: { type: 'default', options: { userName: 'dbm_e2e_login', password } },
    options: { port: server.port, encrypt: true, trustServerCertificate: true, connectTimeout: 10000 }
  })
  return new Promise((resolve) => {
    c.on('error', () => undefined)
    c.connect((e) => {
      if (e) return resolve(e.message)
      const rows = []
      const r = new Request(sql, (err) => {
        c.close()
        resolve(err ? err.message : rows)
      })
      r.on('row', (cols) => rows.push(Object.fromEntries(cols.map((col) => [col.metadata.colName, col.value]))))
      c.execSqlBatch(r)
    })
  })
}

const loginRow = async () =>
  (
    await mssqlQuery(
      `SELECT p.default_database_name AS db, l.is_policy_checked AS policy,
              (SELECT COUNT(*) FROM sys.server_role_members m JOIN sys.server_principals r ON r.principal_id = m.role_principal_id
               WHERE m.member_principal_id = p.principal_id AND r.name = N'bulkadmin') AS bulkadmin
       FROM sys.server_principals p JOIN sys.sql_logins l ON l.principal_id = p.principal_id WHERE p.name = N'dbm_e2e_login'`,
      database
    )
  )[0]

const schemaPermissions = async () =>
  (
    await mssqlQuery(
      `SELECT pe.permission_name + ':' + pe.state_desc AS p FROM sys.database_permissions pe
       JOIN sys.database_principals u ON u.principal_id = pe.grantee_principal_id
       WHERE u.name = N'dbm_e2e_login' AND pe.class = 3 AND pe.major_id = SCHEMA_ID(N'shop')`,
      database
    )
  )
    .map((r) => r.p)
    .join(',')

await loadMssqlFixture(database)
await dropPrincipals()
const result = checker()
const { check } = result

const { app, page, errors } = await launch(profileWith([server]))
const ws = page.locator('.workspace:visible')
const editor = () => ws.locator('.editor-page:visible')
const review = page.locator('[role=dialog]')
const text = async (locator) => (await locator.innerText()).replace(/ /g, ' ')

async function applyReview() {
  await review.waitFor()
  await page.waitForTimeout(300)
  const script = (await text(review.locator('.view-lines'))).replace(/\s+/g, ' ')
  await review.getByRole('button', { name: 'Apply' }).click()
  await review.waitFor({ state: 'detached', timeout: 15000 })
  await page.waitForTimeout(500)
  return script
}

const tab = (name) => editor().getByRole('tab', { name }).click()
const row = (name) => editor().locator('.accounts tbody tr', { hasText: name }).first()

try {
  await answerMessages(app)
  await connect(page, server)
  await menu(app, 'server.users')
  await row('dbm_test').waitFor()
  const list = await text(editor().locator('.accounts tbody'))
  check('users: logins listed with their type', new RegExp(`dbm_test\\s+${uiText('admin.logins.kindSql')}`).test(list) && list.includes(uiText('admin.logins.kindWindows')) && !/##MS_/.test(list), list.slice(0, 400))

  // --- a SQL login with its user in the database, reading through db_datareader -------------
  await editor().getByRole('button', { name: 'Add Login' }).click()
  await editor().locator('#ml-name').fill('dbm_e2e_login')
  await editor().locator('#ml-pw').fill(firstPassword)
  await editor().locator('#ml-pw2').fill(firstPassword)
  await editor().locator('#ml-db').selectOption(database)
  await tab('Database')
  await editor().locator('fieldset.roles label', { hasText: /^\s*db_datareader\s*$/ }).locator('input').check()
  await editor().getByRole('button', { name: 'Apply' }).click()
  await applyReview()
  const logged = (await outputMessages(page)).find((l) => l.startsWith('CREATE LOGIN')) ?? ''
  check('users: password hidden in the output', /PASSWORD = N'\*{4}'/.test(logged) && !logged.includes('Secret'), logged)
  let rows = await asLogin(firstPassword, 'SELECT SUSER_SNAME() AS who, DB_NAME() AS db, (SELECT COUNT(*) FROM shop.customer) AS n')
  check('users: the login connects to its default database and reads', rows[0]?.who === 'dbm_e2e_login' && rows[0]?.db === database && rows[0]?.n > 0, JSON.stringify(rows))
  check('users: the page shows the new login', (await editor().locator('.section-title', { hasText: uiText('admin.logins.details', { name: 'dbm_e2e_login' }) }).count()) === 1)

  // --- new password and a server role -----------------------------------------------------------
  await tab('Login')
  await editor().locator('#ml-pw').fill(secondPassword)
  await editor().locator('#ml-pw2').fill(secondPassword)
  await tab('Server Roles')
  await editor().locator('.members label', { hasText: /^\s*bulkadmin\s*$/ }).locator('input').check()
  await editor().getByRole('button', { name: 'Apply' }).click()
  await applyReview()
  check('users: server role added', (await loginRow())?.bulkadmin === 1, JSON.stringify(await loginRow()))
  rows = await asLogin(firstPassword, 'SELECT 1 AS one')
  check('users: the old password is refused', typeof rows === 'string' && /dbm_e2e_login/.test(rows), JSON.stringify(rows))
  rows = await asLogin(secondPassword, 'SELECT 1 AS one')
  check('users: the new password works', rows[0]?.one === 1, JSON.stringify(rows))

  // --- SELECT on schema shop instead of db_datareader, then revoked ---------------------------
  await tab('Database')
  await editor().locator('fieldset.roles label', { hasText: /^\s*db_datareader\s*$/ }).locator('input').uncheck()
  await tab('Permissions')
  await editor().locator('select[aria-label="SELECT on shop"]').selectOption('GRANT')
  await editor().getByRole('button', { name: 'Apply' }).click()
  await applyReview()
  check('users: permission stored', (await schemaPermissions()) === 'SELECT:GRANT', await schemaPermissions())
  rows = await asLogin(secondPassword, 'SELECT COUNT(*) AS n FROM shop.customer')
  check('users: reads the granted schema', rows[0]?.n > 0, JSON.stringify(rows))
  rows = await asLogin(secondPassword, 'SELECT COUNT(*) AS n FROM dbo.type_samples')
  check('users: other schemas are closed without db_datareader', typeof rows === 'string' && /SELECT/.test(rows), JSON.stringify(rows))
  await shot(page, 'mssql-users-01-permissions')

  await tab('Permissions')
  await editor().locator('select[aria-label="SELECT on shop"]').selectOption('')
  await editor().getByRole('button', { name: 'Apply' }).click()
  let script = await applyReview()
  check('users: revoke on the schema', /REVOKE SELECT ON SCHEMA::\[shop\] FROM \[dbm_e2e_login\]/.test(script), script)
  rows = await asLogin(secondPassword, 'SELECT COUNT(*) AS n FROM shop.customer')
  check('users: the revoked schema is closed', typeof rows === 'string' && /SELECT/.test(rows), JSON.stringify(rows))

  // --- a user without login ---------------------------------------------------------------------
  await editor().getByRole('button', { name: 'Add User' }).click()
  await editor().locator('#ml-user').fill('dbm_e2e_nologin')
  await editor().getByRole('button', { name: 'Apply' }).click()
  await applyReview()
  rows = await mssqlQuery("SELECT authentication_type_desc AS a FROM sys.database_principals WHERE name = N'dbm_e2e_nologin'", database)
  check('users: it has no authentication', rows[0]?.a === 'NONE', JSON.stringify(rows))
  check('users: listed as a user without login', new RegExp(`dbm_e2e_nologin\\s+${uiText('admin.logins.kindUser')}`).test(await text(editor().locator('.accounts tbody'))))
  await editor().getByRole('button', { name: 'Delete' }).click()
  script = await applyReview()
  check('users: user without login dropped', /^DROP USER \[dbm_e2e_nologin\](;| GO)$/.test(script.trim()) && (await mssqlQuery("SELECT COUNT(*) AS n FROM sys.database_principals WHERE name = N'dbm_e2e_nologin'", database))[0].n === 0, script)

  // --- drop the login together with its user ---------------------------------------------------
  await row('dbm_e2e_login').dispatchEvent('mousedown')
  await editor().locator('.section-title', { hasText: 'Details for login dbm_e2e_login' }).waitFor()
  await editor().getByRole('button', { name: 'Delete' }).click()
  const prompt = page.locator('[role=dialog]', { hasText: 'Also delete its user dbm_e2e_login' })
  await prompt.waitFor()
  await prompt.getByRole('button', { name: 'Delete' }).click()
  await applyReview()
  rows = await mssqlQuery(
    "SELECT (SELECT COUNT(*) FROM sys.server_principals WHERE name = N'dbm_e2e_login') + (SELECT COUNT(*) FROM sys.database_principals WHERE name = N'dbm_e2e_login') AS n",
    database
  )
  check('users: login and user gone', rows[0].n === 0, JSON.stringify(rows))

  const messages = await recordedMessages(app)
  check('no message boxes', messages.length === 0, messages.join('\n'))
  check('no renderer errors', errors.length === 0, errors.join('\n'))
} catch (e) {
  result.failures++
  console.log('FAIL exception', e.message)
  await shot(page, 'mssql-users-exception')
} finally {
  await app.close()
  await dropPrincipals()
}
console.log(result.failures ? `\n${result.failures} failure(s)` : '\nall checks passed')
process.exit(result.failures ? 1 : 0)
