// Alignment interface (MySQL/MariaDB) against the docker test servers: the editor, the saved
// alignments with Run Now, the quick dialog of the table menu, MariaDB → MySQL.
//   pnpm build && node e2e/align.mjs
// The script loads e2e/fixture-align.sql (schemas dbm_test_al_src and dbm_test_al_dst) on both
// containers before each case and drops every dbm_test_al* schema at the start and at the end.
// The engine's error cases are in e2e/align-engine.mjs; here the paths of the interface
// (.claude/docs/piano-allineamento.md, Task 7). Pages open from the Navigator and menus with a
// right click: no Meta+… shortcut nor the application menu, which the Linux runner lacks.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { answerMessages, checker, chooseFromContextMenu, connect, launch, mysqlCli, profileWith, recordedMessages, servers, shot, uiPattern, uiText } from './lib.mjs'

const mysql = 'dbm-test-mysql'
const mariadb = 'dbm-test-mariadb'
const src = 'dbm_test_al_src'
const dst = 'dbm_test_al_dst'
/** The source schema loaded again under another name on MySQL: the target of MariaDB → MySQL. */
const mirror = 'dbm_test_al_mirror'
const fixture = readFileSync(join(import.meta.dirname, 'fixture-align.sql'), 'utf8')
// an event only in the target, which no case chooses: it must outlive every Apply
const targetEvent = `CREATE EVENT ${dst}.ev_pulizia ON SCHEDULE EVERY 1 DAY DISABLE DO DELETE FROM ${dst}.scarti WHERE id < 0`

const mysqlConn = { ...servers.mysql, defaultSchema: '' }
const mariadbConn = { ...servers.mariadb, defaultSchema: '' }

function dropSchemas() {
  for (const container of [mysql, mariadb]) {
    const schemas = mysqlCli(container, "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'dbm\\_test\\_al%'")
    for (const s of schemas.split('\n').filter(Boolean)) mysqlCli(container, `DROP DATABASE IF EXISTS \`${s}\``)
  }
}
function reset() {
  mysqlCli(mysql, fixture)
  mysqlCli(mysql, targetEvent)
}
const rows = (sql, container = mysql) => mysqlCli(container, sql)
/** The same query on the source and on the target schema ($ stands for the schema). */
const sameOnBoth = (sql) => {
  const a = rows(sql.replaceAll('$', src))
  const b = rows(sql.replaceAll('$', dst))
  return { ok: a === b, detail: `${a}\n  vs ${b}` }
}
/** The tables of the fixture with a key in both schemas, with the key to order them by. */
const keyed = { codici: 'code', big: 'id', storico: 'id', valori: 'id', utenti: 'id', scambi: 'id', ordini: 'id', listini_righe: 'id', audit: 'id' }
const sameRows = (table) => sameOnBoth(`SELECT * FROM $.${table} ORDER BY ${keyed[table]}`)
/** The rows of a table without key with their multiplicity, sorted here (GROUP_CONCAT is cut at 1024 bytes on MySQL). */
const logRows = (schema, container = mysql) =>
  rows(`SELECT CONCAT_WS('|', IFNULL(a, 'N'), IFNULL(b, 'N'), COUNT(*)) FROM ${schema}.log GROUP BY a, b`, container).split('\n').sort().join(',')
const names = (sql) => rows(sql).split(',').filter(Boolean)
const tables = (schema) => names(`SELECT GROUP_CONCAT(TABLE_NAME ORDER BY TABLE_NAME) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${schema}'`)
const triggers = (schema) => names(`SELECT GROUP_CONCAT(TRIGGER_NAME ORDER BY TRIGGER_NAME) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = '${schema}'`)
const eventKept = () => rows(`SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA = '${dst}' AND EVENT_NAME = 'ev_pulizia'`) === '1'
const backups = () => tables(dst).filter((n) => n.startsWith('dbm_al_'))

dropSchemas()
const result = checker()
const { check } = result

const { app, page, errors } = await launch(profileWith([mysqlConn, mariadbConn]))
const ws = page.locator('.workspace:visible')
const editor = () => ws.locator('.align-editor:visible')
const listPage = () => ws.locator('.editor-page:visible')
const dialog = () => page.locator('[role=dialog]')
const node = (label) => ws.locator('.node', { has: page.locator('.label', { hasText: new RegExp(`^${label}$`) }) }).first()
const button = (scope, key, params) => scope.getByRole('button', { name: uiText(key, params), exact: true })
const text = async (locator) => (await locator.innerText()).replace(/ /g, ' ')
/** Every job log, for the check on secrets. */
const logs = []

