import { readFileSync } from 'node:fs'
import pg, { type ClientConfig, type FieldDef, type QueryArrayResult } from 'pg'
import type { NoticeMessage } from 'pg-protocol/dist/messages.js'
import type { AutocommitResult, Cell, ColumnInfo, ColumnKind, DbError, ExecResult, ResultSet, Row, ServerInfo, SqlWarning } from '@shared/types'
import { opensTransaction } from '@shared/sql/transaction'
import { valueText } from '@shared/value-text'
import { ServerSession } from '../server-session'
import { expandHome, toDbError } from '../session'

// built-in type oids (pg_type.dat)
const Oid = { bool: 16, bytea: 17, int8: 20, int2: 21, int4: 23, oid: 26, float4: 700, float8: 701, money: 790, numeric: 1700 }

const toInt = (v: string): number => parseInt(v, 10)
/** NaN and ±Infinity stay text, so they print and quote back as the server spells them. */
const toFloat = (v: string): number | string => {
  const n = Number(v)
  return Number.isFinite(n) ? n : v
}

/**
 * Cells keep the server's text except where JavaScript is exact: int8,
 * numeric, dates, intervals, json and arrays stay strings as sent; booleans
 * become 'true'/'false', which also work as literals when edited back.
 */
const parsers: Record<number, (v: string) => unknown> = {
  [Oid.bool]: (v) => (v === 't' ? 'true' : 'false'),
  // pg-types declares its parsers as returning any; the text parser of bytea gives a Buffer
  [Oid.bytea]: pg.types.getTypeParser(Oid.bytea) as (v: string) => Buffer,
  [Oid.int2]: toInt,
  [Oid.int4]: toInt,
  [Oid.oid]: toInt,
  [Oid.float4]: toFloat,
  [Oid.float8]: toFloat
}
const asText = (v: string): string => v
const typeParsers = { getTypeParser: (oid: number) => parsers[oid] ?? asText } as unknown as ClientConfig['types']

/** Kind of a result column when its type cannot be looked up in the catalog. */
const builtinNumbers = new Set([Oid.int8, Oid.int2, Oid.int4, Oid.oid, Oid.float4, Oid.float8, Oid.money, Oid.numeric])

interface TypeInfo {
  name: string
  kind: ColumnKind
}

interface Origin {
  schema: string
  table: string
  column: string
  attributes: string
}

/**
 * pg.Query noting when the server's first answer to the script arrives
 * (row description or command completion), for the duration / fetch split.
 * The handle* methods are the Submittable protocol callbacks of pg.
 */
interface ProtocolQuery extends pg.Query {
  handleRowDescription(msg: unknown): void
  handleCommandComplete(msg: unknown, connection: unknown): void
}
const BaseQuery = pg.Query as unknown as new (config: pg.QueryArrayConfig) => ProtocolQuery

class TimedQuery extends BaseQuery {
  firstAnswer?: number

  handleRowDescription(msg: unknown): void {
    this.firstAnswer ??= performance.now()
    super.handleRowDescription(msg)
  }

  handleCommandComplete(msg: unknown, connection: unknown): void {
    this.firstAnswer ??= performance.now()
    super.handleCommandComplete(msg, connection)
  }
}

const fatalCodes = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED', '57P01', '57P02', '57P03'])

/**
 * PostgreSQL error with its SQLSTATE as code, and the server's detail and hint.
 * With the query text, the error position (1-based, in characters) becomes its line.
 */
function toPgError(err: unknown, sql?: string): DbError {
  const e = err as { detail?: string; hint?: string; severity?: string; position?: string }
  const base = toDbError(err)
  const extra = [e.detail && `DETAIL: ${e.detail}`, e.hint && `HINT: ${e.hint}`].filter(Boolean).join(' ')
  const position = Number(e.position)
  return {
    ...base,
    message: extra ? `${base.message} (${extra})` : base.message,
    sqlState: e.severity && base.code ? base.code : undefined,
    line: sql && position > 0 ? Array.from(sql).slice(0, position - 1).filter((c) => c === '\n').length + 1 : undefined
  }
}

/**
 * PostgreSQL through node-postgres. A session is bound to one database;
 * its "default schema" is the first schema of the search_path.
 */
export class PostgresSession extends ServerSession<pg.Client> {
  protected readonly defaultPort = 5432
  /** Clients whose connection ended or failed: pg clients cannot reconnect. */
  private dead = new WeakSet<pg.Client>()
  /** Result type names by `oid:typmod`. */
  private types = new Map<string, TypeInfo>()
  /** Last query sent through run() on each client. */
  private pending = new WeakMap<pg.Client, Promise<unknown>>()

  private sslOptions(): ClientConfig['ssl'] {
    const s = this.config.ssl
    if (s.mode === 'disabled') return false
    const read = (p: string): Buffer | undefined => (p ? readFileSync(expandHome(p)) : undefined)
    const base = { ca: read(s.ca), cert: read(s.cert), key: read(s.key), ciphers: s.cipher || undefined }
    // libpq semantics: require encrypts only, verify-ca checks the chain, verify-full also the host name
    if (s.mode === 'verify_identity') return { ...base, rejectUnauthorized: true }
    if (s.mode === 'verify_ca') return { ...base, rejectUnauthorized: true, checkServerIdentity: () => undefined }
    return { ...base, rejectUnauthorized: false }
  }

