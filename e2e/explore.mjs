// Ad-hoc exploration: node e2e/explore.mjs
import { connect, launch, outputMessages, runSql, servers, shot } from './lib.mjs'

const { app, page, errors } = await launch()
try {
  await shot(page, '01-home')
  await page.locator('.tile.folder', { hasText: 'Test' }).click()
  await shot(page, '02-home-group')
  await connect(page, servers.mysql)
  await page.waitForTimeout(800)
  await shot(page, '03-connected')
  await runSql(page, 'SELECT * FROM customer;\nSELECT * FROM orders;')
  await shot(page, '04-results')
  console.log(await outputMessages(page))
} finally {
  console.log('errors:', errors)
  await app.close()
}
