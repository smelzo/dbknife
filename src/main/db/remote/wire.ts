// What the SQLite driver exchanges with the remote helper (helper/, dbknife-sqlite):
// the driver's requests and responses, the ones of sqlite-process.ts, translated
// to and from the helper's JSON lines. The helper runs the statements; what
// sqlite-process.ts decides in TypeScript is decided here, so that a remote
// database answers as a local one.
import { statementKind } from '@shared/sql/analyze'
import { sqliteRules } from '@shared/sql/lexer'
import { opensTransaction } from '@shared/sql/transaction'
import type { Cell, DbError, ExecResult, QueryResult, Row } from '@shared/types'
import { dmlKinds, toCell, toColumnInfo, type SqliteColumn } from '../drivers/sqlite-columns'
// types only: the module is the entry of a utility process
import type { SqliteRequest, SqliteResponse } from '../drivers/sqlite-process'

/**
 * A SQLite value in JSON: a BLOB as base64, an infinite REAL by name (JSON has
 * neither), an INTEGER beyond JavaScript's safe range as a decimal string.
 */
export type WireCell = null | number | string | { b: string } | { f: 'inf' | '-inf' }

type WireCommand =
  | { op: 'open'; file: string; busyTimeoutMs: number }
  /** `begin`: open a transaction before the statement, unless one is open. */
  | { op: 'execute'; sql: string; begin: boolean }
  | { op: 'query'; sql: string; params: WireCell[] }
  | { op: 'commit' }
  | { op: 'status' }
  /** The entries of a folder of the remote machine; an empty path is the home folder. */
  | { op: 'list'; path: string }

/** A request line. */
export type WireRequest = { id: number } & WireCommand

interface ExecuteReply {
  columns: SqliteColumn[]
  rows: WireCell[][]
  /** Of the last statement that changed rows, also when this one did not. */
  changes: number
  lastInsertRowid: number
  /** Up to the first row, or to the end without rows. */
  durationMs: number
}

interface QueryReply {
  columns: string[]
  rows: WireCell[][]
}

interface ListReply {
  path: string
  entries: { name: string; dir: boolean; size: number }[]
}

interface CommitReply {
  /** Whether a transaction was open. */
  committed: boolean
}

interface StatusReply {
  /** Whether a transaction is open. */
  transaction: boolean
}

/**
 * A response line, with the `id` of its request. Nothing in it names the
 * operation: the fields are the ones of the request's operation (none for
 * 'open'), or `error` alone, where `code` and `errno` are set for SQLite's
 * errors only.
 */
export type WireResponse = { id: number } & ({ error: DbError } | ExecuteReply | QueryReply | CommitReply | StatusReply | ListReply | Record<never, never>)

function toWireCell(value: unknown): WireCell {
  if (value instanceof Uint8Array) return { b: Buffer.from(value).toString('base64') }
  if (value === Infinity) return { f: 'inf' }
  if (value === -Infinity) return { f: '-inf' }
  return toCell(value) as WireCell
}

function fromWireCell(cell: WireCell): Cell {
  if (cell === null || typeof cell !== 'object') return cell
  if ('b' in cell) return new Uint8Array(Buffer.from(cell.b, 'base64'))
  return cell.f === 'inf' ? Infinity : -Infinity
}

/** The request as the helper reads it; the caller adds the `id`. */
export function toWire(req: SqliteRequest): WireCommand {
  switch (req.op) {
    case 'execute':
      return { op: 'execute', sql: req.sql, begin: !req.autocommit && opensTransaction(req.sql, 'sqlite') }
    case 'query':
      return { op: 'query', sql: req.sql, params: (req.params ?? []).map(toWireCell) }
    case 'importCsv':
    case 'exportCsv':
      // CSV files are opened on this machine only
      throw new Error(`The remote helper has no '${req.op}' operation`)
    default:
      return req
  }
}

function execResult(sql: string, reply: ExecuteReply, elapsedMs: number): ExecResult {
  // what the answer took beyond the statement itself: reading the rows and the way back
  const times = { durationMs: reply.durationMs, fetchMs: Math.max(0, elapsedMs - reply.durationMs) }
  if (!reply.columns.length) {
    // sqlite3_changes() keeps the count of the last DML statement: report it for DML only
    const dml = dmlKinds.has(statementKind(sql, sqliteRules))
    return { resultSets: [], affectedRows: dml ? reply.changes : 0, insertId: dml ? reply.lastInsertRowid : 0, warnings: [], ...times }
  }
  const rows = reply.rows.map((r) => r.map(fromWireCell))
  return {
    resultSets: [{ columns: reply.columns.map((c, i) => toColumnInfo(c, rows.map((r) => r[i]))), rows }],
    warnings: [],
    ...times
  }
}

function queryResult(reply: QueryReply): QueryResult {
  const rows = reply.rows.map((cells) => {
    const row: Row = {}
    reply.columns.forEach((name, i) => (row[name] = fromWireCell(cells[i])))
    return row
  })
  return { rows }
}

/**
 * The helper's response to `req` as sqlite-process.ts would have answered it.
 * `elapsedMs`: from sending the request to receiving the response.
 */
export function fromWire(req: SqliteRequest, res: WireResponse, elapsedMs: number): SqliteResponse {
  const id = res.id
  if ('error' in res) {
    // a failed statement is a result, as for the local driver
    if (req.op === 'execute') return { id, result: { resultSets: [], warnings: [], durationMs: elapsedMs, fetchMs: 0, error: res.error } }
    if (req.op === 'query') return { id, result: { rows: [], error: res.error } }
    return { id, error: res.error }
  }
  switch (req.op) {
    case 'execute':
      return { id, result: execResult(req.sql, res as ExecuteReply, elapsedMs) }
    case 'query':
      return { id, result: queryResult(res as QueryReply) }
    case 'commit':
      return { id, committed: (res as CommitReply).committed }
    case 'status':
      return { id, transaction: (res as StatusReply).transaction }
    default:
      return { id }
  }
}
