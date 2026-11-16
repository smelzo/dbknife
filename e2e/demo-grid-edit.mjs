// Demo for the site: two cells changed and a row added in the result grid, the review of the
// generated script, then Apply. At the end the data goes back as it was. Chinook container in
// e2e/demo-editor.mjs:
//   pnpm build && node e2e/demo-grid-edit.mjs && e2e/demo-video.sh e2e/output/demo-grid-edit 1280
import { join } from 'node:path'
import { outDir, shot } from './lib.mjs'
import { recorder } from './recorder.mjs'
import { demoDb, openDemo, roomForResults } from './demo-lib.mjs'

const db = await demoDb()
const restore = async () => {
  await db.query('DELETE FROM Track WHERE TrackId = 3504')
  await db.query('UPDATE Track SET UnitPrice = 0.99 WHERE TrackId IN (1, 6)')
}
await restore()
const { app, page, editor } = await openDemo()
const ws = page.locator('.workspace:visible')
try {
  await roomForResults(app, page, editor, 110)
  await editor.click()
  await page.keyboard.insertText('SELECT TrackId, Name, AlbumId, MediaTypeId, Milliseconds, UnitPrice\nFROM Track\nWHERE AlbumId = 1')
  await page.waitForTimeout(300)
  if (await page.locator('.suggest-widget.visible').count()) await page.keyboard.press('Escape')
  const rec = await recorder(page, join(outDir, 'demo-grid-edit'))
  rec.start()
  await page.waitForTimeout(500)
  await page.keyboard.press('Meta+Enter')
  await page.waitForFunction(() => !document.querySelector('.workspace:not([style*="display: none"]) .running'))
  await page.waitForTimeout(700)

  // DOM events rather than the mouse: while recording, Playwright's clicks on the grid cells
  // were intercepted by other elements
  const cell = (row, col) => ws.locator('.grid .row').nth(row).locator('.cell').nth(col)
  for (const row of [0, 1]) {
    await cell(row, 5).dispatchEvent('dblclick')
    await page.keyboard.type('1.29', { delay: 70 })
    await page.keyboard.press('Enter')
    await page.waitForTimeout(350)
  }
  await ws.getByTitle('Add new row').dispatchEvent('click')
  await page.waitForTimeout(250)
  for (const value of ['3504', 'For Those About To Rock (Live)', '1', '1', '352000', '0.99']) {
    await page.keyboard.type(value, { delay: 35 })
    await page.keyboard.press('Tab')
  }
  await page.waitForTimeout(400)
  await ws.getByRole('button', { name: 'Apply', exact: true }).dispatchEvent('click')
  const review = page.locator('[role=dialog]')
  await review.waitFor()
  await page.waitForTimeout(2200)
  await review.getByRole('button', { name: 'Apply' }).dispatchEvent('click')
  await review.waitFor({ state: 'detached' })
  console.log(`${await rec.stop(1200)} frames`)
} catch (e) {
  await shot(page, 'demo-grid-edit-failed')
  throw e
} finally {
  await app.close()
  await restore()
  await db.end()
}
