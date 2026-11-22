// Command line mode: `--runjob <name>` runs a saved alignment without a window, against the docker test servers.
//   pnpm build && node e2e/cli.mjs   (in the runner: e2e/docker/run.sh cli.mjs)
// A first instance of the app saves the password and two alignments in a throw-away profile and quits; then the
// binary is spawned with --runjob on that profile, as cron would. The script loads e2e/fixture-align.sql
// (dbm_test_al_src, dbm_test_al_dst) on dbm-test-mysql and drops every dbm_test_al* schema at the start and at the end.
// Cases: .claude/docs/piano-cli.md, Task 5.
import electron from 'electron'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { checker, launch, mysqlCli, profileWith, servers } from './lib.mjs'

const root = resolve(import.meta.dirname, '..')
const mysql = 'dbm-test-mysql'
const src = 'dbm_test_al_src'
const dst = 'dbm_test_al_dst'
const fixture = readFileSync(join(import.meta.dirname, 'fixture-align.sql'), 'utf8')
const mysqlConn = { ...servers.mysql, defaultSchema: '' }

function dropSchemas() {
  const schemas = mysqlCli(mysql, "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME LIKE 'dbm\\_test\\_al%'")
  for (const s of schemas.split('\n').filter(Boolean)) mysqlCli(mysql, `DROP DATABASE IF EXISTS \`${s}\``)
}
const rows = (sql) => mysqlCli(mysql, sql)
const sameOnBoth = (sql) => {
  const a = rows(sql.replaceAll('$', src))
  const b = rows(sql.replaceAll('$', dst))
  return { ok: a === b, detail: `${a}\n  vs ${b}` }
}
const tables = (schema) => rows(`SELECT GROUP_CONCAT(TABLE_NAME ORDER BY TABLE_NAME) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${schema}' AND TABLE_TYPE = 'BASE TABLE'`)
/** Columns of the target and the rows of each of its tables (CHECKSUM TABLE): changes with any DDL or write. */
const targetState = () =>
  rows(`SELECT GROUP_CONCAT(TABLE_NAME, '.', COLUMN_NAME, ' ', COLUMN_TYPE ORDER BY TABLE_NAME, ORDINAL_POSITION) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = '${dst}'`) +
  '\n' +
  rows(`CHECKSUM TABLE ${tables(dst).split(',').map((n) => `${dst}.${n}`).join(', ')}`)

const userData = profileWith([mysqlConn])
const alignmentsFile = join(userData, 'alignments.json')
const alignmentsText = () => readFileSync(alignmentsFile, 'utf8')
const lastRun = (id) => JSON.parse(alignmentsText()).find((a) => a.id === id)?.runs[0]

/** The binary with these arguments on the profile: { code, stdout, stderr }. */
const runCli = (args) =>
  new Promise((ok) => {
    // --no-sandbox: Electron runs as root in the docker runner, where without it it dies with SIGTRAP (Playwright adds it by itself)
    const child = spawn(electron, [join(root, process.env.DBM_OUT ?? 'out', 'main/index.js'), '--no-sandbox', ...args], {
      cwd: root,
      env: { ...process.env, DBM_USER_DATA: userData, DBM_TEST_HIDDEN: '1' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000)
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      ok({ code: code ?? signal, stdout, stderr })
    })
  })
const outcome = (r) => `exit ${r.code}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`

const options = { structure: true, data: true, deleteRows: true, definers: 'keep', backup: true }
const alignment = (id, objects, o = {}) => ({
  id,
  name: id,
  source: { connectionId: mysqlConn.id, schema: src },
  target: { connectionId: mysqlConn.id, schema: dst },
  objects: objects.map((name) => ({ kind: 'table', name })),
  drop: [],
  options: { ...options, ...o },
  runs: []
})
// rows only, on tables of the same structure in the fixture
const ok = alignment('cli-ok', ['big', 'storico'], { structure: false })
// ordini: qty SMALLINT in the target, INT in the source, so the table is to recreate
const recreate = alignment('cli-recreate', ['ordini'])

dropSchemas()
const result = checker()
const { check } = result
try {
  mysqlCli(mysql, fixture)
  const { app, page } = await launch(userData)
  try {
    await page.evaluate(
      async ([id, alignments]) => {
        const r = await window.api.db.open(id, { password: 'test', save: true })
        if (!r.ok) throw new Error(r.error?.message ?? 'password needed')
        await window.api.db.close(r.sessionId)
        for (const a of alignments) await window.api.alignments.save(a)
      },
      [mysqlConn.id, [ok, recreate]]
    )
  } finally {
    await app.close()
  }

  // --- 1. cli-ok --------------------------------------------------------------------------------
  // Bugs caught: argv read with the offset of the packaged app (the script path taken as the name), the last lines of
  // stdout lost because the process exits before they are flushed, the run recorded as 'app' or not at all.
  let r = await runCli(['--runjob', ok.name])
  check('cli-ok: exit 0', r.code === 0, outcome(r))
  for (const t of ['big', 'storico']) {
    const same = sameOnBoth(`SELECT GROUP_CONCAT(CONCAT_WS('|', ${t === 'big' ? 'id, v' : 'id, nome, UNIX_TIMESTAMP(ts)'}) ORDER BY id) FROM $.${t}`)
    check(`cli-ok: ${t} of the target equal to the source`, same.ok, same.detail)
  }
  let run = lastRun(ok.id)
  check('cli-ok: run recorded via cli, ok', run?.via === 'cli' && run.ok === true, JSON.stringify(run))
  const lastLine = r.stdout.trim().split('\n').at(-1)
  check('cli-ok: the last line of stdout is the final message', !!run?.message && lastLine === run.message, `${lastLine}\n  vs ${run?.message}`)

  // --- 2. cli-recreate --------------------------------------------------------------------------
  // Bugs caught: the command line confirms the recreation by itself (ordini dropped and its rows lost), or the stop is
  // not recorded and the history shows nothing of a failed cron run.
  const before = targetState()
  r = await runCli(['--runjob', recreate.name])
  check('cli-recreate: exit 1', r.code === 1, outcome(r))
  run = lastRun(recreate.id)
  check('cli-recreate: stderr names ordini', r.stderr.includes('ordini') && !!run?.message && r.stderr.includes(run.message), outcome(r))
  check('cli-recreate: target unchanged', targetState() === before, `${before}\n  vs ${targetState()}`)
  check('cli-recreate: run recorded via cli, failed', run?.via === 'cli' && run.ok === false && run.message.includes('ordini'), JSON.stringify(run))

  // --- 3. no such alignment ---------------------------------------------------------------------
  // Bug caught: a missing name taken as a failed run (exit 1, a run written to some alignment) instead of a usage error.
  const saved = alignmentsText()
  r = await runCli(['--runjob', 'missing'])
  check('missing: exit 2', r.code === 2, outcome(r))
  check('missing: alignments.json unchanged', alignmentsText() === saved)

  // --- 4. --runjob without a name ---------------------------------------------------------------
  // Bugs caught: the bare switch not seen as command line mode (the app window opens and the process never exits), or
  // its missing value looked up as a name.
  r = await runCli(['--runjob'])
  check('no name: exit 2', r.code === 2, outcome(r))
} catch (e) {
  result.failures++
  console.log('FAIL exception', e.message)
} finally {
  dropSchemas()
}
console.log(result.failures ? `\n${result.failures} failure(s)` : '\nall checks passed')
process.exit(result.failures ? 1 : 0)
