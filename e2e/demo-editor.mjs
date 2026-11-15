// Demo for the site: a query written with the completion and its results, on the Chinook
// sample database (MIT, github.com/lerocha/chinook-database) in its own container, so that
// the navigator shows nothing else:
//   docker run -d --name dbm-demo-mysql -e MYSQL_ROOT_PASSWORD=test -p 127.0.0.1:33070:3306 mysql:8.4
//   docker exec -i dbm-demo-mysql mysql -uroot -ptest < Chinook_MySql.sql
//   pnpm build && node e2e/demo-editor.mjs && e2e/demo-video.sh e2e/output/demo-editor
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launch, outDir, profileWith, shot } from './lib.mjs'
import { recorder } from './recorder.mjs'

const server = {
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

const userData = profileWith([server])
writeFileSync(join(userData, 'settings.json'), JSON.stringify({ language: 'en_US', theme: process.env.DEMO_THEME ?? 'dark', window: { width: 1280, height: 800 } }))
const { app, page } = await launch(userData)
try {
  await page.locator('.tile', { hasText: server.name }).dblclick()
  await page.locator('input[type=password]').fill('test')
  await page.keyboard.press('Enter')
  const editor = page.locator('.workspace:visible .editor-page:visible .monaco-editor').first()
  await editor.waitFor()
  // the schema and its tables open in the navigator
  const node = (label) => page.locator('.workspace:visible .node', { has: page.locator('.label', { hasText: new RegExp(`^${label}$`) }) }).first()
  await node('Chinook').locator('.twisty').dispatchEvent('mousedown')
  await node('Tables').locator('.twisty').dispatchEvent('mousedown')
  await node('Track').waitFor()
  await page.waitForTimeout(1500)
  await shot(page, 'demo-editor-start')
  if (process.env.DEMO_EXPLORE) process.exit(0)

  const rec = await recorder(page, join(outDir, 'demo-editor'))
  await editor.click()
  rec.start()
  await page.waitForTimeout(400)
  // the completion list opens a moment after the text changes: close it once it is there,
  // otherwise Enter accepts its first entry (the alias just written) instead of a new line
  const closeList = async () => {
    await page.waitForTimeout(70)
    if (await page.locator('.suggest-widget.visible').count()) await page.keyboard.press('Escape')
  }
  // `say` writes word by word without the completion list (keywords, expressions);
  // `complete` types the start of a name and takes the first entry the completion offers
  const say = async (text) => {
    for (const word of text.split(/(?<= )/)) {
      await page.keyboard.insertText(word)
      await closeList()
      await page.waitForTimeout(40)
    }
  }
  const complete = async (start) => {
    await page.keyboard.type(start, { delay: 60 })
    await page.locator('.suggest-widget.visible').waitFor()
    await page.waitForTimeout(450)
    await page.keyboard.press('Tab')
    await page.waitForTimeout(80)
  }
  const newline = async () => {
    await closeList()
    await page.keyboard.press('Enter')
    await closeList()
  }
  await say('SELECT ar.Name AS artist, COUNT(*) AS tracks')
  await newline()
  await say('FROM ')
  await complete('Art')
  await say(' ar')
  await newline()
  await say('JOIN ')
  await complete('Alb')
  await say(' al ON al.')
  await complete('Ar')
  await say(' = ar.ArtistId')
  await newline()
  await say('JOIN ')
  await complete('Tra')
  await say(' t ON t.AlbumId = al.AlbumId')
  await newline()
  await say('GROUP BY ar.Name ORDER BY tracks DESC')
  // the list for the last word can open late: no list over the results
  await page.waitForTimeout(250)
  await closeList()
  await page.keyboard.press('Meta+Enter')
  await page.waitForFunction(() => !document.querySelector('.workspace:not([style*="display: none"]) .running'))
  console.log(`${await rec.stop(2500)} frames`)
  await rec.still(join(outDir, 'demo-editor.png'))
} catch (e) {
  await shot(page, 'demo-editor-failed')
  throw e
} finally {
  await app.close()
}
