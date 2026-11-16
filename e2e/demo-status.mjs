// Demo for the site: the Server Status page with its charts moving, while other connections
// run reads and joins on Chinook and writes on a temporary table. Chinook container in
// e2e/demo-editor.mjs:
//   pnpm build && node e2e/demo-status.mjs && e2e/demo-video.sh e2e/output/demo-status 1280
import { join } from 'node:path'
import { menu, outDir, shot } from './lib.mjs'
import { recorder } from './recorder.mjs'
import { demoDb, openDemo } from './demo-lib.mjs'

const queries = [
  'SELECT * FROM Track WHERE Milliseconds > 300000',
  'SELECT g.Name, SUM(il.UnitPrice * il.Quantity) FROM InvoiceLine il JOIN Track t ON t.TrackId = il.TrackId JOIN Genre g ON g.GenreId = t.GenreId GROUP BY g.Name',
  'SELECT c.Country, COUNT(*), SUM(i.Total) FROM Customer c JOIN Invoice i ON i.CustomerId = c.CustomerId GROUP BY c.Country',
  'SELECT ar.Name, COUNT(*) FROM Artist ar JOIN Album al ON al.ArtistId = ar.ArtistId JOIN Track t ON t.AlbumId = al.AlbumId GROUP BY ar.Name'
]
let running = true
/** One client: bursts of queries with pauses that change over time, so the charts go up and down. */
async function client(n) {
  const db = await demoDb()
  await db.query('CREATE TEMPORARY TABLE demo_log (id INT AUTO_INCREMENT PRIMARY KEY, track INT, at DATETIME)')
  for (let i = 0; running; i++) {
    // the same wave for every client: the total goes up and down (shifted waves would add up to a flat line)
    const wave = Math.sin(Date.now() / 1500)
    const burst = 1 + Math.round(10 * Math.max(0, wave))
    for (let q = 0; q < burst && running; q++) await db.query(queries[(i + q + n) % queries.length])
    await db.query('INSERT INTO demo_log (track, at) SELECT TrackId, NOW() FROM Track WHERE TrackId % 50 = ?', [i % 50])
    if (i % 5 === 4) await db.query('DELETE FROM demo_log')
    await new Promise((r) => setTimeout(r, (wave > 0 ? 30 : 250) + 100 * Math.random()))
  }
  await db.end()
}

const { app, page } = await openDemo()
const clients = [0, 1, 2].map(client)
try {
  await menu(app, 'view.toggleOutput')
  await menu(app, 'server.status')
  await page.locator('.workspace:visible .page-header', { hasText: 'Server Status' }).waitFor()
  // the charts sample once a second: nearly full before the recording
  await page.waitForTimeout(Number(process.env.DEMO_WARMUP ?? 55000))
  const rec = await recorder(page, join(outDir, 'demo-status'))
  rec.start()
  console.log(`${await rec.stop(Number(process.env.DEMO_LENGTH ?? 10000))} frames`)
} catch (e) {
  await shot(page, 'demo-status-failed')
  throw e
} finally {
  running = false
  await Promise.all(clients)
  await app.close()
}
