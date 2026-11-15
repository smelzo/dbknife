// End-to-end check of the SQL editor core against both docker servers:
//   pnpm exec electron-vite build && node e2e/core.mjs
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect, editorText, launch, menu, outputMessages, runSql, servers, shot, uiPattern, uiText } from './lib.mjs'

const cli = (server, sql) =>
  execFileSync('docker', ['exec', server === servers.mysql ? 'dbm-test-mysql' : 'dbm-test-mariadb', server === servers.mysql ? 'mysql' : 'mariadb', '-uroot', '-ptest', '-N', '-e', sql], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim()

let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` — ${detail}`}`)
}

for (const key of ['mysql', 'mariadb']) {
  const server = servers[key]
  console.log(`\n== ${server.name}`)
  cli(server, "UPDATE shop.customer SET name='Bob' WHERE id=2; DELETE FROM shop.customer WHERE id > 3; DELETE FROM shop.log_nopk WHERE msg='tx'")
  const { app, page, errors } = await launch()
  /** Answers the next native message boxes with these buttons (then Cancel), recording their messages. */
  const answer = (responses) =>
    app.evaluate(({ dialog }, r) => {
      globalThis.asked = []
      dialog.showMessageBox = async (_win, o) => {
        globalThis.asked.push(o.message)
        return { response: r.shift() ?? o.cancelId ?? 1, checkboxChecked: false }
      }
    }, responses)
  const asked = () => app.evaluate(() => globalThis.asked)
  try {
    await connect(page, server)
    const ws = page.locator('.workspace:visible')

    // multi statement script, auto LIMIT, error stops the script
    await runSql(page, "SELECT * FROM customer;\nSELECT nope FROM customer;\nSELECT 1;")
    let out = await outputMessages(page)
    check('auto LIMIT appended', out.some((l) => l.startsWith('SELECT * FROM customer LIMIT 0, 1000 | ')), out.join('\n'))
    check('error reported with code', out.some((l) => l.startsWith('SELECT nope FROM customer') && /\b1054\b/.test(l)), out.join('\n'))
    check('script stops on error', !out.some((l) => l.startsWith('SELECT 1')), out.join('\n'))
    check('error marker in editor', (await ws.locator('.squiggly-error').count()) > 0)
    const footer = ws.locator('.editor-page:visible .results .footer')
    check('footer flags the failed statement next to the results', (await footer.locator('.failed').count()) === 1, await footer.innerText())

    // a failure with the Output hidden: the Output comes back and the results panel shows the error
    const output = ws.locator('.output')
    await menu(app, 'view.toggleOutput')
    await output.waitFor({ state: 'detached', timeout: 5000 }).catch(() => undefined)
    check('Output hidden by View > Toggle Output', (await output.count()) === 0)
    await runSql(page, 'SELECT nope FROM customer')
    check('a failed statement shows the Output again', (await output.count()) === 1)
    if (!(await output.count())) await menu(app, 'view.toggleOutput')
    const failure = ws.locator('.editor-page:visible .results > .error')
    const failureMessage = (await failure.count()) ? await failure.locator('.message').innerText() : '(no error block)'
    check('results panel shows the failed statement', /\b1054\b[\s\S]*nope/.test(failureMessage), failureMessage)

    // a result that fills the row limit says that more rows may exist
    const limitSelect = page.locator('select[title="Set limit for executed queries"]').first()
    await limitSelect.selectOption('10')
    await runSql(page, 'SELECT * FROM information_schema.COLLATIONS')
    const footerCount = () => footer.locator('span').first().innerText()
    check('footer says the limit was reached', (await footerCount()) === uiText('results.footer.limited', { count: 10 }), await footer.innerText())
    await runSql(page, 'SELECT * FROM customer')
    const customers = Number(cli(server, 'SELECT COUNT(*) FROM shop.customer'))
    check('no limit note below the limit', (await footerCount()) === uiText('results.footer.rows', { count: customers }), await footer.innerText())
    await limitSelect.selectOption('1000')

    // current statement only
    await runSql(page, 'SELECT 1 AS a;\nSELECT 2 AS b', 'Meta+Enter')
    out = await outputMessages(page)
    check('execute current statement runs only the one under the caret', out.at(-1)?.startsWith('SELECT 2 AS b'), out.at(-1))

    // grid editing: change Bob's name, review dialog, apply
    await runSql(page, 'SELECT * FROM customer ORDER BY id')
    await page.waitForFunction(() => document.querySelector('.workspace .status')?.textContent === '')
    const cell = ws.locator('.grid .row').nth(1).locator('.cell').nth(1)
    await cell.dblclick()
    await page.keyboard.press('Meta+A')
    await page.keyboard.insertText('Bobby')
    await page.keyboard.press('Enter')
    check('edited cell marked as modified', (await ws.locator('.cell.modified').count()) === 1)
    await ws.getByRole('button', { name: 'Apply', exact: true }).click()
    const review = page.locator('[role=dialog]')
    await review.waitFor()
    await page.waitForTimeout(300)
    const script = await review.locator('.view-lines').innerText()
    check('review shows UPDATE by primary key', /UPDATE `shop`.`customer` SET `name` = 'Bobby' WHERE \(`id` = 2\)/.test(script.replace(/\s+/g, ' ')), script)
    await shot(page, `core-${key}-review`)
    await review.getByRole('button', { name: 'Apply' }).click()
    await review.waitFor({ state: 'detached' })
    await page.waitForTimeout(300)
    check('edit applied to the database', cli(server, 'SELECT name FROM shop.customer WHERE id=2') === 'Bobby')

    // add a row through the grid
    await ws.getByTitle('Add new row').click()
    await page.keyboard.press('Tab')
    await page.keyboard.type('Dora')
    await page.keyboard.press('Enter')
    await ws.getByRole('button', { name: 'Apply', exact: true }).click()
    await page.locator('[role=dialog]').getByRole('button', { name: 'Apply' }).click()
    await page.locator('[role=dialog]').waitFor({ state: 'detached' })
    await page.waitForTimeout(300)
    check('row inserted through the grid', cli(server, "SELECT COUNT(*) FROM shop.customer WHERE name='Dora'") === '1')

    // grid edits not applied: Refresh and a new execution ask before discarding them
    await runSql(page, 'SELECT * FROM customer ORDER BY id')
    await page.waitForFunction(() => document.querySelector('.workspace .status')?.textContent === '')
    const firstName = () => ws.locator('.grid .row').nth(0).locator('.cell').nth(1)
    const editFirstName = async () => {
      await firstName().dblclick()
      await page.keyboard.press('Meta+A')
      await page.keyboard.insertText('Unsaved')
      await page.keyboard.press('Enter')
    }
    const modified = () => ws.locator('.cell.modified').count()
    const discardAsked = async () => {
      const m = await asked()
      return m.length === 1 && uiPattern('results.discardEdits.confirm').test(m[0])
    }
    const refresh = ws.locator('.editor-page:visible').getByTitle('Refresh (re-execute the query)')
    await editFirstName()
    await answer([1])
    await refresh.click()
    await page.waitForTimeout(500)
    check('Refresh asks before discarding grid edits', await discardAsked(), JSON.stringify(await asked()))
    check('Cancel keeps the grid edit', (await modified()) === 1 && (await firstName().innerText()) === 'Unsaved', await firstName().innerText())
    await answer([0])
    await refresh.click()
    await ws.locator('.cell.modified').waitFor({ state: 'detached', timeout: 5000 }).catch(() => undefined)
    check('Discard Edits refreshes without the edit', (await discardAsked()) && (await modified()) === 0 && (await firstName().innerText()) === cli(server, 'SELECT name FROM shop.customer WHERE id=1'), `${JSON.stringify(await asked())} ${await firstName().innerText()}`)
    await editFirstName()
    const outBefore = (await outputMessages(page)).length
    await answer([1])
    await menu(app, 'query.executeAll')
    await page.waitForTimeout(500)
    check('Execute asks before discarding grid edits', await discardAsked(), JSON.stringify(await asked()))
    check('Cancel neither runs the query nor drops the edit', (await outputMessages(page)).length === outBefore && (await modified()) === 1, (await outputMessages(page)).slice(outBefore).join('\n'))
    await answer([0])
    await menu(app, 'query.executeAll')
    await page.waitForFunction(() => !document.querySelector('.workspace:not([style*="display: none"]) .running'))
    await ws.locator('.cell.modified').waitFor({ state: 'detached', timeout: 5000 }).catch(() => undefined)
    check('Discard Edits runs the query again', (await discardAsked()) && (await outputMessages(page)).length > outBefore && (await modified()) === 0, (await outputMessages(page)).slice(outBefore).join('\n'))

    // a table without primary key is read only
    await runSql(page, 'SELECT * FROM log_nopk')
    await page.waitForTimeout(300)
    check('table without PK is read only', (await ws.locator('.status').innerText()).includes(uiText('results.readOnly.noPrimaryKey')))

    // export a result to XLSX, then read the file back with d-spread: the column names on row 1,
    // then the rows as in the database, numeric columns as numbers and text as strings
    await runSql(page, 'SELECT id, total, status FROM orders ORDER BY id')
    const xlsx = join(mkdtempSync(join(tmpdir(), 'dbm-xlsx-')), 'orders.xlsx')
    await app.evaluate(({ dialog }, p) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: p })
    }, xlsx)
    await answer([])
    await ws.locator('.editor-page:visible button[title="Export recordset to an external file"]').click()
    await page.locator('#pf-format').selectOption('Excel (XLSX)')
    await page.locator('.panel[role=dialog] button.primary').click()
    for (let t = 0; t < 50 && !existsSync(xlsx); t++) await page.waitForTimeout(100)
    const sheet = existsSync(xlsx)
      ? execFileSync(join(import.meta.dirname, '../bin/darwin-arm64/d-spread'), [xlsx], { encoding: 'utf8' }).trim().split('\n').map((l) => JSON.parse(l))
      : []
    const expected = cli(server, 'SELECT id, total, status FROM shop.orders ORDER BY id')
      .split('\n')
      .map((l, i) => {
        const [id, total, status] = l.split('\t')
        return [i + 2, [Number(id), Number(total), status]]
      })
    check('XLSX has the result rows plus the header row', sheet[0]?.rows === expected.length + 1, JSON.stringify(sheet[0] ?? (await asked())))
    check('XLSX row 1 holds the column names', JSON.stringify(sheet[1]) === JSON.stringify([1, ['id', 'total', 'status']]), JSON.stringify(sheet[1]))
    check('XLSX rows: numbers as numbers, text as strings', JSON.stringify(sheet.slice(2, -1)) === JSON.stringify(expected), JSON.stringify(sheet.slice(2, -1)))

    // navigator: expand schema, tables, columns
    await ws.locator('.node', { hasText: 'shop' }).locator('.twisty').dispatchEvent('mousedown')
    await ws.locator('.node', { hasText: 'Tables' }).locator('.twisty').dispatchEvent('mousedown')
    await ws.locator('.node', { hasText: /^customer$/ }).first().waitFor()
    await ws.locator('.node').filter({ hasText: 'customer' }).first().locator('.twisty').dispatchEvent('mousedown')
    await ws.locator('.node', { hasText: 'Columns' }).first().locator('.twisty').dispatchEvent('mousedown')
    await ws.locator('.node', { hasText: 'balance' }).waitFor()
    check('navigator shows columns with types', /decimal\(10,2\)/.test(await ws.locator('.node', { hasText: 'balance' }).innerText()))
    check('navigator has no sequences, types or extensions', (await ws.locator('[data-key$="/sequences"], [data-key$="/types"], [data-key="db/extensions"]').count()) === 0, (await ws.locator('.node').allInnerTexts()).join(','))
    await ws.locator('.node').filter({ hasText: 'customer' }).first().dispatchEvent('mousedown')
    await page.waitForTimeout(200)
    check('object info shows the table columns', /balance/.test(await ws.locator('.info .body').innerText()))
    await shot(page, `core-${key}-tree`)

    // double-click on a table: by default it opens its rows in a new tab (plan, Task 4.1)
    const editorTabs = ws.locator('.editors > .tabbar > .tab:not(.add)')
    const ordersTab = editorTabs.filter({ has: page.locator('.label', { hasText: /^orders$/ }) })
    const tabsBefore = await editorTabs.count()
    await ws.locator('.node', { hasText: /^orders$/ }).first().locator('.label').dblclick()
    await ordersTab.waitFor({ timeout: 5000 }).catch(() => undefined)
    await page.waitForFunction(() => !document.querySelector('.workspace:not([style*="display: none"]) .running'))
    await page.waitForTimeout(300)
    const ordersCount = Number(cli(server, 'SELECT COUNT(*) FROM shop.orders'))
    const gridRows = await ws.locator('.editor-page:visible .grid .row').count()
    check(
      'double-click on a table opens its rows in a new tab',
      (await editorTabs.count()) === tabsBefore + 1 && (await ordersTab.getAttribute('aria-selected')) === 'true' && gridRows === ordersCount,
      `${await editorTabs.count()} tabs (were ${tabsBefore}), ${gridRows} rows shown, ${ordersCount} in the table`
    )
    // with the preference insertName it inserts the table name in the editor instead
    await menu(app, 'app.preferences')
    await page.locator('#pr-dblclick').selectOption('insertName')
    await page.locator('.panel[role=dialog] button.primary').click()
    await page.locator('.panel[role=dialog]').waitFor({ state: 'detached' })
    const tabEditor = ws.locator('.editor-page:visible .monaco-editor').first()
    const clearEditor = async () => {
      await tabEditor.click()
      await page.keyboard.press('Meta+A')
      await page.keyboard.press('Backspace')
    }
    await clearEditor()
    const outputBefore = (await outputMessages(page)).length
    await ws.locator('.node', { hasText: /^customer$/ }).first().locator('.label').dblclick()
    await page.waitForTimeout(300)
    const inserted = (await editorText(page)).trim()
    check(
      'with insertName, double-click inserts the table name in the editor',
      /^`?customer`?$/.test(inserted) && (await editorTabs.count()) === tabsBefore + 1 && (await outputMessages(page)).length === outputBefore,
      `editor: ${JSON.stringify(inserted)}, ${await editorTabs.count()} tabs, ${(await outputMessages(page)).length - outputBefore} new output lines`
    )
    // a tab opened with generated SQL asks to save only once its text changed: the name inserted above changed it
    await answer([1])
    await ordersTab.locator('button.close').click()
    await page.waitForTimeout(300)
    check(
      'closing a generated tab whose text changed asks to save it',
      JSON.stringify(await asked()) === JSON.stringify([uiText('workspace.saveChanges', { name: 'orders' })]) && (await ordersTab.count()) === 1,
      JSON.stringify(await asked())
    )
    // the close button of a tab acts on click (plan, Task 4.3); Don't Save
    await answer([2])
    await ordersTab.locator('button.close').click()
    await ordersTab.waitFor({ state: 'detached', timeout: 5000 }).catch(() => undefined)
    check('tab close button closes the tab on click', (await editorTabs.count()) === tabsBefore, `${await editorTabs.count()} tabs`)

    // back to the default openData: a generated tab left unchanged closes without asking
    await menu(app, 'app.preferences')
    await page.locator('#pr-dblclick').selectOption('openData')
    await page.locator('.panel[role=dialog] button.primary').click()
    await page.locator('.panel[role=dialog]').waitFor({ state: 'detached' })
    const customerTab = editorTabs.filter({ has: page.locator('.label', { hasText: /^customer$/ }) })
    const openCustomerRows = async () => {
      await ws.locator('.node', { hasText: /^customer$/ }).first().locator('.label').dblclick()
      await customerTab.waitFor({ timeout: 5000 }).catch(() => undefined)
      await page.waitForFunction(() => !document.querySelector('.workspace:not([style*="display: none"]) .running'))
      await page.waitForTimeout(300)
    }
    await openCustomerRows()
    await answer([])
    await customerTab.locator('button.close').click()
    await customerTab.waitFor({ state: 'detached', timeout: 5000 }).catch(() => undefined)
    check('a tab opened with Select Rows closes without a dialog', (await customerTab.count()) === 0 && (await asked()).length === 0, JSON.stringify(await asked()))
    // grid edits not applied still ask in a generated tab
    await openCustomerRows()
    await ws.locator('.editor-page:visible .grid .row').nth(0).locator('.cell').nth(1).dblclick()
    await page.keyboard.press('Meta+A')
    await page.keyboard.insertText('Unsaved')
    await page.keyboard.press('Enter')
    await answer([1])
    await customerTab.locator('button.close').click()
    await page.waitForTimeout(300)
    const gridAsked = await asked()
    check(
      'a generated tab with grid edits asks before closing',
      gridAsked.length === 1 && uiPattern('results.discardEdits.confirm').test(gridAsked[0]) && (await customerTab.count()) === 1,
      JSON.stringify(gridAsked)
    )
    await answer([0])
    await customerTab.locator('button.close').click()
    await customerTab.waitFor({ state: 'detached', timeout: 5000 }).catch(() => undefined)
    check('Discard Edits closes the generated tab', (await customerTab.count()) === 0, JSON.stringify(await asked()))

    // explain
    await runSql(page, 'SELECT * FROM customer c JOIN orders o ON o.customer_id = c.id', 'Meta+Alt+X')
    await page.waitForTimeout(400)
    check('visual explain rendered', (await ws.locator('.plan .step').count()) === 2)
    await shot(page, `core-${key}-explain`)

    // procedure with several result sets / function
    await runSql(page, "CALL add_customer(' Eve ');\nSELECT customer_count() AS n;")
    out = await outputMessages(page)
    check('CALL returns a result set', out.some((l) => l.startsWith(`CALL add_customer(' Eve ') | ${uiText('output.rowsReturned', { count: 1 })}`)), out.slice(-3).join('\n'))
    check('trigger trimmed the inserted name', cli(server, "SELECT COUNT(*) FROM shop.customer WHERE name='Eve'") === '1')

    // vertical output
    await runSql(page, 'SELECT id, name FROM customer WHERE id = 1', 'Meta+Alt+Enter')
    await page.waitForTimeout(200)
    check('vertical text output', (await ws.locator('pre.text').innerText()).includes(uiText('results.vertical.row', { n: 1 })))

    // autocompletion of columns through an alias
    const ed = ws.locator('.editor-page:visible .monaco-editor').first()
    await ed.click()
    await page.keyboard.press('Meta+A')
    await page.keyboard.press('Backspace')
    await page.keyboard.insertText('SELECT c. FROM customer c')
    for (let i = 0; i < ' FROM customer c'.length; i++) await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('Control+Space')
    await page.locator('.suggest-widget .monaco-list-row').first().waitFor()
    const labels = await page.locator('.suggest-widget .monaco-list-row').allInnerTexts()
    check('alias completion lists the table columns', labels.some((l) => l.includes('balance')), labels.join(','))
    await page.keyboard.press('Escape')
    await shot(page, `core-${key}-final`)

    // autocommit off: closing the connection tab asks about the open transaction
    await menu(app, 'query.toggleAutocommit')
    const manual = ws.locator('.manual-commit', { hasText: 'Manual commit' })
    await manual.waitFor({ timeout: 5000 }).catch(() => undefined)
    check('toolbar shows Manual commit', (await manual.count()) === 1)
    await runSql(page, "INSERT INTO log_nopk VALUES ('tx')")
    const txRows = () => cli(server, "SELECT COUNT(*) FROM shop.log_nopk WHERE msg='tx'")
    const connectionTabs = page.locator('.mtab:not(.home)')
    const transactionQuestion = uiText('workspace.transactionOnClose', { name: server.name })
    await answer([1])
    await menu(app, 'file.closeConnectionTab')
    await page.waitForTimeout(500)
    check('closing with autocommit off asks about the transaction', JSON.stringify(await asked()) === JSON.stringify([transactionQuestion]), JSON.stringify(await asked()))
    check('Cancel keeps the connection tab and the transaction open', (await connectionTabs.count()) === 1 && txRows() === '0', `${await connectionTabs.count()} tab(s), ${txRows()} committed row(s)`)
    await answer([0])
    await menu(app, 'file.closeConnectionTab')
    await connectionTabs.waitFor({ state: 'detached', timeout: 5000 }).catch(() => undefined)
    check('Commit and Close commits and closes the tab', (await connectionTabs.count()) === 0 && txRows() === '1', `${JSON.stringify(await asked())} ${await connectionTabs.count()} tab(s), ${txRows()} committed row(s)`)
    check('no renderer errors', errors.length === 0, errors.join('\n'))
  } catch (e) {
    failures++
    console.log('FAIL exception', e.message)
    await shot(page, `core-${key}-exception`)
  } finally {
    // after a failure the app may still hold a transaction or edits: let quitting through
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async (_win, o) => {
        const i = o.buttons.findIndex((b) => /^(Roll Back and Close|Close Anyway|Discard Edits|Don't Save)$/.test(b))
        return { response: Math.max(i, 0), checkboxChecked: false }
      }
    }).catch(() => undefined)
    await app.close()
  }
}
console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed')
process.exit(failures ? 1 : 0)
