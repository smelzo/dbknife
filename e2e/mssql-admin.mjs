// Administration pages and data export/import of SQL Server, against the test VM
// (database dbm_test_adm; sqlpackage must be installed, e.g. in ~/sqlpackage):
//   pnpm exec electron-vite build && node e2e/mssql-admin.mjs
// The script reloads e2e/fixture-mssql.sql into dbm_test_adm on every run, puts
// "cost threshold for parallelism" back to its value, drops dbm_test_adm_imp and
// dbm_test_restore and deletes its .bak file on the VM.
import { existsSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { answerMessages, checker, connect, launch, loadMssqlFixture, menu, mssqlQuery, mssqlServer, profileWith, recordedMessages, shot, uiText } from './lib.mjs'

const database = 'dbm_test_adm'
const imported = 'dbm_test_adm_imp'
const server = mssqlServer(database)
const restoredDb = 'dbm_test_restore'
const option = 'cost threshold for parallelism'
const dropDatabase = (name) =>
  mssqlQuery(
    `USE master; IF DB_ID('${name}') IS NOT NULL BEGIN ALTER DATABASE [${name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${name}] END`,
    database
  )
const dropImported = () => dropDatabase(imported)
// the .bak is on the VM's disk: xp_delete_files (SQL Server 2019) removes it as the service account, no xp_cmdshell needed
const [{ dir: backupDir }] = await mssqlQuery("SELECT CAST(SERVERPROPERTY('InstanceDefaultBackupPath') AS nvarchar(4000)) AS dir", database)
const bak = `${backupDir.replace(/[\\/]+$/, '')}\\${database}_e2e.bak`
// the output parameter: the result set's column names follow the login's language
const bakExists = async () =>
  (await mssqlQuery(`DECLARE @e int; EXEC master.dbo.xp_fileexist N'${bak}', @e OUTPUT; SELECT @e AS e`, database))[0].e === 1
const removeBackup = async () => {
  await dropDatabase(restoredDb)
  if (await bakExists()) await mssqlQuery(`EXEC master.sys.xp_delete_files N'${bak}'`, database)
}
const configured = async (name) =>
  (await mssqlQuery(`SELECT CAST(value_in_use AS int) AS v FROM sys.configurations WHERE name = '${name}'`, database))[0].v
const reconfigure = (value, advanced) =>
  mssqlQuery(
    `EXEC sp_configure 'show advanced options', 1; RECONFIGURE; EXEC sp_configure '${option}', ${value}; RECONFIGURE;
     EXEC sp_configure 'show advanced options', ${advanced}; RECONFIGURE;`,
    database
  )

await loadMssqlFixture(database)
await dropImported()
await removeBackup()
const original = await configured(option)
const advancedShown = await configured('show advanced options')
const result = checker()
const { check } = result
const dumps = mkdtempSync(join(tmpdir(), 'dbm-e2e-bacpac-'))

const { app, page, errors } = await launch(profileWith([server]))
const ws = page.locator('.workspace:visible')
const editor = () => ws.locator('.editor-page:visible')
const dialog = page.locator('[role=dialog]')
const text = async (locator) => (await locator.innerText()).replace(/ /g, ' ')

async function applyReview() {
  await dialog.waitFor()
  await page.waitForTimeout(300)
  await dialog.getByRole('button', { name: 'Apply' }).click()
  await dialog.waitFor({ state: 'detached', timeout: 15000 })
  await page.waitForTimeout(300)
}

/** Changes a configuration option from the Configuration tab, through the prompt and the review dialog. */
async function setOption(name, value) {
  await editor().locator('input.search').fill(name)
  await page.waitForTimeout(300)
  const row = editor().locator('.grid .row', { has: page.locator('.cell', { hasText: new RegExp(`^${name}$`) }) })
  await row.locator('.cell').nth(1).dblclick()
  await dialog.locator('input').fill(String(value))
  await dialog.getByRole('button', { name: 'OK' }).click()
  await dialog.locator('.view-lines').waitFor()
  return applyReview()
}

/** Runs the export or import job of the open page and waits for its end; returns its status line. */
async function runJob(button) {
  await editor().getByRole('button', { name: button }).click()
  await editor().locator('.status', { hasText: /has finished|Error|Cancelled|failed|not found|exists already|cannot/ }).waitFor({ timeout: 240000 })
  return editor().locator('.status').innerText()
}

try {
  await answerMessages(app)
  await connect(page, server)

  // --- Server Status -----------------------------------------------------------------------
  await menu(app, 'server.status')
  await editor().locator('.page-header', { hasText: 'Server Status' }).waitFor()
  await page.waitForTimeout(3500)
  const status = await text(editor())
  check('status: version, edition and start time', /SQL Server 2019/.test(status) && /Express/.test(status) && status.includes(uiText('admin.status.runningSince')), status.slice(0, 600))
  check('status: memory and databases', status.includes(uiText('admin.status.maxServerMemory')) && new RegExp(`${database}\\s+\\d`).test(status), status.slice(0, 1500))
  check('status: no permission notice for a sysadmin', !(await editor().locator('.error').count()))
  const charts = await text(editor().locator('.charts'))
  check('status: counter deltas shown', /\d+(\.\d)?\/s/.test(charts), charts.slice(0, 400))
  await shot(page, 'mssql-admin-01-status')

  // --- Client Connections: the page's own session is skipped, another session is killed -----
  const sleeper = mssqlQuery("WAITFOR DELAY '00:00:40'; SELECT 1 AS done", database).then(
    () => 'finished',
    (e) => e.message
  )
  // the Info column is outside the grid's visible columns: the sleeper is tedious' default program name
  const sleeperRow = () => editor().locator('.grid .row', { hasText: 'Tedious', has: page.locator('.cell', { hasText: /^WAITFOR$/ }) })
  await menu(app, 'server.connections')
  await editor().locator('.summary', { hasText: 'User Sessions' }).waitFor()
  await sleeperRow().waitFor({ timeout: 10000 })
  const grid = await text(editor().locator('.list'))
  check('connections: own sessions listed', /DBKnife/.test(grid) && grid.includes(database), grid.slice(0, 600))

  // the session of this page is the one running a SELECT (its sessions query) while it refreshes
  const ownCell = editor().locator('.grid .row', { hasText: 'DBKnife', has: page.locator('.cell', { hasText: /^SELECT$/ }) }).first().locator('.cell').first()
  const ownId = await ownCell.innerText()
  await ownCell.click()
  await editor().getByRole('button', { name: 'Kill Connections' }).click()
  await page.waitForTimeout(500)
  let messages = await recordedMessages(app)
  check('connections: the page session is not killed', messages.length === 1 && messages[0].startsWith(uiText('admin.connections.ownSessionNotKilled', { id: ownId })), messages.join('\n'))

  await sleeperRow().locator('.cell').first().click()
  const t0 = Date.now()
  await editor().getByRole('button', { name: 'Kill Connections' }).click()
  const ended = await sleeper
  check('connections: KILL ends the other session', Date.now() - t0 < 10000 && ended !== 'finished', `${Date.now() - t0} ms, ${ended}`)
  const left = await sleeperRow()
    .waitFor({ state: 'detached', timeout: 5000 })
    .then(
      () => true,
      () => false
    )
  check('connections: the killed session left the list', left)
  await shot(page, 'mssql-admin-02-connections')

  // --- Status and System Variables: an advanced, dynamic option changed and put back -------
  await menu(app, 'server.variables')
  await editor().locator('.tab', { hasText: 'Configuration' }).dispatchEvent('mousedown')
  await editor().locator('input.search').fill(option)
  await page.waitForTimeout(300)
  // without "show advanced options" turned on first the change fails, without turning it off it stays on
  await setOption(option, original + 1)
  check('variables: option changed', (await configured(option)) === original + 1, String(await configured(option)))
  check('variables: show advanced options back off', (await configured('show advanced options')) === advancedShown)
  // the finally block puts the option back
  await editor().locator('.tab', { hasText: 'Performance Counters' }).dispatchEvent('mousedown')
  await editor().locator('input.search').fill('Batch Requests')
  await page.waitForTimeout(300)
  check('variables: performance counters', /Batch Requests\/sec/.test(await text(editor().locator('.list'))))
  await editor().locator('input.search').fill('@@CONNECTIONS')
  await page.waitForTimeout(300)
  check('variables: server functions', /@@CONNECTIONS\s+\d+/.test(await text(editor().locator('.list'))))
  await shot(page, 'mssql-admin-03-variables')

  // --- Data Export to a .bacpac file and Import into a new database -----------------------------
  const file = join(dumps, `${database}.bacpac`)
  const [{ n: customers }] = await mssqlQuery('SELECT COUNT(*) AS n FROM shop.customer', database)
  await menu(app, 'server.export')
  await editor().locator('#de-bacpac').waitFor()
  await editor().locator('#de-bacpac').fill(file)
  let outcome = await runJob('Start Export')
  check('export: .bacpac finished', !(await editor().locator('.status.error').count()) && existsSync(file) && statSync(file).size > 0, `${outcome}\n${await text(editor().locator('.log'))}`)
  check('export: password not on the command line', !/Password:test/.test(await text(editor().locator('.log'))))
  await shot(page, 'mssql-admin-04-export')

  await menu(app, 'server.import')
  await editor().locator('#di-bacpac').fill(file)
  await editor().locator('#di-database').fill(database)
  outcome = await runJob('Start Import')
  check('import: refused into an existing database', outcome.includes(uiText('tools.mssql.databaseExists', { database })), outcome)
  await editor().locator('#di-database').fill(imported)
  outcome = await runJob('Start Import')
  check('import: .bacpac finished', !(await editor().locator('.status.error').count()), `${outcome}\n${await text(editor().locator('.log'))}`)
  const [{ n: restored }] = await mssqlQuery('SELECT COUNT(*) AS n FROM shop.customer', imported)
  check('import: table restored in the new database', restored === customers, `${restored} vs ${customers}`)
  await shot(page, 'mssql-admin-05-import')

  // --- Backup / Restore of a .bak file on the server's disk -------------------------------------
  await menu(app, 'server.backup')
  await editor().locator('.page-header', { hasText: 'Backup / Restore' }).waitFor()
  const backupDb = editor().locator('#mb-database')
  check('backup: database of the connection', (await backupDb.inputValue()) === database, await backupDb.inputValue())
  // the default folder arrives asynchronously: a path typed before it would count as the user's
  const backupPath = editor().locator('#mb-backup-path')
  await page.waitForFunction(() => document.querySelector('.workspace:not([style*="display: none"]) #mb-backup-path')?.value, null, { timeout: 10000 })
  const suggested = await backupPath.inputValue()
  const escaped = backupDir.replace(/[\\/]+$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  check('backup: path suggested in the default backup folder', new RegExp(`^${escaped}\\\\${database}_\\d{8}_\\d{4}\\.bak$`).test(suggested), suggested)
  await backupPath.fill(bak)
  await editor().getByRole('button', { name: 'Back Up' }).click()
  const jobEnd = (done) => editor().locator('.status', { hasText: done }).or(editor().locator('.status.error'))
  await jobEnd(/Backup to .* has finished/).waitFor({ timeout: 240000 })
  outcome = await editor().locator('.status').innerText()
  const failed = async () => !!(await editor().locator('.status.error').count())
  check('backup: job finished without error', !(await failed()) && (await bakExists()), `${outcome}\n${await text(editor().locator('pre.log'))}`)

  await editor().locator('#mb-restore-path').fill(bak)
  await editor().getByRole('button', { name: 'Read Files' }).click()
  await editor().locator('table.list.files').or(editor().locator('p.error')).waitFor({ timeout: 30000 })
  const types = await editor().locator('table.list.files tbody tr td:nth-child(2)').allInnerTexts()
  check('restore: Read Files lists a data and a log file', types.includes(uiText('admin.mssqlBackup.fileType.data')) && types.includes(uiText('admin.mssqlBackup.fileType.log')), types.join(', ') || (await text(editor().locator('p.error'))))
  await editor().locator('#mb-restore-as').fill(restoredDb)
  await editor().getByRole('button', { name: 'Restore', exact: true }).click()
  await jobEnd(/Restore of .* has finished/).waitFor({ timeout: 240000 })
  outcome = await editor().locator('.status').innerText()
  const [{ id: restoredId }] = await mssqlQuery(`SELECT DB_ID('${restoredDb}') AS id`, database)
  check('restore: new database created', !(await failed()) && restoredId !== null, `${outcome}\n${await text(editor().locator('pre.log'))}`)
  await shot(page, 'mssql-admin-06-backup-restore')

  // --- SQL Server Agent: the test VM runs Express --------------------------------------------------
  await menu(app, 'server.agent')
  await editor().locator('.page-header', { hasText: 'SQL Server Agent' }).waitFor()
  const express = await editor().locator('p.express').waitFor({ timeout: 10000 }).then(
    () => true,
    () => false
  )
  check('agent: Express notice', express)
  await shot(page, 'mssql-admin-07-agent')

  // REPLACE was off: the restore asked no confirmation
  messages = await recordedMessages(app)
  check('only the expected message boxes', messages.length === 2 && messages[1].startsWith(uiText('admin.connections.confirmKillConnection', { count: 1 })), messages.join('\n'))
  check('no renderer errors', errors.length === 0, errors.join('\n'))
} catch (e) {
  result.failures++
  console.log('FAIL exception', e.message)
  await shot(page, 'mssql-admin-exception')
} finally {
  await app.close()
  if ((await configured(option)) !== original || (await configured('show advanced options')) !== advancedShown) await reconfigure(original, advancedShown)
  await dropImported()
  await removeBackup()
}
console.log(result.failures ? `\n${result.failures} failure(s)` : '\nall checks passed')
process.exit(result.failures ? 1 : 0)
