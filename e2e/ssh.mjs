// SSH tunnel check: needs the dbm-test-ssh container (see sshServer in lib.mjs).
import { lastOutputOk, launch, outputMessages, runSql, sshServer, shot } from './lib.mjs'

const { app, page, errors } = await launch()
let ok = false
try {
  await page.locator('.tile.folder', { hasText: 'Test' }).click()
  await page.locator('.tile', { hasText: 'MySQL via SSH' }).dblclick()
  // MySQL password first, then the SSH password once the agent keys are rejected
  for (const label of ['password', 'ssh password']) {
    const dialog = page.locator('[role=dialog]')
    await dialog.waitFor()
    console.log('prompt:', (await dialog.locator('.message').innerText()).split('\n')[0], '/', label)
    await dialog.locator('input[type=password]').fill('test')
    await page.keyboard.press('Enter')
    await dialog.waitFor({ state: 'detached' })
    if (await page.locator('.workspace').count()) break
    await page.waitForTimeout(300)
  }
  await page.locator('.monaco-editor').last().waitFor({ timeout: 20000 })
  await runSql(page, 'SELECT @@hostname AS host, CONNECTION_ID() AS id')
  ok = await lastOutputOk(page)
  console.log(await outputMessages(page))
  await shot(page, 'ssh-connected')
} finally {
  console.log(ok ? 'PASS ssh tunnel' : 'FAIL ssh tunnel', errors)
  await app.close()
}
void sshServer
process.exit(ok ? 0 : 1)
