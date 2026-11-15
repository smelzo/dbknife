// UI check of the table editor and inspector: DBM_OUT=out-te node e2e/table-editor.mjs [mysql|mariadb]
// Needs the te_scratch schema of e2e/table-fixture.sql on the test server.
import { connect, launch, outputMessages, runSql, servers, shot } from './lib.mjs'

const server = process.argv[2] ?? 'mysql'
const { app, page, errors } = await launch()
const ws = '.workspace:visible'
const node = (label) => page.locator(`${ws} .node`, { has: page.locator('.label', { hasText: new RegExp(`^${label}$`) }) }).first()
const expand = (label) => node(label).locator('.twisty').dispatchEvent('mousedown')
const editor = () => page.locator(`${ws} .editor-page:visible`)
const subTab = (label) => editor().locator('.tabbar .tab', { hasText: label }).dispatchEvent('mousedown')
const prefix = `te-${server}`

try {
  await page.emulateMedia({ colorScheme: 'light' })
  await connect(page, servers[server])
  await runSql(page, 'USE te_scratch')
  await expand('te_scratch')
  await expand('Tables')
  await node('plain').hover()
  await node('plain').locator('button[title="Alter Table"]').click()
  await editor().locator('.columns-tab').waitFor()
  await page.waitForTimeout(300)
  await shot(page, `${prefix}-01-columns`)

  // rename `name` and move `email` after `notes`
  const nameInput = editor().locator('.columns-tab tbody tr').nth(1).locator('input[type=text]').first()
  await nameInput.fill('full_name')
  await nameInput.press('Tab')
  await editor().locator('.columns-tab tbody tr').nth(2).dispatchEvent('mousedown')
  for (let i = 0; i < 3; i++) await editor().locator('button[title="Move down"]').click()
  await shot(page, `${prefix}-02-edited`)
  await editor().locator('.actions button.primary').click()
  await page.locator('[role=dialog]').waitFor()
  await page.waitForTimeout(300)
  await shot(page, `${prefix}-03-review`)
  await page.locator('[role=dialog] button.primary').click()
  await page.locator('[role=dialog]').waitFor({ state: 'detached' })
  await page.waitForTimeout(500)
  console.log('after apply:', await outputMessages(page))

  for (const [label, name] of [['Indexes', '04-indexes'], ['Foreign Keys', '05-fks'], ['Triggers', '06-triggers'], ['Options', '07-options']]) {
    await subTab(label)
    await page.waitForTimeout(300)
    await shot(page, `${prefix}-${name}`)
  }

  // kitchen: preserved clauses in the options tab, generated column detail
  await node('kitchen').hover()
  await node('kitchen').locator('button[title="Alter Table"]').click()
  await editor().locator('.columns-tab').waitFor()
  await editor().locator('.columns-tab tbody tr', { has: page.locator('input[value="full_name"]') }).dispatchEvent('mousedown')
  await page.waitForTimeout(300)
  await shot(page, `${prefix}-08-kitchen`)
  await subTab('Options')
  await shot(page, `${prefix}-09-kitchen-options`)

  // new table from the main toolbar
  await page.locator(`${ws} button[title="Create a new table in the active schema"]`).click()
  await editor().locator('.columns-tab').waitFor()
  await editor().locator('.header input[type=text]').first().fill('te_new')
  await editor().locator('button[title="Add a column after the selected one"]').click()
  await editor().locator('.columns-tab tbody tr').nth(1).locator('td.flag input').nth(2).check()
  await shot(page, `${prefix}-10-new`)
  await editor().locator('.actions button.primary').click()
  await page.locator('[role=dialog]').waitFor()
  await shot(page, `${prefix}-11-new-review`)
  await page.locator('[role=dialog] button.primary').click()
  await page.locator('[role=dialog]').waitFor({ state: 'detached' })
  await page.waitForTimeout(500)
  console.log('tab title after create:', await page.locator(`${ws} .tabbar .tab.active .label`).first().textContent())

  // inspectors
  await node('plain').hover()
  await node('plain').locator('button[title="Table Inspector"]').click()
  await page.waitForTimeout(500)
  await shot(page, `${prefix}-12-inspector-info`)
  for (const [label, name] of [['Columns', '13-inspector-columns'], ['Indexes', '14-inspector-indexes'], ['Foreign Keys', '15-inspector-fks'], ['DDL', '16-inspector-ddl']]) {
    await subTab(label)
    await page.waitForTimeout(400)
    await shot(page, `${prefix}-${name}`)
  }
  await editor().locator('button', { hasText: 'Analyze Table' }).click()
  await page.waitForTimeout(500)
  console.log('analyze status:', await editor().locator('.status').textContent())
  await node('te_scratch').dispatchEvent('mousedown')
  await page.locator(`${ws} .main-toolbar button[title="Open the inspector for the selected object"]`).click()
  await page.waitForTimeout(500)
  await shot(page, `${prefix}-17-schema-info`)
  await subTab('Tables')
  await page.waitForTimeout(400)
  await shot(page, `${prefix}-18-schema-tables`)
} finally {
  console.log('errors:', errors)
  await app.close()
}
