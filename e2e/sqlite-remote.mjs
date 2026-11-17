// End-to-end check of a SQLite database on another machine, opened through an SSH channel:
// channel dialog, upload of the helper, remote file tree, remote session.
//   pnpm exec electron-vite build && node e2e/sqlite-remote.mjs
// The destination comes from the environment; without variables it is the dbm-test-ssh
// container (sshd on 127.0.0.1:32222, root/test: Linux, password):
//   DBM_REMOTE_HOST, DBM_REMOTE_PORT (22), DBM_REMOTE_USER, DBM_REMOTE_KEY
//     a machine reached with a key file without passphrase; when the host is not 127.0.0.1
//     the app reaches it through tcpRelay (lib.mjs)
//   DBM_REMOTE_DB
//     absolute path of a database already on the destination, which is never modified:
//     the checks are those of a large database, against sqlite3 run on that machine
// Without DBM_REMOTE_DB the database is built from e2e/fixture-sqlite.sql and copied to /tmp
// of the destination, where the script removes it at the end. The helper stays in
// ~/.cache/dbknife of the destination, as the app leaves it.
// With the container as destination a second channel follows a host of an SSH configuration
// file written for the test (DBM_SSH_CONFIG), which reaches the container through a ProxyJump
// host: this machine itself, whose sshd on port 22 must let the current user in with one of
// the default key files (~/.ssh/id_rsa, id_ed25519, …) without passphrase.
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { answerMessages, checker, lastOutputOk, launch, menu, outputMessages, profileWith, recordedMessages, runSql, shot, tcpRelay, uiText } from './lib.mjs'

const env = process.env
const container = env.DBM_REMOTE_HOST ? '' : 'dbm-test-ssh'
const target = container
  ? { host: '127.0.0.1', port: 32222, user: 'root', password: 'test', keyFile: '' }
  : { host: env.DBM_REMOTE_HOST, port: Number(env.DBM_REMOTE_PORT) || 22, user: env.DBM_REMOTE_USER ?? '', password: '', keyFile: env.DBM_REMOTE_KEY ?? '' }
if (!target.user || !(target.password || target.keyFile)) throw new Error('DBM_REMOTE_HOST needs DBM_REMOTE_USER and DBM_REMOTE_KEY')

const exec = promisify(execFile)
/** Output of a command of this machine. Never the Sync form: the relay to the destination runs in this process. */
const run = async (file, args) => (await exec(file, args, { encoding: 'utf8', maxBuffer: 64 << 20 })).stdout.trim()
/** One word of a shell command. */
const quote = (word) => `'${word.replaceAll("'", "'\\''")}'`
/** An identifier of a SQL statement. */
const ident = (name) => `"${name.replaceAll('"', '""')}"`

// the script's own ssh and scp: the key given, and no shared connection left behind (ControlPersist)
const sshOptions = ['-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-i', target.keyFile]
const sshAddress = `${target.user}@${target.host}`
/** Output of a command run by sh on the destination, outside the app. */
const remote = (command) =>
  container
    ? run('docker', ['exec', container, 'sh', '-c', command])
    : run('ssh', [...sshOptions, '-p', String(target.port), sshAddress, `sh -c ${quote(command)}`])
const upload = (local, path) =>
  container ? run('docker', ['cp', local, `${container}:${path}`]) : run('scp', ['-q', ...sshOptions, '-P', String(target.port), local, `${sshAddress}:${path}`])
const download = (path, local) =>
  container ? run('docker', ['cp', `${container}:${path}`, local]) : run('scp', ['-q', ...sshOptions, '-P', String(target.port), `${sshAddress}:${path}`, local])

/** How many helpers run on the destination: the processes of that name, not the shells that started them. */
const helpers = async () => Number(await remote('pgrep dbknife-sqlite | wc -l'))

const userData = profileWith([])
const existing = env.DBM_REMOTE_DB
const file = existing || `/tmp/dbm-e2e-${process.pid}.sqlite`

/**
 * Rows of a query on the fixture's file as it is on the destination now: copied back and
 * opened here, never read through the app.
 */
async function fileRows(sql) {
  const copy = join(userData, 'copy.sqlite')
  await download(file, copy)
  const db = new DatabaseSync(copy, { readOnly: true })
  try {
    return db.prepare(sql).all()
  } finally {
    db.close()
  }
}

/** Output of sqlite3 run on the destination, the database read only. */
const sqlite3 = (sql) => remote(`sqlite3 -readonly ${quote(file)} ${quote(sql)}`)

/** The tables of the file, without SQLite's own, by name. */
async function tablesOfFile() {
  const sql = "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite~_%' ESCAPE '~' ORDER BY name"
  return existing ? (await sqlite3(sql)).split('\n').filter(Boolean) : (await fileRows(sql)).map((r) => r.name)
}

