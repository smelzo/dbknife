// Shared by the demos of the site (e2e/demo-*.mjs): the Chinook connection, the app opened on
// it, and a direct mysql2 connection to the same container (traffic, cleanup).
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import mysql from 'mysql2/promise'
import { launch, menu, profileWith } from './lib.mjs'

export const server = {
  id: 'demo-mysql',
  name: 'Music Store',
  method: 'tcp',
  host: '127.0.0.1',
  port: 33070,
  socket: '',
  user: 'root',
  defaultSchema: 'Chinook',
  ssl: { mode: 'preferred', ca: '', cert: '', key: '', cipher: '' },
  ssh: { host: '', port: 22, user: '', keyFile: '' },
  options: { compress: false, connectTimeout: 10, sqlMode: '', others: '' }
}

/** Launches the app on a profile with only the demo connection and opens it; returns the query editor too. */
export async function openDemo() {
  const userData = profileWith([server])
  writeFileSync(join(userData, 'settings.json'), JSON.stringify({ language: 'en_US', theme: process.env.DEMO_THEME ?? 'dark', window: { width: 1280, height: 800 } }))
  const { app, page } = await launch(userData)
  await page.locator('.tile', { hasText: server.name }).dblclick()
  await page.locator('input[type=password]').fill('test')
  await page.keyboard.press('Enter')
  const editor = page.locator('.workspace:visible .editor-page:visible .monaco-editor').first()
  await editor.waitFor()
  return { app, page, editor }
}

/** A navigator node of the open connection by its label. */
export const node = (page, label) =>
  page.locator('.workspace:visible .node', { has: page.locator('.label', { hasText: new RegExp(`^${label}$`) }) }).first()

/** A mysql2 connection to the demo database, outside the app. */
export const demoDb = () => mysql.createConnection({ host: server.host, port: server.port, user: 'root', password: 'test', database: 'Chinook' })

/** Room for the results: no output panel, the query editor `height` px tall. */
export async function roomForResults(app, page, editor, height) {
  await menu(app, 'view.toggleOutput')
  const splitter = page.locator('.workspace:visible .query-editor .splitpanes__splitter').first()
  const box = await splitter.boundingBox()
  const top = (await editor.boundingBox()).y
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, top + height, { steps: 5 })
  await page.mouse.up()
}