/** Opens the Alignment page from the Navigator's Administration list. */
async function openAlignPage() {
  await button(ws, 'navigator.administration').click()
  await ws.locator('.admin-item', { hasText: uiText('workspace.admin.align') }).click()
  await listPage().locator('.page-header', { hasText: uiText('workspace.admin.align') }).first().waitFor()
}

/** Chooses source and target schema in the editor (connections left as they are). */
async function chooseSchemas(source, target) {
  const e = editor()
  const select = (key) => e.locator(`select[aria-label="${uiText(key)}"]`)
  for (const [key, schema] of [
    ['admin.align.sourceSchema', source],
    ['admin.align.targetSchema', target]
  ]) {
    await select(key).locator('option', { hasText: new RegExp(`^${schema}$`) }).waitFor({ state: 'attached' })
    await select(key).selectOption(schema)
  }
}

const option = (key) => editor().locator('label.check', { hasText: uiText(key) }).locator('input')

/** Waits for the end of the editor's Compare: the button enabled again; returns whether the comparison is there. */
async function compared() {
  const e = editor()
  await page.waitForTimeout(300)
  for (const end = Date.now() + 120000; ; ) {
    const again = button(e, 'admin.align.compareAgain')
    if ((await again.count()) && (await again.isEnabled())) return true
    const first = button(e, 'admin.align.compare')
    if ((await first.count()) && (await first.isEnabled()) && (await e.locator('.foot .status.error').count())) return false
    if (Date.now() > end) throw new Error(`compare did not end: ${await text(e.locator('.foot .status'))}`)
    await page.waitForTimeout(250)
  }
}

async function compare() {
  const e = editor()
  const again = button(e, 'admin.align.compareAgain')
  await ((await again.count()) ? again : button(e, 'admin.align.compare')).click()
  return compared()
}

/**
 * Waits for the end of an Apply whose status line is `status` and log `log`: the done message,
 * or an error other than needsConfirmation (after which runAlignment asks and starts again).
 * Returns { failed, status, log }.
 */
async function jobEnd(status, log, running) {
  await page.waitForTimeout(300)
  const done = [uiPattern('tools.align.done'), uiPattern('tools.align.doneBackupsLeft')]
  let last = ''
  let since = Date.now()
  for (const end = Date.now() + 180000; ; ) {
    const now = (await status.count()) ? await text(status) : ''
    if (now !== last) [last, since] = [now, Date.now()]
    const failed = (await status.count()) && (await status.evaluate((el) => el.classList.contains('error')))
    const busy = await running()
    if (!busy && done.some((p) => p.test(now))) break
    if (!busy && failed && now !== uiText('tools.align.needsConfirmation') && Date.now() - since > 1500) break
    if (Date.now() > end) throw new Error(`job did not end: ${now}`)
    await page.waitForTimeout(250)
  }
  const shown = (await log.count()) ? await text(log) : ''
  logs.push(shown)
  return { failed: await status.evaluate((el) => el.classList.contains('error')), status: await text(status), log: shown }
}

const applyInEditor = async () => {
  const e = editor()
  await button(e, 'admin.align.apply').click()
  return jobEnd(e.locator('.foot .status'), e.locator('.foot .log'), async () => (await button(e, 'common.cancel').count()) > 0)
}

/** The rows of the editor's comparison as shown: name, type, status, action, checked, counts. */
const shownRows = () =>
  editor()
    .locator('.objects tbody tr')
    .evaluateAll((trs) =>
      trs.map((tr) => {
        const td = [...tr.querySelectorAll('td')].map((c) => c.textContent.trim())
        return { name: td[1], type: td[2], status: td[3], action: td[4], checked: tr.querySelector('input').checked, counts: td.slice(6).filter(Boolean).join(' ') }
      })
    )
const rowOf = (list, name) => list.find((r) => r.name === name)

/** Shows (false) or hides (true) the identical objects. */
const hideSame = (on) =>
  editor()
    .locator('label.check', { hasText: new RegExp(uiPattern('admin.align.hideSame').source.slice(1, -1)) })
    .locator('input')
    .setChecked(on)

const backToList = async () => {
  await editor().getByRole('button', { name: uiText('admin.align.backToList') }).click()
  await editor().waitFor({ state: 'detached' })
}

/** Messages of the native boxes recorded since `from`. */
const messagesSince = async (from) => (await recordedMessages(app)).slice(from)
/** The confirmation of the recreations and drops in `target`. */
const isRecreateConfirm = (m) => m.startsWith(uiText('admin.align.confirm.title', { schema: dst }))

