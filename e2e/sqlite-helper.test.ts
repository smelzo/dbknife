// Runs this machine's remote helper (bin/remote/dbknife-sqlite-<platform>-<arch>)
// on a database built from fixture-sqlite.sql and checks that, through wire.ts,
// it answers as the local driver does. The reference is node:sqlite on the same
// file, read as sqlite-process.ts reads it (toColumnInfo, toCell).
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { ExecResult, QueryResult, ResultSet } from '@shared/types'
import { toCell, toColumnInfo, type SqliteColumn } from '../src/main/db/drivers/sqlite-columns'
import type { SqliteRequest, SqliteResponse } from '../src/main/db/drivers/sqlite-process'
import { fromWire, toWire, type WireResponse } from '../src/main/db/remote/wire'

const binary = join(__dirname, '../bin/remote', `dbknife-sqlite-${process.platform}-${process.arch}`)
const busyTimeoutMs = 5000

/** A helper process, driven with the driver's requests as the app will do over SSH. */
class Helper {
  private readonly child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'inherit'] })
  private readonly lines = createInterface({ input: this.child.stdout })[Symbol.asyncIterator]()
  private seq = 0
  readonly exited = new Promise<void>((done) => this.child.once('exit', () => done()))

  async request(req: SqliteRequest): Promise<SqliteResponse> {
    const t0 = performance.now()
    this.child.stdin.write(`${JSON.stringify({ id: ++this.seq, ...toWire(req) })}\n`)
    const line = await this.lines.next()
    if (line.done) throw new Error('The helper ended without answering')
    return fromWire(req, JSON.parse(line.value) as WireResponse, performance.now() - t0)
  }

  async execute(sql: string, autocommit = true): Promise<ExecResult> {
    return (await this.request({ op: 'execute', sql, autocommit })).result as ExecResult
  }

  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    return (await this.request({ op: 'query', sql, params })).result as QueryResult
  }

  get running(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null
  }

  /** What the end of the SSH channel is for the helper. */
  closeInput(): void {
    this.child.stdin.end()
  }

  kill(): void {
    this.child.kill('SIGKILL')
  }
}

let dir: string
let file: string
let local: DatabaseSync
let databases = 0
const helpers: Helper[] = []

/** A helper with the test's database open. */
async function openHelper(): Promise<Helper> {
  const helper = new Helper()
  helpers.push(helper)
  expect((await helper.request({ op: 'open', file, busyTimeoutMs })).error).toBeUndefined()
  return helper
}

/** The result set of the local driver: node:sqlite read as sqlite-process.ts does. */
function localResultSet(sql: string): ResultSet {
  const stmt = local.prepare(sql)
  const columns = stmt.columns() as SqliteColumn[]
  stmt.setReturnArrays(true)
  stmt.setReadBigInts(true)
  const rows = (stmt.all() as unknown as unknown[][]).map((r) => r.map(toCell))
  return { columns: columns.map((c, i) => toColumnInfo(c, rows.map((r) => r[i]))), rows }
}

