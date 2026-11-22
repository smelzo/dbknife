// Alignment engine (MySQL/MariaDB) against the docker test servers, without the interface:
// the jobs are started through window.api and their end awaited from tools:progress.
//   pnpm build && node e2e/align-engine.mjs
// The script loads e2e/fixture-align.sql (schemas dbm_test_al_src and dbm_test_al_dst) on both
// containers before each case and drops every dbm_test_al* schema at the start and at the end.
// Cases: .claude/docs/piano-allineamento.md, Task 3, "e2e del motore".
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { checker, launch, mysqlCli, profileWith, servers, uiPattern, uiText } from './lib.mjs'

const mysql = 'dbm-test-mysql'
const mariadb = 'dbm-test-mariadb'
const src = 'dbm_test_al_src'
const dst = 'dbm_test_al_dst'
const fixture = readFileSync(join(import.meta.dirname, 'fixture-align.sql'), 'utf8')

// no default schema: the job's sessions open on any server state
const mysqlConn = { ...servers.mysql, defaultSchema: '' }
const mariadbConn = { ...servers.mariadb, defaultSchema: '' }
// another saved connection to the same container, for the identity check
const mysqlAlias = { ...mysqlConn, id: 'test-mysql-alias', name: 'Test/MySQL 8.4 (alias)' }

function dropSchemas() {
  for (const container of [mysql, mariadb]) {
    const schemas = mysqlCli(container, "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'dbm\\_test\\_al%'")
    for (const s of schemas.split('\n').filter(Boolean)) mysqlCli(container, `DROP DATABASE IF EXISTS \`${s}\``)
  }
}
const reset = (container = mysql) => mysqlCli(container, fixture)
const rows = (sql, container = mysql) => mysqlCli(container, sql)
/** The same query on the source and on the target schema ($ stands for the schema). */
const sameOnBoth = (sql, container = mysql) => {
  const a = rows(sql.replaceAll('$', src), container)
  const b = rows(sql.replaceAll('$', dst), container)
  return { ok: a === b, detail: `${a}\n  vs ${b}` }
}
const tables = (schema) => rows(`SELECT GROUP_CONCAT(TABLE_NAME ORDER BY TABLE_NAME) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${schema}'`)
const triggers = (schema) => rows(`SELECT GROUP_CONCAT(TRIGGER_NAME ORDER BY TRIGGER_NAME) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = '${schema}'`)
/** Columns and triggers of a schema: changes with any DDL on its tables. */
const structure = (schema) =>
  rows(`SELECT GROUP_CONCAT(TABLE_NAME, '.', COLUMN_NAME, ' ', COLUMN_TYPE ORDER BY TABLE_NAME, ORDINAL_POSITION) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = '${schema}'`) +
  ' | ' +
  triggers(schema)
/** Row contents of the target's tables (CHECKSUM TABLE: a change of any row changes it). */
const contents = (names) => rows(`CHECKSUM TABLE ${names.map((n) => `${dst}.${n}`).join(', ')}`)
const backups = () => tables(dst).split(',').filter((n) => n.startsWith('dbm_al_'))

dropSchemas()
const result = checker()
const { check } = result
const userData = profileWith([mysqlConn, mariadbConn, mysqlAlias])
const recoveryDir = join(userData, 'alignments', 'recovery')
const recoveryFiles = () => (existsSync(recoveryDir) ? readdirSync(recoveryDir) : [])
const { app, page, errors } = await launch(userData)

/** Opens a session of a saved connection (password test); returns its id. */
async function open(connectionId) {
  const r = await page.evaluate((id) => window.api.db.open(id, { password: 'test' }), connectionId)
  if (!r.ok) throw new Error(`${connectionId}: ${r.error?.message}`)
  return r.sessionId
}

