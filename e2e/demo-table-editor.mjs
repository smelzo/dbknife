// Screenshot for the site: the table editor on Album with a new column and its index, and the
// review dialog with the minimal ALTER TABLE (cancelled: nothing changes). Chinook container in
// e2e/demo-editor.mjs:
//   pnpm build && node e2e/demo-table-editor.mjs   → e2e/output/demo-table-editor.png (2x)
import { join } from 'node:path'
import { answerMessages, outDir, shot } from './lib.mjs'
import { recorder } from './recorder.mjs'
import { node, openDemo } from './demo-lib.mjs'

const { app, page } = await openDemo()
const editor = page.locator('.workspace:visible .editor-page:visible')
try {
  await node(page, 'Chinook').locator('.twisty').dispatchEvent('mousedown')
  await node(page, 'Tables').locator('.twisty').dispatchEvent('mousedown')
  await node(page, 'Album').hover()
  await node(page, 'Album').locator('button[title="Alter Table"]').click()
  const rows = editor.locator('.columns-tab tbody tr')
  await rows.nth(2).dispatchEvent('mousedown')
  await editor.locator('button[title="Add a column after the selected one"]').click()
  await rows.nth(3).locator('input[type=text]').nth(0).fill('ReleaseYear')
  await rows.nth(3).locator('input[type=text]').nth(0).press('Tab')
  await rows.nth(3).locator('input[type=text]').nth(1).fill('SMALLINT')
  await rows.nth(3).locator('input[type=text]').nth(1).press('Tab')

  await editor.locator('.tabbar .tab', { hasText: 'Indexes' }).dispatchEvent('mousedown')
  await editor.locator('button[title="Add an index"]').click()
  await editor.locator('.indexes-tab .side tr.selected input[type=text]').first().fill('IFK_AlbumReleaseYear')
  await editor.locator('label.check', { hasText: 'ReleaseYear' }).locator('input').check()
  // back to the columns, which show the new one around the review dialog
  await editor.locator('.tabbar .tab', { hasText: 'Columns' }).dispatchEvent('mousedown')
  await page.waitForTimeout(300)

  await editor.locator('.actions button.primary').click()
  const review = page.locator('[role=dialog]')
  await review.waitFor()
  await page.waitForTimeout(800)
  const rec = await recorder(page, join(outDir, 'demo-table-editor'))
  await rec.still(join(outDir, 'demo-table-editor.png'))
  console.log(await review.locator('.view-lines').innerText())
  await review.getByRole('button', { name: 'Cancel' }).click()
} catch (e) {
  await shot(page, 'demo-table-editor-failed')
  throw e
} finally {
  // the unapplied changes ask before closing: Close Anyway
  await answerMessages(app)
  await app.close()
}
