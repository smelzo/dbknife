// Entry of an Electron utility process holding one SQLite connection
// (node:sqlite is synchronous: a long statement must not block the main
// process, and only killing the process stops a statement running in SQLite).
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { CsvError, readCsv, writeCsv, type CsvFormat } from '@shared/csv'
import { sqliteDialect } from '@shared/sql/dialect'
import type { Cell, DbError, ExecResult, QueryResult, Row } from '@shared/types'
import { statementKind } from '@shared/sql/analyze'
import { sqliteRules } from '@shared/sql/lexer'
import { opensTransaction } from '@shared/sql/transaction'
import { dmlKinds, toCell, toColumnInfo, type SqliteColumn } from './sqlite-columns'

export type SqliteRequest =
  | { op: 'open'; file: string; busyTimeoutMs: number }
  /** With autocommit off a transaction is opened before the statement (see opensTransaction). */
  | { op: 'execute'; sql: string; autocommit: boolean }
  | { op: 'query'; sql: string; params?: unknown[] }
  /** Commits the open transaction, if any. */
  | { op: 'commit' }
  /** Whether a transaction is open. */
  | { op: 'status' }
  /** Creates `table` holding the CSV file's records. */
  | { op: 'importCsv'; file: string; table: string }
  /** Writes `table` to the CSV file, replacing it in one step. */
  | { op: 'exportCsv'; file: string; table: string; format: CsvFormat }

export interface SqliteResponse {
  id: number
  result?: ExecResult | QueryResult
  /** 'commit': whether a transaction was open. */
  committed?: boolean
  /** 'status': whether a transaction is open. */
  transaction?: boolean
  /** 'importCsv': how the file is written. */
  csv?: CsvFormat
  error?: DbError
}

let db: DatabaseSync | undefined

function toError(err: unknown): DbError {
  // CSV errors keep their detail as message: the main process words them
  if (err instanceof CsvError) return { message: err.detail, code: `CSV_${err.code.toUpperCase()}` }
  const e = err as { message?: string; code?: string; errcode?: number }
  return { message: e.message ?? String(err), code: e.code, errno: e.errcode }
}

const quote = sqliteDialect.quoteIdentifier

function importCsv(file: string, table: string): CsvFormat {
  const csv = readCsv(readFileSync(file))
  db!.exec('BEGIN')
  try {
    db!.exec(`CREATE TABLE ${quote(table)} (${csv.columns.map((c) => `${quote(c.name)} ${c.type}`).join(', ')})`)
    const insert = db!.prepare(`INSERT INTO ${quote(table)} VALUES (${csv.columns.map(() => '?').join(', ')})`)
    const numeric = csv.columns.map((c) => c.type !== 'TEXT')
    for (const row of csv.rows) insert.run(...row.map((v, i) => (v !== null && numeric[i] ? Number(v) : v)))
    db!.exec('COMMIT')
  } catch (err) {
    db!.exec('ROLLBACK')
    throw err
  }
  return csv.format
}

function exportCsv(file: string, table: string, format: CsvFormat): void {
  const stmt = db!.prepare(`SELECT * FROM ${quote(table)}`)
  stmt.setReturnArrays(true)
  stmt.setReadBigInts(true)
  const text = (v: unknown): string | null =>
    v === null ? null : v instanceof Uint8Array ? new TextDecoder().decode(v) : String(v)
  const rows = (stmt.all() as unknown as unknown[][]).map((r) => r.map(text))
  const content = writeCsv(
    stmt.columns().map((c) => c.name),
    rows,
    format
  )
  // a symbolic link stays one: its target is replaced
  const target = existsSync(file) ? realpathSync(file) : file
  const temp = `${target}.dbm-save`
  try {
    writeFileSync(temp, content)
    renameSync(temp, target)
  } catch (err) {
    rmSync(temp, { force: true })
    throw err
  }
}

function execute(sql: string, autocommit: boolean): ExecResult {
  const t0 = performance.now()
  try {
    if (!autocommit && !db!.isTransaction && opensTransaction(sql, 'sqlite')) db!.exec('BEGIN')
    const stmt = db!.prepare(sql)
    const columns = stmt.columns() as SqliteColumn[]
    if (!columns.length) {
      const r = stmt.run()
      // sqlite3_changes() keeps the count of the last DML statement: report it for DML only
      const dml = dmlKinds.has(statementKind(sql, sqliteRules))
      return {
        resultSets: [],
        affectedRows: dml ? Number(r.changes) : 0,
        insertId: dml ? Number(r.lastInsertRowid) : 0,
        warnings: [],
        durationMs: performance.now() - t0,
        fetchMs: 0
      }
    }
    stmt.setReturnArrays(true)
    stmt.setReadBigInts(true)
    const rows: Cell[][] = []
    let tFirst: number | undefined
    for (const row of stmt.iterate()) {
      tFirst ??= performance.now()
      rows.push((row as unknown as unknown[]).map(toCell))
    }
    const tEnd = performance.now()
    tFirst ??= tEnd
    return {
      resultSets: [{ columns: columns.map((c, i) => toColumnInfo(c, rows.map((r) => r[i]))), rows }],
      warnings: [],
      durationMs: tFirst - t0,
      fetchMs: tEnd - tFirst
    }
  } catch (err) {
    return { resultSets: [], warnings: [], durationMs: performance.now() - t0, fetchMs: 0, error: toError(err) }
  }
}

function query(sql: string, params: unknown[] = []): QueryResult {
  try {
    const stmt = db!.prepare(sql)
    stmt.setReadBigInts(true)
    const rows = stmt.all(...(params as never[])).map((r) => {
      const row: Row = {}
      for (const [k, v] of Object.entries(r)) row[k] = toCell(v)
      return row
    })
    return { rows }
  } catch (err) {
    return { rows: [], error: toError(err) }
  }
}

function handle(req: SqliteRequest & { id: number }): SqliteResponse {
  if (req.op === 'open') {
    try {
      db = new DatabaseSync(req.file, { timeout: req.busyTimeoutMs })
      // `x REGEXP y` calls regexp(y, x), which SQLite does not define itself
      let cached: RegExp | undefined
      db.function('regexp', { deterministic: true }, (pattern, value) => {
        if (pattern === null || value === null) return null
        if (cached?.source !== String(pattern)) cached = new RegExp(String(pattern))
        return cached.test(String(value)) ? 1 : 0
      })
      return { id: req.id }
    } catch (err) {
      return { id: req.id, error: toError(err) }
    }
  }
  if (!db) return { id: req.id, error: { message: 'The database is not open' } }
  if (req.op === 'commit') {
    try {
      const open = db.isTransaction
      if (open) db.exec('COMMIT')
      return { id: req.id, committed: open }
    } catch (err) {
      return { id: req.id, error: toError(err) }
    }
  }
  try {
    if (req.op === 'status') return { id: req.id, transaction: db.isTransaction }
    if (req.op === 'importCsv') return { id: req.id, csv: importCsv(req.file, req.table) }
    if (req.op === 'exportCsv') {
      exportCsv(req.file, req.table, req.format)
      return { id: req.id }
    }
  } catch (err) {
    return { id: req.id, error: toError(err) }
  }
  return { id: req.id, result: req.op === 'execute' ? execute(req.sql, req.autocommit) : query(req.sql, req.params) }
}

process.parentPort.on('message', (e) => process.parentPort.postMessage(handle(e.data as SqliteRequest & { id: number })))
