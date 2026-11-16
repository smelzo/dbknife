// Screenshot for the site: the visual plan of a join (Explain, ⌥⌘X) on the Chinook sales.
// Chinook container in e2e/demo-editor.mjs:
//   pnpm build && node e2e/demo-plan.mjs   → e2e/output/demo-plan.png (2x)
import { join } from 'node:path'
import { outDir, shot } from './lib.mjs'
import { recorder } from './recorder.mjs'
import { openDemo, roomForResults } from './demo-lib.mjs'

const { app, page, editor } = await openDemo()
try {
  await roomForResults(app, page, editor, 185)
  await editor.click()
  await page.keyboard.insertText(
    [
      'SELECT g.Name AS genre, SUM(il.UnitPrice * il.Quantity) AS sales',
      'FROM Invoice i',
      'JOIN InvoiceLine il ON il.InvoiceId = i.InvoiceId',
      'JOIN Track t ON t.TrackId = il.TrackId',
      'JOIN Genre g ON g.GenreId = t.GenreId',
      "WHERE i.BillingCountry = 'USA'",
      'GROUP BY g.Name',
      'ORDER BY sales DESC'
    ].join('\n')
  )
  await page.waitForTimeout(300)
  if (await page.locator('.suggest-widget.visible').count()) await page.keyboard.press('Escape')
  await page.keyboard.press('Meta+Alt+x')
  await page.locator('.workspace:visible .plan .step').first().waitFor()
  await page.waitForTimeout(800)
  const rec = await recorder(page, join(outDir, 'demo-plan'))
  await rec.still(join(outDir, 'demo-plan.png'))
} catch (e) {
  await shot(page, 'demo-plan-failed')
  throw e
} finally {
  await app.close()
}
