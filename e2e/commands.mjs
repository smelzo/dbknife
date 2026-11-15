// Menu commands, workspace persistence and the connection environment: node e2e/commands.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chooseFromContextMenu, connect, editorText, launch, menu, runSql, servers, shot, uiText } from './lib.mjs'

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` — ${detail}`}`)
}

let session = await launch()
let { app, page } = session
try {
  await connect(page, servers.mysql)
  const ws = () => page.locator('.workspace:visible')

  await runSql(page, 'select id,name from customer where id=1', 'Meta+Shift+Enter')
  await menu(app, 'edit.beautify')
  await page.waitForTimeout(300)
  check('beautify formats and upper-cases keywords', /SELECT\s+id,\s+name\s+FROM\s+customer\s+WHERE\s+id = 1/.test(await editorText(page)), await editorText(page))
  await menu(app, 'edit.lowercase')
  await page.waitForTimeout(200)
  check('lowercase keywords', /select\s+id/.test(await editorText(page)), await editorText(page))

  await menu(app, 'query.toggleAutocommit')
  await page.waitForTimeout(400)
  await runSql(page, "UPDATE customer SET name='Tmp' WHERE id=1")
  await menu(app, 'query.rollback')
  await page.waitForTimeout(400)
  await runSql(page, 'SELECT name FROM customer WHERE id=1')
  const nameCell = await ws().locator('.grid .row').first().locator('.cell').first().innerText()
  check('rolled back value restored', nameCell === 'Alice', nameCell)
  await menu(app, 'query.toggleAutocommit')
  await page.waitForTimeout(300)

  await menu(app, 'file.newQueryTab')
  await page.waitForTimeout(300)
  check('new query tab opened', (await ws().locator('.editors > .tabbar .tab:not(.add)').count()) === 2)
  await runSql(page, '-- persisted tab\nSELECT 42;')
  await menu(app, 'server.status')
  await page.waitForTimeout(300)
  await menu(app, 'query.limit:10')
  await page.waitForTimeout(200)
  check('limit menu updates the toolbar select', (await ws().locator('select[title="Set limit for executed queries"]').first().inputValue()) === '10')
  await menu(app, 'query.limit:1000')
  await shot(page, 'cmd-before-restart')
  await page.waitForTimeout(1200) // workspace autosave is debounced
} finally {
  await app.close()
}

// second run on the same profile: query tabs come back
session = await launch(session.userData)
;({ app, page } = session)
try {
  await connect(page, servers.mysql)
  await page.waitForTimeout(500)
  const tabs = await page.locator('.workspace:visible .editors > .tabbar .tab:not(.add) .label').allInnerTexts()
  check('query tabs restored after restart', tabs.length === 2, tabs.join(','))
  check('active tab content restored', (await editorText(page)).includes('persisted tab'), await editorText(page))
} finally {
  await app.close()
}

// connection environment: chosen in the connection editor, shown on the tile and the connection tab
session = await launch()
;({ app, page } = session)
try {
  const name = 'Env Production'
  const tile = page.locator('.tile', { has: page.locator('.name .text', { hasText: name }) })
  const badge = tile.locator('.env-badge')
  const dialog = page.locator('[role=dialog]')

  await page.getByTitle('Add a new connection').click()
  await dialog.locator('#ce-name').fill(name)
  await dialog.locator('#ce-environment').selectOption('production')
  await dialog.locator('#ce-engine').selectOption('mysql')
  await dialog.locator('#ce-host').fill('127.0.0.1')
  await dialog.locator('#ce-port').fill(String(servers.mysql.port))
  await dialog.locator('#ce-user').fill('root')
  await dialog.locator('button.primary').click()
  await dialog.waitFor({ state: 'detached' })
  check('environment Production: badge on the tile', (await badge.count()) === 1 && (await tile.locator('.env-badge.env-production').count()) === 1, await tile.innerHTML())

  await tile.dblclick()
  await page.locator('input[type=password]').fill('test')
  await page.keyboard.press('Enter')
  await page.locator('.workspace:visible .editor-page:visible .monaco-editor').first().waitFor()
  const tab = page.locator('.mtab', { hasText: name })
  check('environment Production: label on the connection tab', (await tab.locator('.env-label').count()) === 1 && (await tab.evaluate((e) => e.matches('.env.env-production'))), await tab.innerHTML())
  check('environment Production: tab title names it', (await tab.getAttribute('title')) === uiText('app.tabWithEnvironment', { name, environment: uiText('connection.environment.production') }), await tab.getAttribute('title'))

  await page.locator('.mtab.home').click()
  await chooseFromContextMenu(app, 'edit')
  await tile.click({ button: 'right' })
  const envSelect = dialog.locator('#ce-environment')
  check('environment Production: kept when the editor is reopened', (await envSelect.inputValue()) === 'production', await envSelect.inputValue())

  await envSelect.selectOption('')
  await dialog.locator('button.primary').click()
  await dialog.waitFor({ state: 'detached' })
  check('environment None: badge gone from the tile', (await tile.count()) === 1 && (await badge.count()) === 0, await tile.innerHTML())
  const saved = JSON.parse(readFileSync(join(session.userData, 'connections.json'), 'utf8')).find((c) => c.name === name)
  check('environment None: no environment field saved', saved && !('environment' in saved), JSON.stringify(saved))
  // the connection tab already open follows the editor at once, without reconnecting
  check('environment None: label gone from the open connection tab', (await tab.locator('.env-label').count()) === 0 && !(await tab.evaluate((e) => e.matches('.env'))), await tab.innerHTML())
  check('environment None: open tab title is the name alone', (await tab.getAttribute('title')) === name, await tab.getAttribute('title'))
} finally {
  await app.close()
}
console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed')
process.exit(failures ? 1 : 0)