  protected async connect(withSsl = true): Promise<pg.Client> {
    const c = this.config
    const ep = await this.endpoint()
    const client = new pg.Client({
      host: ep.socket || ep.host,
      port: ep.port || this.defaultPort,
      user: c.user,
      password: this.secrets.password ?? '',
      database: c.database || 'postgres',
      ssl: withSsl ? this.sslOptions() : false,
      connectionTimeoutMillis: (c.options.connectTimeout || 10) * 1000,
      application_name: 'DBKnife',
      keepAlive: true,
      types: typeParsers
    })
    // without an error listener a dropped connection would crash the main process
    client.on('error', () => this.dead.add(client))
    client.on('end', () => this.dead.add(client))
    try {
      await client.connect()
      return client
    } catch (err) {
      this.dead.add(client)
      if (withSsl && c.ssl.mode === 'preferred' && /does not support SSL/i.test((err as Error).message ?? '')) return this.connect(false)
      throw err
    }
  }

  protected isAlive(conn: pg.Client): boolean {
    return !this.dead.has(conn)
  }

  protected destroy(conn: pg.Client): void {
    this.dead.add(conn)
    conn.end().catch(() => undefined)
  }

  /** pg 8 still queues overlapping queries of a client but deprecates it: they are chained here. */
  protected run(conn: pg.Client, sql: string, params?: unknown[]): Promise<Row[]> {
    const previous = this.pending.get(conn) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const r = (await conn.query(sql, params)) as pg.QueryResult | pg.QueryResult[]
        return (Array.isArray(r) ? (r.at(-1)?.rows ?? []) : r.rows) as Row[]
      })
    this.pending.set(conn, next)
    return next
  }

  /** Puts the session's schema first in the search_path (the configured one, or the current one after a reconnect). */
  protected async initUser(conn: pg.Client): Promise<void> {
    if (!this.currentDb) return
    await conn.query("SELECT set_config('search_path', quote_ident($1) || ', ' || current_setting('search_path'), false)", [this.currentDb])
  }

  protected async readInfo(conn: pg.Client): Promise<Omit<ServerInfo, 'endpoint'>> {
    const [row] = await this.run(
      conn,
      `SELECT 'PostgreSQL ' || current_setting('server_version') AS v, pg_backend_pid() AS pid, session_user AS su,
              current_user AS cu, current_schema() AS s, current_database() AS db,
              (SELECT coalesce(version || ' ' || cipher, '') FROM pg_stat_ssl WHERE pid = pg_backend_pid() AND ssl) AS ssl`
    )
    return {
      engine: 'postgres',
      version: String(row.v),
      isMariaDB: false,
      threadId: Number(row.pid),
      user: String(row.su),
      currentUser: String(row.cu),
      defaultSchema: (row.s as string | null) ?? '',
      database: String(row.db),
      ssl: (row.ssl as string | null) ?? ''
    }
  }

  protected isFatal(error: DbError): boolean {
    const code = error.code ?? ''
    return fatalCodes.has(code) || code.startsWith('08') || /Connection terminated|not queryable/i.test(error.message)
  }

  protected changesSessionState(sql: string): boolean {
    return /^\s*(set\s+((session|local)\s+)?(search_path|schema)\b|reset\s+(search_path|all)\b|discard\s+all\b)/i.test(sql)
  }

  protected async syncSessionState(conn: pg.Client): Promise<void> {
    const [row] = await this.run(conn, 'SELECT current_schema() AS s').catch(() => [] as Row[])
    if (row) this.currentDb = (row.s as string | null) ?? ''
  }

  protected async stream(conn: pg.Client, sql: string): Promise<ExecResult> {
    // autocommit off: the statement joins the open transaction, or starts one
    if (!this.autocommit && conn.getTransactionStatus() === 'I' && opensTransaction(sql, 'postgres')) {
      try {
        await conn.query('BEGIN')
      } catch (err) {
        return { resultSets: [], warnings: [], durationMs: 0, fetchMs: 0, error: toPgError(err) }
      }
    }
    return this.streamQuery(conn, sql)
  }

  private streamQuery(conn: pg.Client, sql: string): Promise<ExecResult> {
    return new Promise((resolve) => {
      const t0 = performance.now()
      const warnings: SqlWarning[] = []
      const onNotice = (n: NoticeMessage): void => {
        warnings.push({ level: n.severity ?? 'NOTICE', code: 0, message: n.message ?? '' })
      }
      conn.on('notice', onNotice)
      const query = new TimedQuery({ text: sql, rowMode: 'array' })

      const finish = async (results: QueryArrayResult[], err?: unknown): Promise<void> => {
        conn.off('notice', onNotice)
        const tEnd = performance.now()
        const tFirst = query.firstAnswer ?? tEnd
        const error = err === undefined ? undefined : toPgError(err, sql)
        // a FATAL error closes the connection: do not wait for the socket to say so
        if (error && this.isFatal(error)) this.dead.add(conn)
        const resultSets: ResultSet[] = []
        let affectedRows: number | undefined
        for (const r of error ? [] : results) {
          if (r.fields.length) resultSets.push({ columns: await this.describe(r.fields), rows: r.rows as Cell[][] })
          else if (r.rowCount !== null) affectedRows = r.rowCount
        }
        resolve({ resultSets, affectedRows, warnings, durationMs: tFirst - t0, fetchMs: tEnd - tFirst, error })
      }

      query.on('end', (r) => void finish(Array.isArray(r) ? (r as QueryArrayResult[]) : [r as unknown as QueryArrayResult]))
      query.on('error', (err) => void finish([], err))
      conn.query(query)
    })
  }

  /**
   * Result columns with their origin (schema, table, column) and type names
   * read from the catalog through the auxiliary connection, so a lookup can
   * neither block behind nor abort the user connection's transaction.
   * Objects created by the user's uncommitted transaction are not visible
   * there: their columns stay without origin (read-only results).
   */
  private async describe(fields: FieldDef[]): Promise<ColumnInfo[]> {
    const typeKey = (f: FieldDef): string => `${f.dataTypeID}:${f.dataTypeModifier}`
    const missing = [...new Map(fields.filter((f) => !this.types.has(typeKey(f))).map((f) => [typeKey(f), f])).values()]
    const sourced = fields.filter((f) => f.tableID > 0)
    const [types, origins] = await Promise.all([
      missing.length
        ? this.query(
            `SELECT k.oid, k.mod, format_type(k.oid, nullif(k.mod, -1)) AS name, t.typcategory AS cat
             FROM unnest($1::oid[], $2::int4[]) AS k(oid, mod) JOIN pg_type t ON t.oid = k.oid`,
            [missing.map((f) => f.dataTypeID), missing.map((f) => f.dataTypeModifier)]
          )
        : null,
      sourced.length
        ? this.query(
            `SELECT k.tid, k.num, n.nspname AS schema, c.relname AS table, a.attname AS column, a.attnotnull AS notnull,
                    EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = k.tid AND i.indisprimary AND k.num = ANY (i.indkey)) AS pk
             FROM unnest($1::oid[], $2::int2[]) AS k(tid, num)
             JOIN pg_class c ON c.oid = k.tid
             JOIN pg_namespace n ON n.oid = c.relnamespace
             JOIN pg_attribute a ON a.attrelid = k.tid AND a.attnum = k.num`,
            [sourced.map((f) => f.tableID), sourced.map((f) => f.columnID)]
          )
        : null
    ])
    for (const r of types?.rows ?? []) {
      const kind: ColumnKind = r.oid === Oid.bytea ? 'binary' : r.cat === 'N' ? 'number' : 'text'
      this.types.set(`${valueText(r.oid)}:${valueText(r.mod)}`, { name: String(r.name), kind })
    }
    const origin = new Map<string, Origin>()
    for (const r of origins?.rows ?? []) {
      const attributes = [r.notnull === 'true' && 'NOT_NULL', r.pk === 'true' && 'PRI_KEY'].filter(Boolean).join(' ')
      origin.set(`${valueText(r.tid)}:${valueText(r.num)}`, { schema: String(r.schema), table: String(r.table), column: String(r.column), attributes })
    }
    return fields.map((f) => {
      const type = this.types.get(typeKey(f)) ?? {
        name: String(f.dataTypeID),
        kind: f.dataTypeID === Oid.bytea ? 'binary' : builtinNumbers.has(f.dataTypeID) ? 'number' : 'text'
      }
      const o = origin.get(`${f.tableID}:${f.columnID}`)
      // precision and scale as format_type prints them: varchar(100), numeric(10,2)
      const [, length, decimals] = /\((\d+)(?:,(\d+))?\)/.exec(type.name) ?? []
      return {
        name: f.name,
        orgName: o?.column ?? '',
        table: o?.table ?? '',
        orgTable: o?.table ?? '',
        schema: o?.schema ?? '',
        type: type.name,
        kind: type.kind,
        length: length ? Number(length) : Math.max(0, f.dataTypeSize),
        decimals: decimals ? Number(decimals) : 0,
        charset: '',
        attributes: o?.attributes ?? ''
      }
    })
  }

  async setAutocommit(on: boolean): Promise<AutocommitResult> {
    this.autocommit = on
    const conn = this.user
    if (!on || !conn || !this.isAlive(conn) || conn.getTransactionStatus() === 'I') return { ended: '' }
    try {
      // COMMIT of a failed transaction rolls it back
      const r = await conn.query('COMMIT')
      return { ended: r.command === 'ROLLBACK' ? 'ROLLBACK' : 'COMMIT' }
    } catch (err) {
      return { ended: '', error: toPgError(err) }
    }
  }

  /** Cancels the running statement from the auxiliary connection. */
  async cancel(): Promise<void> {
    await this.query('SELECT pg_cancel_backend($1)', [this.info.threadId])
  }
}