/** Runs alignCompare/alignApply and waits for the end: { error, message, preview, logs }. */
const run = (kind, request) =>
  page.evaluate(
    ([kind, request]) =>
      new Promise((resolve) => {
        let id
        let preview
        const logs = []
        const early = []
        const handle = (p) => {
          if (p.jobId !== id) return
          if (p.preview) preview = p.preview
          if (p.log) logs.push(p.log)
          if (p.done) {
            off()
            resolve({ error: p.error, message: p.message, preview, logs })
          }
        }
        const off = window.api.tools.onProgress((p) => (id === undefined ? early.push(p) : handle(p)))
        window.api.tools[kind](request).then((jobId) => {
          id = jobId
          early.forEach(handle)
        })
      }),
    [kind, request]
  )

const options = { structure: true, data: true, deleteRows: true, definers: 'keep', backup: true }
const table = (name) => ({ kind: 'table', name })
let sessions
const request = (o = {}) => ({
  source: { sessionId: sessions.mysql, schema: src },
  target: { sessionId: sessions.mysql, schema: dst },
  objects: null,
  drop: [],
  ...o,
  options: { ...options, ...o.options }
})
const object = (r, name) => r.preview?.objects.find((o) => o.name === name)
const rowsOf = (r, name) => JSON.stringify(object(r, name)?.rows)
const outcome = (r) => `${r.error ?? r.message}\n${r.logs.join('\n')}`