describe('remote SQLite helper', () => {
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'dbm-helper-'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  // every test has its own database, also open in node:sqlite
  beforeEach(() => {
    file = join(dir, `shop${++databases}.sqlite`)
    local = new DatabaseSync(file)
    local.exec(readFileSync(join(__dirname, 'fixture-sqlite.sql'), 'utf8'))
  })
  afterEach(() => {
    for (const helper of helpers.splice(0)) helper.kill()
    local.close()
  })

  // Bug: a column's origin missing or different from the local driver's: editing
  // in the grid is switched off, or writes to the wrong column.
  it('gives the columns and values of the local driver', async () => {
    const helper = await openHelper()
    const selects = [
      'SELECT * FROM customer ORDER BY id',
      'SELECT id AS code, name AS label, notes FROM customer ORDER BY id',
      "SELECT id + 1, upper(name), balance * 2 AS twice, avatar IS NULL, 'x' || email FROM customer ORDER BY id",
      'SELECT name, n FROM v_customer_orders ORDER BY name',
      'SELECT c.name, o.id, o.total, o.status, c.avatar FROM customer c JOIN orders o ON o.customer_id = c.id ORDER BY o.id',
      'SELECT * FROM orders WHERE 0'
    ]
    for (const sql of selects) {
      const result = await helper.execute(sql)
      expect(result.error, sql).toBeUndefined()
      expect(result.resultSets, sql).toEqual([localResultSet(sql)])
    }
  })

  // Bug: integers beyond 2^53 losing digits, a BLOB damaged by its encoding,
  // infinity read back as NULL.
  it('carries boundary values to the database and back unchanged', async () => {
    const helper = await openHelper()
    const values = {
      big: 9223372036854775807n,
      negative: -1,
      infinite: 1e999,
      bytes: Uint8Array.from({ length: 256 }, (_, i) => i),
      words: 'Già — naïve, Ελληνικά, 日本語, 🙂 "quoted" \\ \n second line',
      missing: null
    }
    // the big integer travels as a string, which the helper binds as TEXT: the declared type makes it an integer again
    expect((await helper.execute('CREATE TEMP TABLE edge (big INTEGER, negative INTEGER, infinite REAL, bytes BLOB, words TEXT, missing TEXT)')).error).toBeUndefined()
    expect((await helper.query('INSERT INTO edge VALUES (?, ?, ?, ?, ?, ?)', Object.values(values))).error).toBeUndefined()
    const read = await helper.query('SELECT * FROM edge')
    expect(read.error).toBeUndefined()
    // an integer beyond the safe range is a string for the app, as from the local driver (toCell)
    expect(read.rows).toEqual([{ ...values, big: '9223372036854775807' }])
  })

  // Bug: no transaction opened, so with autocommit off the changes are final at once.
  it('with autocommit off keeps the changes in a transaction until commit', async () => {
    const count = async (h: Helper): Promise<unknown> => (await h.query('SELECT count(*) AS n FROM log_nopk')).rows[0].n
    const writer = await openHelper()
    const reader = await openHelper()
    const before = await count(reader)

    const first = await writer.execute("INSERT INTO log_nopk VALUES ('c')", false)
    expect(first.error).toBeUndefined()
    expect(first.affectedRows).toBe(1)
    expect((await writer.request({ op: 'status' })).transaction).toBe(true)
    // a transaction is open already: none is started within it
    expect((await writer.execute("INSERT INTO log_nopk VALUES ('d')", false)).error).toBeUndefined()
    expect(await count(reader)).toBe(before)

    expect(await writer.request({ op: 'commit' })).toMatchObject({ committed: true })
    expect((await writer.request({ op: 'status' })).transaction).toBe(false)
    expect(await count(reader)).toBe(Number(before) + 2)
  })

  // Bug: messages with text added by the Rust library, or its own codes.
  it("reports SQLite's own error, as the local driver does", async () => {
    const helper = await openHelper()
    const sql = 'SELECT * FROM missing_table'
    let thrown: { message: string; code: string; errcode: number } | undefined
    try {
      local.prepare(sql)
    } catch (err) {
      thrown = err as typeof thrown
    }
    expect(thrown).toBeDefined()
    // the DbError sqlite-process.ts makes of node:sqlite's error
    expect((await helper.execute(sql)).error).toEqual({ message: thrown!.message, code: thrown!.code, errno: thrown!.errcode })
  })

  // Bug: a helper left running on the server after Stop, or after the connection dropped.
  it('ends within 5 seconds when stdin is closed during a statement', async () => {
    const helper = await openHelper()
    let answered = false
    const settle = (): void => void (answered = true)
    helper.execute('WITH RECURSIVE n (i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n) SELECT count(*) FROM n').then(settle, settle)
    await sleep(500)
    // the statement has no end: the helper is inside it
    expect(answered).toBe(false)
    expect(helper.running).toBe(true)

    helper.closeInput()
    const ended = await Promise.race([helper.exited.then(() => true), sleep(5000, false, { ref: false })])
    expect(ended).toBe(true)
  })

  // Bug: an empty database created on the server because of a mistyped path.
  it('does not create a missing file', async () => {
    const missing = join(dir, 'mistyped.sqlite')
    const helper = new Helper()
    helpers.push(helper)
    expect((await helper.request({ op: 'open', file: missing, busyTimeoutMs })).error).toBeDefined()
    expect(existsSync(missing)).toBe(false)
  })
})