try {
  await answerMessages(app)
  reset()
  await connect(page, mysqlConn)
  await openAlignPage()
  check('page: no saved alignment yet', (await listPage().locator('.items .item').count()) === 0)

  // --- 1. editor, same MySQL instance ---------------------------------------------------------
  await button(listPage(), 'admin.align.newAlignment').click()
  await editor().waitFor()
  await chooseSchemas(src, dst)
  await option('admin.align.deleteRows').check()
  check('editor: compare finished', await compare(), await text(editor().locator('.foot .status')))
  await shot(page, 'align-01-compare')
  let shown = await shownRows()
  // audit is the one object the same on both sides
  check('editor: identical objects hidden', !rowOf(shown, 'audit') && (await text(editor().locator('.filters'))).includes(uiText('admin.align.hideSame', { count: 1 })), JSON.stringify(shown.map((r) => r.name)))
  const listini = rowOf(shown, 'listini_righe')
  check(
    'editor: listini_righe, rows only differing, shown, different and chosen',
    listini?.status === uiText('admin.align.status.different') && listini.checked && listini.action === uiText('admin.align.action.syncRows'),
    JSON.stringify(listini)
  )
  const counts = Object.fromEntries(['listini_righe', 'utenti', 'scambi', 'codici', 'big', 'storico'].map((n) => [n, rowOf(shown, n)?.counts]))
  check(
    'editor: row counts of the tables to sync',
    JSON.stringify(counts) === JSON.stringify({ listini_righe: '+1 ~1', utenti: '+1 1', scambi: '~2', codici: '~1', big: '~1', storico: '~1' }),
    JSON.stringify(counts)
  )
  const ordini = rowOf(shown, 'ordini')
  check('editor: ordini of another structure to recreate', ordini?.action === uiText('admin.align.action.recreate') && ordini.checked, JSON.stringify(ordini))
  const targetOnly = ['figlio', 'scarti', 'ev_pulizia', 'vecchio_trg'].map((n) => rowOf(shown, n))
  check(
    'editor: objects only in the target listed, not chosen',
    targetOnly.every((r) => r?.status === uiText('admin.align.status.targetOnly') && !r.checked),
    JSON.stringify(targetOnly)
  )
  await hideSame(false)
  const audit = rowOf(await shownRows(), 'audit')
  check('editor: audit identical when shown', audit?.status === uiText('admin.align.status.same') && !audit.checked, JSON.stringify(audit))
  await hideSame(true)

  // padre recreated from the source loses the key 3 that figlio (only in the target, not chosen) refers to:
  // the Apply would fail on orphans, as it should; it is left out. scambi swaps UNIQUE values, which
  // Delete rows only in target (checked above) rewrites as a whole: without it the job stops on uniqueConflict.
  await editor().locator(`input[aria-label="${uiText('admin.align.alignObject', { name: 'padre' })}"]`).uncheck()
  // chosen: codici, big, storico, log, valori, utenti, scambi, ordini, listini_righe, ordini_bu, v_ordini, f_doppio
  check(
    'editor: totals of the objects chosen',
    (await text(editor().locator('.foot .status'))) === uiText('admin.align.totals', { count: 12, insert: 2, update: 6, delete: 1 }),
    await text(editor().locator('.foot .status'))
  )
  let from = (await recordedMessages(app)).length
  let outcome = await applyInEditor()
  check('editor: apply finished', !outcome.failed, `${outcome.status}\n${outcome.log}`)
  let asked = await messagesSince(from)
  check(
    'editor: Apply asked to confirm the recreation of ordini',
    asked.length === 1 && isRecreateConfirm(asked[0]) && asked[0].includes(uiText('admin.align.confirm.recreateRows', { name: 'ordini', target: 1, source: 2 })),
    asked.join('\n')
  )
  await shot(page, 'align-02-applied')
  for (const table of ['codici', 'big', 'storico', 'valori', 'utenti', 'scambi', 'ordini', 'listini_righe']) {
    const same = sameRows(table)
    check(`editor: ${table} of the target equal to the source`, same.ok, same.detail)
  }
  check('editor: log holds the rows of the source', logRows(dst) === logRows(src), `${logRows(dst)} vs ${logRows(src)}`)
  check('editor: the event only in the target still exists', eventKept())
  check('editor: padre and figlio, not chosen, untouched', rows(`SELECT GROUP_CONCAT(id ORDER BY id) FROM ${dst}.padre`) === '0,1,2,3' && tables(dst).includes('figlio'))
  check('editor: no dbm_al_ table left', backups().length === 0, backups().join(', '))
  await backToList()

  // --- 3. saved with a restricted list, Compare, Run Now -------------------------------------------
  reset()
  const saved = ['codici', 'utenti', 'scambi', 'ordini', 'listini_righe', 'log']
  await button(listPage(), 'admin.align.newAlignment').click()
  await editor().waitFor()
  await chooseSchemas(src, dst)
  await option('admin.align.deleteRows').check()
  check('saved: compare finished', await compare())
  for (const r of await shownRows()) {
    await editor().locator(`input[aria-label="${uiText(r.status === uiText('admin.align.status.targetOnly') ? 'admin.align.dropObject' : 'admin.align.alignObject', { name: r.name })}"]`).setChecked(saved.includes(r.name))
  }
  await button(editor(), 'common.save').click()
  await dialog().locator('input').first().fill('dbm al e2e')
  await page.keyboard.press('Enter')
  await dialog().waitFor({ state: 'detached' })
  await backToList()
  const item = listPage().locator('.items .item', { hasText: 'dbm al e2e' })
  check('saved: the alignment in the list, never run', (await item.count()) === 1 && (await text(item)).includes(uiText('admin.align.neverRun')))
  check('saved: the detail lists the 6 objects', (await text(listPage().locator('.detail'))).includes(uiText('admin.align.objectsCount', { count: 6 })))

  await button(listPage().locator('.detail'), 'admin.align.compare').click()
  await editor().waitFor()
  check('saved: Compare from the list finished', await compared())
  await hideSame(false)
  shown = await shownRows()
  const wrong = shown.filter((r) => r.checked !== saved.includes(r.name))
  check('saved: the choice is the saved list, nothing added', wrong.length === 0 && !(await editor().locator('label.check', { hasText: uiText('admin.align.allObjects') }).locator('input').isChecked()), JSON.stringify(wrong))
  await shot(page, 'align-03-saved-compare')
  await backToList()

  from = (await recordedMessages(app)).length
  const detail = listPage().locator('.detail')
  await button(detail, 'admin.align.runNow').click()
  outcome = await jobEnd(detail.locator('.progress-section .status'), detail.locator('.progress-section .log'), async () => (await button(detail, 'common.cancel').count()) > 0)
  check('run now: finished', !outcome.failed, `${outcome.status}\n${outcome.log}`)
  asked = await messagesSince(from)
  check('run now: asked to confirm the recreation of ordini', asked.length === 1 && isRecreateConfirm(asked[0]) && asked[0].includes('ordini'), asked.join('\n'))
  const runs = await detail.locator('.runs tbody tr').allInnerTexts()
  check('run now: one run in the history, succeeded', runs.length === 1 && runs[0].includes(uiText('admin.align.succeeded')) && runs[0].includes(uiText('admin.align.viaApp')), runs.join('\n'))
  check('run now: the list shows the last run', !(await text(item)).includes(uiText('admin.align.neverRun')))
  await shot(page, 'align-04-run-now')

  await button(detail, 'admin.align.compare').click()
  await editor().waitFor()
  check('second compare: finished', await compared())
  await hideSame(false)
  shown = await shownRows()
  const status = Object.fromEntries(saved.map((n) => [n, rowOf(shown, n)?.status]))
  check(
    'second compare: the saved objects with a key identical, log (no key) different by rule',
    saved.every((n) => status[n] === uiText(n === 'log' ? 'admin.align.status.different' : 'admin.align.status.same')),
    JSON.stringify(status)
  )
  await backToList()

  // --- 4. quick version from the table menu ----------------------------------------------------------
  reset()
  await button(ws, 'navigator.schemas').click()
  await ws.getByRole('button', { name: uiText('navigator.refreshAll') }).click()
  await node(src).locator('.twisty').waitFor()
  await node(src).locator('.twisty').dispatchEvent('mousedown')
  await node('Tables').locator('.twisty').dispatchEvent('mousedown')
  await node('listini_righe').waitFor()
  const others = Object.keys(keyed).filter((n) => n !== 'listini_righe')
  const othersBefore = rows(`CHECKSUM TABLE ${[...others, 'padre', 'figlio', 'log', 'scarti'].map((n) => `${dst}.${n}`).join(', ')}`)
  const triggersBefore = triggers(dst).join(',')
  await chooseFromContextMenu(app, 'align')
  await node('listini_righe').dispatchEvent('contextmenu')
  await dialog().locator('.title, header, h2', { hasText: uiText('admin.align.dialog.title', { schema: src }) }).first().waitFor()
  // the objects of the schema arrive after the dialog opens
  await dialog().locator('label.check.item').first().waitFor()
  const checkedItems = await dialog().locator('label.check.item').evaluateAll((ls) => ls.filter((l) => l.querySelector('input').checked).map((l) => l.textContent.trim()))
  check('quick: only listini_righe chosen', JSON.stringify(checkedItems) === '["listini_righe"]', JSON.stringify(checkedItems))
  await dialog().locator('#ad-schema option', { hasText: new RegExp(`^${dst}$`) }).waitFor({ state: 'attached' })
  check('quick: the source schema is not a target', (await dialog().locator('#ad-schema option', { hasText: new RegExp(`^${src}$`) }).count()) === 0)
  await dialog().locator('#ad-schema').selectOption(dst)
  from = (await recordedMessages(app)).length
  await button(dialog(), 'admin.align.dialog.align').click()
  outcome = await jobEnd(dialog().locator('.run .status'), dialog().locator('.run .log'), async () => (await button(dialog(), 'common.cancel').count()) > 0)
  check('quick: align finished', !outcome.failed, `${outcome.status}\n${outcome.log}`)
  await shot(page, 'align-05-quick')
  check('quick: no confirmation (no recreation)', (await messagesSince(from)).length === 0, (await messagesSince(from)).join('\n'))
  const same = sameRows('listini_righe')
  check('quick: listini_righe equal to the source', same.ok, same.detail)
  const othersAfter = rows(`CHECKSUM TABLE ${[...others, 'padre', 'figlio', 'log', 'scarti'].map((n) => `${dst}.${n}`).join(', ')}`)
  check('quick: no other table of the target changed', othersAfter === othersBefore, `${othersBefore}\n  vs ${othersAfter}`)
  check('quick: triggers of the target kept, not fired', triggers(dst).join(',') === triggersBefore && rows(`SELECT COUNT(*) FROM ${dst}.audit`) === '0', triggers(dst).join(','))
  check('quick: the source schema unchanged', tables(src).includes('listini_righe') && !tables(dst).includes('valori'))
  await button(dialog(), 'common.close').click()
  await dialog().waitFor({ state: 'detached' })

  // --- 2. MariaDB → MySQL between two connections --------------------------------------------------
  mysqlCli(mariadb, fixture)
  mysqlCli(mysql, fixture.replaceAll(src, mirror))
  await page.locator('.mtab.home').dispatchEvent('mousedown')
  await connect(page, mariadbConn)
  await openAlignPage()
  await button(listPage(), 'admin.align.newAlignment').click()
  await editor().waitFor()
  await editor().locator(`select[aria-label="${uiText('admin.align.targetConnection')}"]`).selectOption({ label: mysqlConn.name })
  await page.locator('[role=dialog] input[type=password]').fill('test')
  await page.keyboard.press('Enter')
  await chooseSchemas(src, mirror)
  check('mariadb → mysql: compare finished', await compare(), await text(editor().locator('.foot .status')))
  await hideSame(false)
  shown = await shownRows()
  const tableKind = uiText('admin.align.kind.table')
  const differing = shown.filter((r) => r.type === tableKind && r.name !== 'log' && r.status !== uiText('admin.align.status.same'))
  check('mariadb → mysql: no table different for its representation only', differing.length === 0, JSON.stringify(differing))
  check('mariadb → mysql: log, without key, different by rule', rowOf(shown, 'log')?.status === uiText('admin.align.status.different'), JSON.stringify(rowOf(shown, 'log')))
  await shot(page, 'align-06-mariadb-compare')
  outcome = await applyInEditor()
  check('mariadb → mysql: apply finished', !outcome.failed, `${outcome.status}\n${outcome.log}`)
  check('mariadb → mysql: log holds the rows of the source', logRows(mirror) === logRows(src, mariadb), `${logRows(mirror)} vs ${logRows(src, mariadb)}`)
  await shot(page, 'align-07-mariadb-applied')

  // --- 5. secrets ----------------------------------------------------------------------------------
  const all = logs.join('\n')
  check('log: job logs collected', logs.length === 4 && logs.every(Boolean), JSON.stringify(logs.map((l) => l.length)))
  check('log: no password', !/\btest\b/.test(all) && !/password/i.test(all), all)

  const boxes = await recordedMessages(app)
  check('only the expected message boxes (two confirmations)', boxes.length === 2, boxes.join('\n'))
  check('no renderer errors', errors.length === 0, errors.join('\n'))
} catch (e) {
  result.failures++
  console.log('FAIL exception', e.message)
  await shot(page, 'align-exception')
} finally {
  await app.close()
  dropSchemas()
}
console.log(result.failures ? `\n${result.failures} failure(s)` : '\nall checks passed')
process.exit(result.failures ? 1 : 0)
