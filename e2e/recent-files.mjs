// Recent files on the home screen: files opened directly are listed, Save in Connections makes a
// SQLite file a tile, File > New SQLite Database replaces the chosen file with an empty database.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { checker, chooseFromContextMenu, launch, menu, profileWith, runSql, uiText } from './lib.mjs'

const dir = mkdtempSync(join(tmpdir(), 'dbm-recent-'))
const csv = join(dir, 'prices.csv')
const sqlite = join(dir, 'new.sqlite')
writeFileSync(csv, 'id,name\n1,wine\n')
// not a database: the new one must replace it
writeFileSync(sqlite, 'not a database')

const state = checker()
const { check } = state
const { app, page, errors } = await launch(profileWith([]))
const recent = (name) => page.locator('.recent', { hasText: name })
const home = async () => {
  await menu(app, 'view.home')
  await page.locator('.home-screen').waitFor()
}

try {
  await app.evaluate(({ app }, p) => app.emit('open-file', { preventDefault() {} }, p), csv)
  await page.locator('.mtab', { hasText: 'prices.csv' }).waitFor({ timeout: 10000 })
  await home()
  await recent('prices.csv').waitFor({ timeout: 5000 })
  check('CSV file listed with its icon', (await recent('prices.csv').locator('.kind.csv').count()) === 1)

  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p })
  }, sqlite)
  await menu(app, 'file.newSqlite')
  await page.locator('.mtab', { hasText: 'new.sqlite' }).waitFor({ timeout: 10000 })
  await page.locator('.workspace:visible .editor-page:visible .monaco-editor').first().waitFor()
  check('no Reconnect button on a database file', (await page.locator(`.workspace:visible [title="${uiText('workspace.toolbar.reconnect')}"]`).count()) === 0)
  await runSql(page, 'CREATE TABLE t (x INTEGER);')
  const db = new DatabaseSync(sqlite, { readOnly: true })
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all().map((r) => r.name)
  db.close()
  check('New SQLite Database replaced the file with a database', JSON.stringify(tables) === '["t"]', JSON.stringify(tables))

  await home()
  const names = await page.locator('.recent .name').allInnerTexts()
  check('most recent first', names[0]?.trim() === 'new.sqlite' && names[1]?.trim() === 'prices.csv', JSON.stringify(names))
  check('SQLite file listed with its icon', (await recent('new.sqlite').locator('.kind.sqlite').count()) === 1)

  await page.locator('.recent-files input[type=search]').fill('prices')
  check('filter on the path', (await page.locator('.recent').count()) === 1)
  await page.locator('.recent-files input[type=search]').fill(dir.split('/').pop())
  check('filter on the folder', (await page.locator('.recent').count()) === 2)
  await page.locator('.recent-files input[type=search]').fill('')

  // Save in Connections: the editor filled in, then a tile instead of a recent file
  await chooseFromContextMenu(app, 'save')
  await recent('new.sqlite').click({ button: 'right' })
  await page.locator('#ce-file').waitFor()
  check('editor filled in with the file', (await page.locator('#ce-file').inputValue()) === sqlite)
  await page.locator('[role=dialog] button.primary').click()
  await page.locator('.tile', { hasText: 'new.sqlite' }).waitFor({ timeout: 5000 })
  await page.waitForTimeout(300)
  check('saved file leaves the recent files', (await recent('new.sqlite').count()) === 0)

  await chooseFromContextMenu(app, 'remove')
  await recent('prices.csv').click({ button: 'right' })
  await recent('prices.csv').waitFor({ state: 'detached', timeout: 5000 })
  check('Remove from Recent Files', (await page.locator('.recent-files .empty').count()) === 1)
  check('renderer errors: ' + JSON.stringify(errors), !errors.length)
} finally {
  // the query typed in new.sqlite, a temporary connection, makes quitting ask about it: Close Anyway
  await app
    .evaluate(({ dialog }, closeAnyway) => {
      dialog.showMessageBox = async (_win, o) => ({ response: Math.max(o.buttons.indexOf(closeAnyway), 0), checkboxChecked: false })
    }, uiText('workspace.closeAnyway'))
    .catch(() => undefined)
  await app.close()
}
process.exit(state.failures ? 1 : 0)
