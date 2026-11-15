// CSV files opened as a table: query, save in the file's own format, confirmation on close and quit.
import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lastOutputOk, launch, menu, runSql, uiText } from './lib.mjs'

const dir = mkdtempSync(join(tmpdir(), 'dbm-csv-'))
const file = join(dir, 'prices.csv')
const bom = '﻿'
// Excel in Italian: BOM, semicolons, CRLF, decimal commas, a quoted separator
writeFileSync(file, `${bom}id;name;price\r\n1;wine;1,50\r\n2;"bread; warm";2\r\n`)

const { app, page, userData, errors } = await launch()
let failed = false
const check = (ok, what) => {
  console.log(ok ? 'OK  ' : 'FAIL', what)
  if (!ok) failed = true
}
const tab = page.locator('.mtab', { hasText: 'prices.csv' })
const saveButton = tab.locator('.close[title="Save the CSV file"]')
const workFiles = () => {
  const root = join(userData, 'csv-work')
  return existsSync(root) ? readdirSync(root).flatMap((d) => readdirSync(join(root, d))) : []
}
/** Answers the next native message boxes with these buttons, recording their messages. */
const answer = (responses) =>
  app.evaluate(({ dialog }, r) => {
    globalThis.asked = []
    dialog.showMessageBox = async (_win, o) => {
      globalThis.asked.push(o.message)
      return { response: r.shift() ?? 1, checkboxChecked: false }
    }
  }, responses)
const asked = () => app.evaluate(() => globalThis.asked)
const open = async () => {
  await app.evaluate(({ app }, p) => app.emit('open-file', { preventDefault() {} }, p), file)
  await tab.waitFor({ timeout: 10000 })
  await page.locator('.workspace:visible .editor-page:visible .monaco-editor').first().waitFor()
}

await open()
await runSql(page, `SELECT typeof(id) || ',' || typeof(price) AS t FROM prices WHERE name = 'bread; warm';`)
const cell = await page.locator('.workspace:visible .grid .cell').allInnerTexts()
check(cell.some((c) => c.includes('integer,text')), `id INTEGER, price TEXT (decimal comma): ${JSON.stringify(cell.slice(0, 4))}`)

await runSql(page, `UPDATE prices SET name = 'beer' WHERE id = 1;`)
check(await saveButton.waitFor({ timeout: 5000 }).then(() => true, () => false), 'save button after UPDATE')
await menu(app, 'file.saveCsv')
await saveButton.waitFor({ state: 'detached', timeout: 5000 })
check(readFileSync(file, 'utf8') === `${bom}id;name;price\r\n1;beer;1,50\r\n2;"bread; warm";2\r\n`, `file saved in its format: ${JSON.stringify(readFileSync(file, 'utf8'))}`)

// changed on disk: Cancel leaves the other program's content
await runSql(page, `UPDATE prices SET name = 'water' WHERE id = 1;`)
writeFileSync(file, 'id;name;price\r\n9;other;0\r\n')
utimesSync(file, new Date(), new Date(Date.now() + 5000))
await answer([1])
await menu(app, 'file.saveCsv')
await page.waitForTimeout(1000)
check((await asked()).includes(uiText('workspace.csv.changedOnDisk', { file })), `asked before overwriting: ${JSON.stringify(await asked())}`)
check(readFileSync(file, 'utf8') === 'id;name;price\r\n9;other;0\r\n', 'file changed on disk left alone')

// closing the tab with unsaved changes: Don't Save, then Close Anyway for the query typed in the
// connection, which has no file and isn't kept by a temporary connection (plan, Task 1.3)
await answer([2, 0])
await menu(app, 'file.closeConnectionTab')
await tab.waitFor({ state: 'detached', timeout: 5000 })
const onClose = await asked()
check(
  JSON.stringify(onClose) === JSON.stringify([uiText('workspace.saveChanges', { name: 'prices.csv' }), uiText('workspace.pendingOnClose', { name: 'prices.csv' })]),
  `asked about the file, then the query: ${JSON.stringify(onClose)}`
)
check(readFileSync(file, 'utf8') === 'id;name;price\r\n9;other;0\r\n', "Don't Save writes nothing")
check(workFiles().length === 0, `hidden database removed on close: ${JSON.stringify(workFiles())}`)

// quitting with unsaved changes: Save
await open()
await runSql(page, `INSERT INTO prices VALUES (10, 'tea', '3');`)
// before waiting for the save button, which a failed INSERT never shows
check(await lastOutputOk(page), 'insert ran')
await saveButton.waitFor({ timeout: 5000 })
check(!errors.length, 'renderer errors: ' + JSON.stringify(errors))
// Save, then Close Anyway for the query
await answer([0, 0])
const closed = new Promise((resolve) => app.once('close', () => resolve(true)))
await app.evaluate(({ app }) => setTimeout(() => app.quit(), 0))
check(await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve(false), 10000))]), 'app quit after the answer')
check(readFileSync(file, 'utf8') === 'id;name;price\r\n9;other;0\r\n10;tea;3\r\n', `saved on quit: ${JSON.stringify(readFileSync(file, 'utf8'))}`)
check(workFiles().length === 0, `hidden database removed on quit: ${JSON.stringify(workFiles())}`)

process.exit(failed ? 1 : 0)
