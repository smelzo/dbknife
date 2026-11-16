// Demo for the site: a query written with the completion and its results, on the Chinook
// sample database (MIT, github.com/lerocha/chinook-database) in its own container, so that
// the navigator shows nothing else:
//   docker run -d --name dbm-demo-mysql -e MYSQL_ROOT_PASSWORD=test -p 127.0.0.1:33070:3306 mysql:8.4
//   docker exec -i dbm-demo-mysql mysql -uroot -ptest < Chinook_MySql.sql
//   pnpm build && node e2e/demo-editor.mjs && e2e/demo-video.sh e2e/output/demo-editor
import { join } from 'node:path'
import { outDir, shot } from './lib.mjs'
import { recorder } from './recorder.mjs'
import { node, openDemo } from './demo-lib.mjs'

const { app, page, editor } = await openDemo()
try {
  // the schema and its tables open in the navigator
  await node(page, 'Chinook').locator('.twisty').dispatchEvent('mousedown')
  await node(page, 'Tables').locator('.twisty').dispatchEvent('mousedown')
  await node(page, 'Track').waitFor()
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