let mariadbZone
try {
  reset()
  reset(mariadb)
  sessions = { mysql: await open(mysqlConn.id), mariadb: await open(mariadbConn.id), alias: await open(mysqlAlias.id) }

  // --- 1. keys: latin1 key equal for its collation, BIGINT UNSIGNED near 2^64 ------------------
  let r = await run('alignCompare', request({ objects: [table('codici'), table('big')] }))
  check('keys: compare finished', !r.error, outcome(r))
  check("keys: 'abc' and 'ABC ' are the same key, one update", rowsOf(r, 'codici') === '{"insert":0,"update":1,"delete":0}', rowsOf(r, 'codici'))
  check('keys: 18446744073709551614 matches itself only, one update', rowsOf(r, 'big') === '{"insert":0,"update":1,"delete":0}', rowsOf(r, 'big'))
  r = await run('alignApply', request({ objects: [table('codici'), table('big')] }))
  check('keys: apply finished', !r.error, outcome(r))
  check('keys: codici holds the source key', rows(`SELECT CONCAT('[', GROUP_CONCAT(code), ']') FROM ${dst}.codici`) === '[abc]', rows(`SELECT * FROM ${dst}.codici`))
  let same = sameOnBoth('SELECT GROUP_CONCAT(id, ":", v ORDER BY id) FROM $.big')
  check('keys: big equal to the source', same.ok, same.detail)

  // --- 2. timestamps: ON UPDATE keeps the source value; MariaDB +02:00 → MySQL ----------------
  reset()
  r = await run('alignApply', request({ objects: [table('storico')] }))
  check('timestamp: apply finished', !r.error, outcome(r))
  same = sameOnBoth('SELECT CONCAT(nome, " ", UNIX_TIMESTAMP(ts)) FROM $.storico')
  check('timestamp: only nome changed, ts kept the historic value', same.ok, same.detail)

  // MariaDB and MySQL describe the same fixture alike: every table with a key is the same (log has none)
  reset()
  reset(mariadb)
  r = await run('alignCompare', request({ source: { sessionId: sessions.mariadb, schema: src }, target: { sessionId: sessions.mysql, schema: src } }))
  check('cross flavor: compare finished', !r.error, outcome(r))
  const differing = (r.preview?.objects ?? []).filter((o) => o.kind === 'table' && o.name !== 'log' && o.status !== 'same')
  check('cross flavor: no table different for its representation only', differing.length === 0, JSON.stringify(differing.map((o) => [o.name, o.status, o.notes, o.rows])))

  mariadbZone = rows('SELECT @@GLOBAL.time_zone', mariadb)
  rows("SET GLOBAL time_zone = '+02:00'", mariadb)
  r = await run('alignApply', request({ source: { sessionId: sessions.mariadb, schema: src }, objects: [table('storico')] }))
  check('timestamp across servers: apply finished', !r.error, outcome(r))
  const instant = (container, schema) => rows(`SELECT CONCAT(nome, ' ', UNIX_TIMESTAMP(ts)) FROM ${schema}.storico`, container)
  check('timestamp across servers: same instant on both sides', instant(mariadb, src) === instant(mysql, dst), `${instant(mariadb, src)} vs ${instant(mysql, dst)}`)
  rows(`SET GLOBAL time_zone = '${mariadbZone}'`, mariadb)
  mariadbZone = undefined

  // --- 3. a table without key: the whole content, duplicates and NULLs included ---------------
  reset()
  r = await run('alignApply', request({ objects: [table('log')] }))
  check('no key: apply finished', !r.error, outcome(r))
  same = sameOnBoth('SELECT GROUP_CONCAT(CONCAT_WS("|", IFNULL(a, "N"), IFNULL(b, "N"), n) ORDER BY a, b) FROM (SELECT a, b, COUNT(*) AS n FROM $.log GROUP BY a, b) x')
  check('no key: the same rows with the same multiplicity', same.ok, same.detail)

  // --- 4. expression defaults with values of their own, a generated column -------------------
  r = await run('alignApply', request({ objects: [table('valori')] }))
  check('defaults: apply finished', !r.error, outcome(r))
  same = sameOnBoth('SELECT GROUP_CONCAT(id, "|", creato, "|", n, "|", m, "|", g ORDER BY id) FROM $.valori')
  check('defaults: historic DEFAULT CURRENT_TIMESTAMP, DEFAULT (n + 1) value and generated column as in the source', same.ok, same.detail)

  // --- 5. UNIQUE values freed by deletes, exchanged between rows; refused without deleteRows ---
  reset()
  r = await run('alignApply', request({ objects: [table('utenti'), table('scambi')] }))
  check('unique: apply with deleteRows finished', !r.error, outcome(r))
  same = sameOnBoth('SELECT CONCAT((SELECT GROUP_CONCAT(id, email ORDER BY id) FROM $.utenti), " / ", (SELECT GROUP_CONCAT(id, email ORDER BY id) FROM $.scambi))')
  check('unique: utenti and scambi equal to the source', same.ok, same.detail)
  reset()
  r = await run('alignApply', request({ objects: [table('scambi')], options: { deleteRows: false } }))
  check('unique: without deleteRows the job stops on uniqueConflict', !!r.error && uiPattern('tools.align.uniqueConflict', { table: 'scambi' }).test(r.error), outcome(r))
  check('unique: target unchanged', rows(`SELECT GROUP_CONCAT(id, email ORDER BY id) FROM ${dst}.scambi`) === '1y,2x', rows(`SELECT * FROM ${dst}.scambi`))

  // --- 6. orphans and recovery ---------------------------------------------------------------
  reset()
  // the structure as information_schema describes it: SHOW CREATE TABLE of MySQL writes a column of the table
  // created again from its own text with CHARACTER SET before COLLATE
  const padre = () =>
    [
      `SELECT GROUP_CONCAT(CONCAT_WS(' ', COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, IFNULL(COLUMN_DEFAULT, 'NULL'), EXTRA, IFNULL(COLLATION_NAME, '-')) ORDER BY ORDINAL_POSITION) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = '${dst}' AND TABLE_NAME = 'padre'`,
      `SELECT GROUP_CONCAT(CONCAT_WS(' ', INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME) ORDER BY INDEX_NAME, SEQ_IN_INDEX) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = '${dst}' AND TABLE_NAME = 'padre'`,
      `SELECT GROUP_CONCAT(CONCAT_WS(' ', cc.CONSTRAINT_NAME, cc.CHECK_CLAUSE) ORDER BY cc.CONSTRAINT_NAME) FROM information_schema.CHECK_CONSTRAINTS cc JOIN information_schema.TABLE_CONSTRAINTS tc ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME WHERE tc.TABLE_SCHEMA = '${dst}' AND tc.TABLE_NAME = 'padre'`,
      `SELECT CONCAT_WS(' ', ENGINE, TABLE_COLLATION) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${dst}' AND TABLE_NAME = 'padre'`
    ]
      .map((sql) => rows(sql))
      .join(' | ')
  const padreBefore = padre()
  r = await run('alignApply', request({ objects: [table('padre')] }))
  check('orphans: without confirmation the job stops on needsConfirmation', r.error === uiText('tools.align.needsConfirmation'), outcome(r))
  check('orphans: the preview comes with needsConfirmation', object(r, 'padre')?.action === 'recreate', JSON.stringify(object(r, 'padre')))
  check('orphans: nothing changed without confirmation', padre() === padreBefore && backups().length === 0)
  r = await run('alignApply', request({ objects: [table('padre')], confirmed: { recreate: [table('padre')], drop: [] } }))
  check('orphans: job failed on orphans', !!r.error && uiPattern('tools.align.orphans').test(r.error) && r.error.includes('figlio_padre'), outcome(r))
  check('orphans: padre has its structure again', padre() === padreBefore, padre())
  check('orphans: padre has its rows again', rows(`SELECT GROUP_CONCAT(id, nome ORDER BY id) FROM ${dst}.padre`) === '0zero,1uno,2due,3tre', rows(`SELECT * FROM ${dst}.padre`))
  check('orphans: padre_bi exists again', triggers(dst).split(',').includes('padre_bi'), triggers(dst))
  check('orphans: no dbm_al_ table left', backups().length === 0, backups().join(', '))
  check('orphans: no recovery file left', recoveryFiles().length === 0, recoveryFiles().join(', '))

  // --- 7. triggers: kept on a recreated table, dropped when asked, not fired by the writes -----
  reset()
  r = await run(
    'alignApply',
    request({
      objects: [table('ordini'), { kind: 'trigger', name: 'ordini_bu' }, table('listini_righe')],
      drop: [{ kind: 'trigger', name: 'vecchio_trg' }],
      confirmed: { recreate: [table('ordini')], drop: [{ kind: 'trigger', name: 'vecchio_trg' }] }
    })
  )
  check('triggers: apply finished', !r.error, outcome(r))
  const names = triggers(dst).split(',')
  check('triggers: ordini_bi of the target kept on the recreated ordini', names.includes('ordini_bi'), names.join(', '))
  check('triggers: ordini_bu of the source created', names.includes('ordini_bu'), names.join(', '))
  check('triggers: vecchio_trg dropped', !names.includes('vecchio_trg'), names.join(', '))
  check('triggers: listini_righe_ai and _au kept', names.includes('listini_righe_ai') && names.includes('listini_righe_au'), names.join(', '))
  check('triggers: the writes did not fire them (audit empty)', rows(`SELECT COUNT(*) FROM ${dst}.audit`) === '0')
  same = sameOnBoth('SELECT GROUP_CONCAT(id, "|", IFNULL(qty, "N"), "|", IFNULL(note, "N") ORDER BY id) FROM $.ordini')
  check('triggers: ordini rows as in the source', same.ok, same.detail)
  same = sameOnBoth('SELECT GROUP_CONCAT(id, "|", prezzo ORDER BY id) FROM $.listini_righe')
  check('triggers: listini_righe rows as in the source', same.ok, same.detail)
  check('triggers: no dbm_al_ table left', backups().length === 0, backups().join(', '))
  r = await run('alignCompare', request({ objects: [table('ordini')] }))
  check('triggers: ordini recreated from the source compares the same', object(r, 'ordini')?.status === 'same', JSON.stringify(object(r, 'ordini')))

  // --- 8. identity: another saved connection to the same server and schema --------------------
  reset()
  const before = structure(src) + contents(['codici', 'padre', 'ordini'])
  r = await run('alignApply', request({ target: { sessionId: sessions.alias, schema: src }, confirmed: { recreate: [], drop: [] } }))
  check('identity: same schema through another connection refused', r.error === uiText('tools.align.sameSchema', { schema: src }), outcome(r))
  check('identity: tables intact', structure(src) + contents(['codici', 'padre', 'ordini']) === before)

  // --- 9. options ----------------------------------------------------------------------------
  reset()
  let shape = structure(dst)
  r = await run('alignApply', request({ options: { structure: false } }))
  check('data only: apply finished', !r.error, outcome(r))
  check('data only: no DDL', structure(dst) === shape, `${shape}\n  vs ${structure(dst)}`)
  const ordini = object(r, 'ordini')
  check('data only: ordini skipped with structureDiffers', ordini?.action === 'skip' && ordini.notes.some((n) => n.code === 'structureDiffers'), JSON.stringify(ordini))
  same = sameOnBoth('SELECT GROUP_CONCAT(id, ":", v ORDER BY id) FROM $.big')
  check('data only: rows of the tables of the same structure aligned', same.ok, same.detail)

  reset()
  const existing = tables(dst).split(',')
  const contentsBefore = contents(existing)
  r = await run('alignApply', request({ options: { data: false } }))
  check('structure only: apply finished', !r.error, outcome(r))
  check('structure only: no row of the existing tables changed', contents(existing) === contentsBefore, `${contentsBefore}\n  vs ${contents(existing)}`)
  check('structure only: valori created empty', rows(`SELECT COUNT(*) FROM ${dst}.valori`) === '0')
  check('structure only: view and function of the source', rows(`SELECT ${dst}.f_doppio(2)`) === '4' && rows(`SELECT COUNT(*) FROM ${dst}.v_ordini`) === '1')

  reset()
  shape = structure(dst)
  const others = existing.filter((n) => n !== 'scarti')
  const othersBefore = contents(others)
  r = await run('alignApply', request({ objects: [], drop: [table('scarti')], confirmed: { recreate: [], drop: [table('scarti')] } }))
  check('drop only: apply finished', !r.error, outcome(r))
  check('drop only: scarti dropped', !tables(dst).split(',').includes('scarti'), tables(dst))
  check('drop only: nothing else changed', contents(others) === othersBefore && structure(dst) === shape.replace(/,?scarti\.id int/, ''), `${shape}\n  vs ${structure(dst)}`)
  check('drop only: no dbm_al_ table left', backups().length === 0, backups().join(', '))

  // --- 10. concurrency: the target lock held by another client --------------------------------
  const holder = spawn('docker', ['exec', '-i', mysql, 'mysql', '-uroot', '-ptest', '-N', '-e', `SELECT GET_LOCK('dbm_align:${dst}', 0), SLEEP(30)`], { stdio: 'ignore' })
  for (let i = 0; i < 40 && rows(`SELECT IS_USED_LOCK('dbm_align:${dst}') IS NOT NULL`) !== '1'; i++) await page.waitForTimeout(250)
  r = await run('alignApply', request({ objects: [table('codici')] }))
  check('concurrency: a second alignment of the same target is busy', r.error === uiText('tools.align.busy', { schema: dst }), outcome(r))
  const owner = rows(`SELECT IS_USED_LOCK('dbm_align:${dst}')`)
  if (owner && owner !== 'NULL') rows(`KILL ${Number(owner)}`)
  holder.kill()

  check('no renderer errors', errors.length === 0, errors.join('\n'))
} catch (e) {
  result.failures++
  console.log('FAIL exception', e.message)
} finally {
  if (mariadbZone) rows(`SET GLOBAL time_zone = '${mariadbZone}'`, mariadb)
  await app.close()
  dropSchemas()
}
console.log(result.failures ? `\n${result.failures} failure(s)` : '\nall checks passed')
process.exit(result.failures ? 1 : 0)