/** A loopback port nobody listens on. */
const closedPort = () =>
  new Promise((ok) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => ok(port))
    })
  })

/** Reads until `done(value)` or the time is up; resolves with the last value read. */
async function eventually(read, done, ms = 6000) {
  for (const end = Date.now() + ms; ; ) {
    const value = await read()
    if (done(value) || Date.now() > end) return value
    await new Promise((ok) => setTimeout(ok, 300))
  }
}

const state = checker()
const { check } = state
const started = Date.now()
let session
try {
  if (!existing) {
    const fixture = join(userData, 'fixture.sqlite')
    const db = new DatabaseSync(fixture)
    db.exec(readFileSync(join(import.meta.dirname, 'fixture-sqlite.sql'), 'utf8'))
    db.close()
    await upload(fixture, file)
  }
  // the address the app connects to
  const appPort = target.host === '127.0.0.1' ? target.port : await tcpRelay(target.host, target.port)
  const helpersBefore = await helpers()

  // the SSH configuration the app reads in place of the user's: the container behind this machine
  const configHost = 'dbm-e2e-dest'
  let jumpConnections = 0
  if (container) {
    const jumpPort = await tcpRelay('127.0.0.1', 22, () => jumpConnections++)
    const sshConfig = join(userData, 'ssh_config')
    writeFileSync(
      sshConfig,
      `Host dbm-e2e-jump\n  HostName 127.0.0.1\n  Port ${jumpPort}\nHost ${configHost}\n  HostName ${target.host}\n  Port ${target.port}\n  User ${target.user}\n  ProxyJump dbm-e2e-jump\n`
    )
    env.DBM_SSH_CONFIG = sshConfig
  }

  session = await launch(userData)
  const { app, page, errors } = session
  await answerMessages(app)
  const ws = page.locator('.workspace:visible')
  const notRunning = () => !document.querySelector('.workspace:not([style*="display: none"]) .running')
  /** The element appears in time; a missing one fails its check instead of stopping the script. */
  const shown = (locator, timeout = 5000) => locator.waitFor({ timeout }).then(() => true, () => false)
  const expand = async (node) => {
    await node.waitFor()
    if ((await node.getAttribute('aria-expanded')) !== 'true') await node.locator('.twisty').dispatchEvent('mousedown')
  }
  /** Answers the prompt of the SSH password, which a destination without key shows at every connection: it is never saved here. */
  const sshPassword = async () => {
    if (!target.password) return
    const input = page.locator('[role=dialog] input[type=password]')
    await input.fill(target.password)
    await page.keyboard.press('Enter')
    await input.waitFor({ state: 'detached' })
  }
  /** Replaces the editor content and starts it, without waiting for its end as runSql does. */
  const startSql = async (sql) => {
    await ws.locator('.editor-page:visible .monaco-editor').first().click()
    await page.keyboard.press('Meta+A')
    await page.keyboard.press('Backspace')
    await page.keyboard.insertText(sql)
    await page.keyboard.press('Meta+Shift+Enter')
  }
  const savedChannels = () => {
    const path = join(userData, 'channels.json')
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : []
  }

  // --- the channel, created from the editor of a new SQLite connection ------------------------
  const name = 'Remote SQLite'
  await page.getByTitle(uiText('home.add')).click()
  await page.locator('#ce-name').fill(name)
  await page.locator('#ce-engine').selectOption('sqlite')
  await page.locator('#ce-channel-new').click()
  await page.locator('#ch-name').fill('e2e')
  await page.locator('#ch-host').fill('127.0.0.1')
  await page.locator('#ch-user').fill(target.user)
  await page.locator('#ch-keyfile').fill(target.keyFile)
  /** OK in the channel dialog, to the end of the verification; true when the dialog has closed, which only a saved channel does. */
  const confirmChannel = async (passwordAsked) => {
    await page.locator('#ch-ok').click()
    if (passwordAsked) await sshPassword()
    await page.waitForFunction(() => !document.querySelector('#ch-ok')?.disabled, null, { timeout: 60000 })
    return (await page.locator('#ch-ok').count()) === 0
  }
  const saveChannel = async (port, passwordAsked) => {
    await page.locator('#ch-port').fill(String(port))
    return confirmChannel(passwordAsked)
  }
  /** The answers of the helpers of the destination, started outside the app: one answer means one file, executable, built for that machine. */
  const helperAnswer = () => remote(`for f in ~/.cache/dbknife/dbknife-sqlite-*; do [ -x "$f" ] && echo '{"id":1,"op":"status"}' | "$f"; done; true`)

  // Bug caught: a channel saved without being verified.
  const closedWithoutServer = await saveChannel(await closedPort(), false)
  const refusals = await recordedMessages(app)
  check(
    'a channel to a closed port shows an error and is not saved',
    !closedWithoutServer && refusals.length === 1 && savedChannels().length === 0,
    `dialog closed: ${closedWithoutServer}, messages: ${JSON.stringify(refusals)}, channels.json: ${JSON.stringify(savedChannels())}`
  )

  // Bug caught: the helper not installed, or the one of another architecture.
  // The helper an earlier run left there would be found, and the installation not exercised.
  await remote('rm -f ~/.cache/dbknife/dbknife-sqlite-*')
  const saved = await saveChannel(appPort, !!target.password)
  const [channel] = savedChannels()
  const answer = await helperAnswer()
  check(
    'a verified channel is saved and its helper runs on the destination',
    saved && channel?.host === '127.0.0.1' && channel.port === appPort && channel.user === target.user && /^\{.*"id":1\b.*\}$/.test(answer),
    `dialog closed: ${saved}, channels.json: ${JSON.stringify(savedChannels())}, helper: ${answer || '(none)'}, messages: ${JSON.stringify(await recordedMessages(app))}`
  )
  if (!saved) throw new Error('no channel to go on with')

  if (container) {
    // Bugs caught: the ProxyJump chain not built (the destination reached directly), the default
    // key files not tried (the jump host names none), the password asked for the jump host or sent to it.
    await remote('rm -f ~/.cache/dbknife/dbknife-sqlite-*')
    await page.locator('#ce-channel-new').click()
    await page.locator('#ch-config-host').selectOption(configHost)
    const followed = await confirmChannel(true)
    const viaConfig = savedChannels().find((c) => c.configHost)
    const uploaded = await helperAnswer()
    check(
      'a channel following a host of the SSH configuration is saved, and reaches it through its ProxyJump host',
      followed && viaConfig?.configHost === configHost && viaConfig.name === configHost && jumpConnections > 0 && /^\{.*"id":1\b.*\}$/.test(uploaded),
      `dialog closed: ${followed}, channels.json: ${JSON.stringify(savedChannels())}, connections to the jump host: ${jumpConnections}, helper: ${uploaded || '(none)'}, messages: ${JSON.stringify(await recordedMessages(app))}`
    )
    if (!followed) await page.locator('#ch-cancel').click()
    // the rest goes on with the first channel
    await page.locator('#ce-channel').selectOption(channel.id)
  }

  // --- the file, chosen in the tree of the destination ---------------------------------------
  if (existing) await page.locator('#ce-file').fill(file)
  else {
    // Bug caught: a tree that does not list the folders, or gives a relative path.
    const node = (path) => page.locator(`.node[data-path="${path}"]`)
    await page.locator('#ce-file-choose').click()
    await sshPassword()
    await expand(node('/tmp'))
    const listed = await shown(node(file), 15000)
    if (listed) {
      await node(file).click()
      await page.locator('#rf-ok').click()
    } else await page.locator('#rf-cancel').click()
    await page.locator('#rf-ok').waitFor({ state: 'detached' })
    const chosen = await page.locator('#ce-file').inputValue()
    check('the remote tree leads to the file in /tmp and gives its absolute path', chosen === file, listed ? chosen : `${file} not listed`)
    if (chosen !== file) await page.locator('#ce-file').fill(file)
  }
  await page.locator('[role=dialog] button.primary').click()
  await page.locator('#ce-name').waitFor({ state: 'detached' })

  // --- the session ---------------------------------------------------------------------------
  await page.locator('.tile', { hasText: name }).dblclick()
  await sshPassword()
  await ws.locator('.editor-page:visible .monaco-editor').first().waitFor()

  // Bug caught: the auxiliary connection, which reads the catalog, not started.
  await expand(ws.locator('.node[data-key="s:main"]'))
  await expand(ws.locator('.node[data-key="s:main/tables"]'))
  const tableNodes = ws.locator('.node[data-key^="t:main."]')
  await shown(tableNodes.first(), 15000)
  const listed = (await tableNodes.evaluateAll((nodes) => nodes.map((n) => n.dataset.key.slice('t:main.'.length)))).sort()
  const tables = (await tablesOfFile()).sort()
  check("the navigator lists the tables of the file's sqlite_master", JSON.stringify(listed) === JSON.stringify(tables), `navigator: ${listed.join()}\nfile: ${tables.join()}`)

  if (existing) {
    // Bug caught: a large result cut or lost on its way.
    const counts = (await sqlite3(tables.map((t) => `SELECT count(*) FROM ${ident(t)};`).join(' '))).split('\n').map(Number)
    const rows = Math.max(...counts)
    const table = tables[counts.indexOf(rows)]
    await page.locator(`select[title="${uiText('editor.toolbar.limit')}"]`).first().selectOption('0')
    const t0 = Date.now()
    await startSql(`SELECT * FROM ${ident(table)}`)
    await page.waitForFunction(notRunning, null, { timeout: 600000 })
    console.log(`    ${rows} rows of ${table} in ${Date.now() - t0} ms`)
    const footer = ws.locator('.editor-page:visible .results .footer span').first()
    const count = (await shown(footer)) ? await footer.innerText() : '(no result)'
    check('SELECT * of the table with most rows returns the rows sqlite3 counts', count === uiText('results.footer.rows', { count: rows }), `${count}\n${(await outputMessages(page)).at(-1)}`)
  } else {
    // Bug caught: the origin of the columns lost along the chain, so a read-only grid or a write to the wrong place.
    await runSql(page, 'SELECT * FROM customer ORDER BY id')
    // an empty status: the grid says nothing against editing
    const status = () => document.querySelector('.workspace .status')?.textContent
    const editable = await page.waitForFunction(() => document.querySelector('.workspace .status')?.textContent === '', null, { timeout: 10000 }).then(() => true, () => false)
    if (editable) {
      await ws.locator('.grid .row').nth(1).locator('.cell').nth(1).dblclick()
      await page.keyboard.press('Meta+A')
      await page.keyboard.insertText('Bobby')
      await page.keyboard.press('Enter')
      await ws.getByRole('button', { name: uiText('common.apply'), exact: true }).click()
      const review = page.locator('[role=dialog]')
      await review.getByRole('button', { name: uiText('common.apply') }).click()
      await review.waitFor({ state: 'detached' })
      await page.waitForTimeout(300)
    }
    const names = (await fileRows('SELECT name FROM customer ORDER BY id')).map((r) => r.name).join()
    check('a cell edited in the grid is changed in the file', names === 'Alice,Bobby,Carla', editable ? names : `grid not editable: ${await page.evaluate(status)}`)

    // Bug caught: the transaction not kept open on the destination.
    const balance = async () => (await fileRows('SELECT balance FROM customer WHERE id = 3'))[0].balance
    const before = await balance()
    await menu(app, 'query.toggleAutocommit')
    await page.waitForTimeout(300)
    await runSql(page, 'UPDATE customer SET balance = 55 WHERE id = 3')
    const updated = await lastOutputOk(page)
    const pending = await balance()
    await menu(app, 'query.commit')
    const committed = await eventually(balance, (value) => value === 55)
    check(
      'autocommit off: an UPDATE reaches the file at Commit, not before',
      updated && before !== 55 && pending === before && committed === 55,
      `file: ${before} -> ${pending} -> ${committed}\n${(await outputMessages(page)).slice(-2).join('\n')}`
    )
    await menu(app, 'query.toggleAutocommit')
    await page.waitForTimeout(300)

    // Bug caught: helpers left running on the destination.
    await startSql('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c')
    await page.waitForTimeout(800)
    await ws.getByTitle(uiText('editor.toolbar.stop')).click()
    const stopped = await page.waitForFunction(notRunning, null, { timeout: 15000 }).then(() => true, () => false)
    if (stopped) await runSql(page, 'SELECT 1')
    check('Stop ends an endless statement and the next one runs', stopped && (await lastOutputOk(page)), (await outputMessages(page)).slice(-2).join('\n'))
    // the browsing and verifying connections have ended, the stopped helper has gone: the session's two are left
    const running = await eventually(helpers, (n) => n === helpersBefore + 2)
    check('no helper runs on the destination besides the two of the session', running === helpersBefore + 2, `${running} running, ${helpersBefore} before the app started`)
  }

  check('no renderer errors', errors.length === 0, errors.join('\n'))
} catch (e) {
  state.failures++
  console.log('FAIL exception', e.message)
  if (session) {
    // an error of the app is a native message box, which nobody sees with the window hidden
    console.log('message boxes:', await recordedMessages(session.app).catch(() => []))
    await shot(session.page, 'sqlite-remote-exception').catch(() => undefined)
  }
} finally {
  await session?.app.close()
  if (!existing) {
    await remote(`rm -f ${file} ${file}-journal`).catch((e) => {
      state.failures++
      console.log(`FAIL ${file} not removed from the destination — ${e.message}`)
    })
  }
  rmSync(userData, { recursive: true, force: true })
}
console.log(`    ${Math.round((Date.now() - started) / 1000)} s`)
console.log(state.failures ? `\n${state.failures} failure(s)` : '\nall checks passed')
process.exit(state.failures ? 1 : 0)
