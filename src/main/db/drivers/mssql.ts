import { readFileSync } from 'node:fs'
import { Connection, Request, TYPES, type ConnectionConfiguration, type ConnectionOptions } from 'tedious'
import type { ColumnMetadata } from 'tedious/lib/token/colmetadata-token-parser'
import type { ErrorMessageToken, InfoMessageToken } from 'tedious/lib/token/token'
import { t } from '@shared/i18n'
import { statementKind } from '@shared/sql/analyze'
import { mssqlDialect, mssqlNumericType } from '@shared/sql/dialect'
import { tsqlRules } from '@shared/sql/lexer'
import { valueText } from '@shared/value-text'
import type { AutocommitResult, Cell, ColumnInfo, ColumnKind, DbError, ExecResult, ResultSet, Row, ServerInfo, SqlWarning } from '@shared/types'
import { ServerSession } from '../server-session'
import { expandHome, toDbError } from '../session'

/** What the server sent for one batch. */
interface Batch {
  sets: { columns: ColumnMetadata[]; rows: Cell[][] }[]
  affectedRows?: number
  warnings: SqlWarning[]
  /** Error messages of the batch, in the order the server sent them. */
  errors: ErrorMessageToken[]
  /** Failure of the request itself (cancel, socket, invalid state), or of the batch. */
  failure?: Error
  /** performance.now() when the batch was sent, when the first answer and the end arrived. */
  started: number
  firstAnswer?: number
  finished?: number
}

/** Origin of a result column, from sys.dm_exec_describe_first_result_set. */
interface Described {
  name: string
  type: string
  schema: string
  table: string
  column: string
  attributes: string
}

// "Changed database context" and "Changed language setting": the editor reports the change itself
const silentInfo = new Set([5701, 5703])
const fatalCodes = new Set(['ESOCKET', 'ECLOSE', 'EINVALIDSTATE', 'ECONNRESET'])

// TDS user type of timestamp / rowversion columns (binary(8) on the wire)
const timestampUserType = 80

/** Type of a result column as T-SQL spells it, from the protocol metadata: decimal(10,2), nvarchar(50), datetime2(7). */
function typeName(m: ColumnMetadata): string {
  const len = m.dataLength ?? 0
  const size = (n: number): string => (len === 0xffff ? 'max' : String(n))
  const name = m.type.name
  switch (name) {
    case 'IntN':
      return ({ 1: 'tinyint', 2: 'smallint', 8: 'bigint' } as Record<number, string>)[len] ?? 'int'
    case 'FloatN':
      return len === 4 ? 'real' : 'float'
    case 'MoneyN':
      return len === 4 ? 'smallmoney' : 'money'
    case 'DateTimeN':
      return len === 4 ? 'smalldatetime' : 'datetime'
    case 'BitN':
      return 'bit'
    case 'Decimal':
    case 'DecimalN':
    case 'Numeric':
    case 'NumericN':
      return `${name.startsWith('Decimal') ? 'decimal' : 'numeric'}(${m.precision},${m.scale})`
    case 'Time':
    case 'DateTime2':
    case 'DateTimeOffset':
      return `${name.toLowerCase()}(${m.scale})`
    case 'VarChar':
    case 'Char':
      return `${name.toLowerCase()}(${size(len)})`
    case 'NVarChar':
    case 'NChar':
      return `${name.toLowerCase()}(${size(len / 2)})`
    case 'VarBinary':
    case 'Binary':
      return m.userType === timestampUserType ? 'timestamp' : `${name.toLowerCase()}(${size(len)})`
    case 'Variant':
      return 'sql_variant'
    case 'UDT':
      return m.udtInfo?.typeName ?? 'udt'
    default:
      return name.toLowerCase()
  }
}

// CLR types (geography, geometry, hierarchyid) arrive as their binary serialization
const binaryTypes = /^(binary|varbinary|image|timestamp|rowversion|geography|geometry|hierarchyid|udt)\b/i
const kindOf = (type: string): ColumnKind => (mssqlNumericType.test(type) ? 'number' : binaryTypes.test(type) ? 'binary' : 'text')

/** Shortest decimal that reads back as the same 32-bit float: 1.1, not 1.100000023841858. */
function realValue(v: number): number {
  for (let digits = 1; digits < 9; digits++) {
    const n = Number(v.toPrecision(digits))
    if (Math.fround(n) === v) return n
  }
  return v
}

/**
 * Cell of a row. tedious is patched (patches/tedious@*.patch) so decimals,
 * money and dates/times arrive as exact text; bigint is text already.
 * bit becomes 0/1, binary data a copy detached from the packet buffers.
 */
function cell(value: unknown, m: ColumnMetadata): Cell {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  if (Buffer.isBuffer(value)) return new Uint8Array(value)
  if (typeof value === 'number' && (m.type.name === 'Real' || (m.type.name === 'FloatN' && m.dataLength === 4))) return realValue(value)
  return value as Cell
}

function column(m: ColumnMetadata, d?: Described): ColumnInfo {
  const type = d?.type || typeName(m)
  const len = m.dataLength ?? 0
  return {
    name: m.colName,
    orgName: d?.column ?? '',
    table: d?.table ?? '',
    orgTable: d?.table ?? '',
    schema: d?.schema ?? '',
    type,
    kind: kindOf(type),
    length: len === 0xffff ? 0 : /^n(var)?char/.test(type) ? len / 2 : (m.precision ?? len),
    decimals: m.scale ?? 0,
    charset: '',
    attributes: d?.attributes ?? ''
  }
}

/** Parameter of a query on the auxiliary connection, typed from its JavaScript value. */
function addParameter(request: Request, name: string, value: unknown): void {
  if (value === null || value === undefined) request.addParameter(name, TYPES.NVarChar, null)
  else if (typeof value === 'boolean') request.addParameter(name, TYPES.Bit, value)
  else if (typeof value === 'bigint') request.addParameter(name, TYPES.BigInt, value.toString())
  else if (typeof value === 'number')
    request.addParameter(name, Number.isInteger(value) && Math.abs(value) < 2 ** 31 ? TYPES.Int : TYPES.Float, value)
  else if (value instanceof Uint8Array) request.addParameter(name, TYPES.VarBinary, Buffer.from(value))
  else if (value instanceof Date) request.addParameter(name, TYPES.DateTime2, value)
  else if (typeof value === 'object') request.addParameter(name, TYPES.NVarChar, JSON.stringify(value))
  else request.addParameter(name, TYPES.NVarChar, valueText(value))
}

/** COMMIT / ROLLBACK typed alone, which SQL Server rejects when no transaction is open. */
const bareTransactionEnd = /^\s*(commit|rollback)(\s+(tran|transaction|work))?\s*;?\s*$/i
// "The COMMIT/ROLLBACK TRANSACTION request has no corresponding BEGIN TRANSACTION."
const noTransactionErrors = new Set([3902, 3903])

/**
 * Microsoft SQL Server through tedious. A session is bound to one database
 * (USE moves both connections to another one); its "default schema" is the
 * database user's default schema, SCHEMA_NAME().
 */
export class MssqlSession extends ServerSession<Connection> {
  protected readonly defaultPort = 1433
  /** Database of the user connection, followed by the auxiliary one. */
  private database = this.config.database || 'master'
  /** Connections that ended or failed: tedious connections cannot reconnect. */
  private dead = new WeakSet<Connection>()
  /** TLS protocol and cipher of each encrypted connection. */
  private tls = new WeakMap<Connection, string>()
  /** Last request of each connection: tedious runs one request at a time. */
  private pending = new WeakMap<Connection, Promise<unknown>>()

  private connectionOptions(withSsl: boolean, server: string): ConnectionOptions {
    const c = this.config
    const s = c.ssl
    const encrypt = withSsl && s.mode !== 'disabled'
    const verify = s.mode === 'verify_ca' || s.mode === 'verify_identity'
    const host = c.host.split('\\')[0]
    return {
      database: this.database,
      appName: 'DBKnife',
      connectTimeout: (c.options.connectTimeout || 10) * 1000,
      // statements run until they end or are cancelled
      requestTimeout: 0,
      encrypt,
      // tedious always checks the host name of a verified certificate: verify_ca behaves as verify_identity
      trustServerCertificate: !verify,
      cryptoCredentialsDetails: encrypt && s.ca ? { ca: readFileSync(expandHome(s.ca)) } : {},
      // through an SSH tunnel the certificate names the server, not 127.0.0.1; host\instance names the host
      serverName: encrypt && verify && server !== host ? host : undefined,
      // null keeps the login's language, DATEFORMAT and DATEFIRST instead of tedious' us_english / mdy / 7
      ...({ language: null, dateFormat: null, datefirst: null } as unknown as ConnectionOptions)
    }
  }

  protected async connect(withSsl = true): Promise<Connection> {
    const c = this.config
    const ep = await this.endpoint()
    // host\instance: the instance's port comes from SQL Browser (UDP 1434, so not through SSH)
    const [server, instanceName] = c.method === 'tcp' ? ep.host.split('\\') : [ep.host]
    const domainUser = /^([^\\]+)\\(.+)$/.exec(c.user)
    const password = this.secrets.password ?? ''
    const config: ConnectionConfiguration = {
      server,
      authentication: domainUser
        ? { type: 'ntlm', options: { domain: domainUser[1], userName: domainUser[2], password } }
        : { type: 'default', options: { userName: c.user, password } },
      options: { ...this.connectionOptions(withSsl, server), ...(instanceName ? { instanceName } : { port: ep.port }) }
    }
    const conn = new Connection(config)
    // without an error listener a dropped connection would crash the main process
    conn.on('error', () => this.dead.add(conn))
    conn.on('end', () => this.dead.add(conn))
    conn.on('secure', (socket) => this.tls.set(conn, `${socket.getProtocol() ?? ''} ${socket.getCipher().name}`.trim()))
    conn.on('databaseChange', (name) => {
      if (conn === this.user) this.database = name
    })
    try {
      await new Promise<void>((resolve, reject) => conn.connect((err) => (err ? reject(err) : resolve())))
      return conn
    } catch (err) {
      this.dead.add(conn)
      conn.close()
      const e = err as { code?: string; message?: string }
      if (withSsl && c.ssl.mode === 'preferred' && e.code === 'EENCRYPT' && /did not negotiate/i.test(e.message ?? '')) return this.connect(false)
      throw err
    }
  }

  protected isAlive(conn: Connection): boolean {
    return !this.dead.has(conn)
  }

  protected destroy(conn: Connection): void {
    this.dead.add(conn)
    conn.close()
  }

  /** Runs `task` after the connection's previous request. */
  private exclusive<T>(conn: Connection, task: () => Promise<T>): Promise<T> {
    const next = (this.pending.get(conn) ?? Promise.resolve()).catch(() => undefined).then(task)
    this.pending.set(conn, next)
    return next
  }

  /** Sends a batch (or, with parameters, an sp_executesql call) after the connection's previous request. */
  private send(conn: Connection, sql: string, params?: unknown[]): Promise<Batch> {
    return this.exclusive(conn, () => this.sendNow(conn, sql, params))
  }

  /** Sends a batch at once collecting everything the server answers: the caller holds the connection (exclusive). */
  private sendNow(conn: Connection, sql: string, params?: unknown[]): Promise<Batch> {
    return new Promise<Batch>((resolve) => {
      const batch: Batch = { sets: [], warnings: [], errors: [], started: performance.now() }
      let current: Batch['sets'][number] | undefined
      const onInfo = (m: InfoMessageToken): void => {
        if (!silentInfo.has(m.number)) batch.warnings.push({ level: 'INFO', code: m.number, message: m.message })
      }
      const onError = (m: ErrorMessageToken): void => {
        batch.errors.push(m)
        // severity 20 and above ends the session
        if (m.class >= 20) this.dead.add(conn)
      }
      const onDone = (rowCount: number | undefined): void => {
        batch.firstAnswer ??= performance.now()
        if (current) current = undefined
        else if (rowCount !== undefined) batch.affectedRows = (batch.affectedRows ?? 0) + rowCount
      }
      conn.on('infoMessage', onInfo)
      conn.on('errorMessage', onError)
      const request = new Request(sql, (err) => {
        batch.finished = performance.now()
        conn.off('infoMessage', onInfo)
        conn.off('errorMessage', onError)
        batch.failure = err ?? undefined
        resolve(batch)
      })
      request.on('columnMetadata', (columns) => {
        batch.firstAnswer ??= performance.now()
        current = { columns: columns as ColumnMetadata[], rows: [] }
        batch.sets.push(current)
      })
      // an array, as useColumnNames is not set
      request.on('row', (values: { value: unknown; metadata: ColumnMetadata }[]) => current?.rows.push(values.map((v) => cell(v.value, v.metadata))))
      request.on('done', onDone)
      request.on('doneInProc', onDone)
      request.on('doneProc', onDone)
      if (params?.length) {
        params.forEach((v, i) => addParameter(request, `p${i + 1}`, v))
        conn.execSql(request)
      } else {
        conn.execSqlBatch(request)
      }
    })
  }

  /**
   * The batch's error: its first message (with the line, for scripts of more
   * lines) and any later ones. The line counts from the batch start unless it
   * belongs to a module (procedure, trigger) the batch called; a batch
   * creating the module reports it from the batch start too.
   */
  private batchError(batch: Batch, sql: string): DbError | undefined {
    const [first, ...others] = batch.errors
    if (!first) {
      if (!batch.failure) return undefined
      const e = batch.failure as Error & { code?: string }
      return e.code === 'ECANCEL' ? { message: t('main.mssql.canceled'), code: e.code } : toDbError(e)
    }
    const message = [first, ...others].map((m) => m.message).join(' ')
    const line = first.lineNumber > 0 && sql.trimEnd().includes('\n') ? first.lineNumber : 0
    const inBatch = first.lineNumber > 0 && (!first.procName || /^(CREATE|ALTER)$/.test(statementKind(sql, tsqlRules)))
    return {
      message: line ? t('main.mssql.errorLine', { message, line }) : message,
      errno: first.number,
      line: inBatch ? first.lineNumber : undefined
    }
  }

  /**
   * Runs a query on the auxiliary connection and returns the rows of its
   * last result set. Parameters are positional: `params[0]` is `@p1`,
   * `params[1]` is `@p2`, and so on (sp_executesql). Their SQL type follows
   * the JavaScript value: string → nvarchar, integer → int (float beyond
   * 32 bits), boolean → bit, Uint8Array → varbinary, null → NULL; arrays and
   * objects are sent as JSON text, to be read with OPENJSON.
   * Cells are converted as in the editor's results (bit → 0/1).
   */
  protected async run(conn: Connection, sql: string, params?: unknown[]): Promise<Row[]> {
    const batch = await this.send(conn, sql, params)
    const error = this.batchError(batch, sql)
    if (error) throw Object.assign(new Error(error.message), { errno: error.errno, code: error.code })
    const last = batch.sets.at(-1)
    if (!last) return []
    return last.rows.map((r) => Object.fromEntries(last.columns.map((c, i) => [c.colName, r[i]])))
  }

  /** The database comes with the login (connect); autocommit off is IMPLICIT_TRANSACTIONS. */
  protected async initUser(conn: Connection): Promise<void> {
    if (!this.autocommit) await this.run(conn, 'SET IMPLICIT_TRANSACTIONS ON')
  }

  protected async readInfo(conn: Connection): Promise<Omit<ServerInfo, 'endpoint'>> {
    const [row] = await this.run(
      conn,
      `SELECT @@VERSION AS v, CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS pv,
              CAST(SERVERPROPERTY('Edition') AS nvarchar(128)) AS ed, @@SPID AS spid,
              SUSER_SNAME() AS su, USER_NAME() AS cu, SCHEMA_NAME() AS s, DB_NAME() AS db`
    )
    // "SQL Server 2019 Express 15.0.2000.5"; Azure SQL has no year in @@VERSION
    const year = /SQL Server (\d{4})/.exec(String(row.v))?.[1]
    const edition = valueText(row.ed).replace(/\s*Edition\b.*$/, '')
    const product = year ? `SQL Server ${year}` : String(row.v).split(/ [-(]/)[0].replace(/^Microsoft /, '')
    this.database = String(row.db)
    return {
      engine: 'mssql',
      version: [product, edition, row.pv].filter(Boolean).join(' '),
      isMariaDB: false,
      threadId: Number(row.spid),
      user: String(row.su),
      currentUser: String(row.cu),
      defaultSchema: (row.s as string | null) ?? '',
      database: this.database,
      ssl: this.tls.get(conn) ?? ''
    }
  }

  /**
   * Only transport failures are retried. A severity 20+ error raised by the
   * batch itself marks the connection dead (the next statement reconnects)
   * but is reported as is: the batch may have changed data before it.
   */
  protected isFatal(error: DbError): boolean {
    return fatalCodes.has(error.code ?? '')
  }

  /** USE is followed through the server's database change notice instead (see streamBatch). */
  protected changesSessionState(): boolean {
    return false
  }

  protected async syncSessionState(conn: Connection): Promise<void> {
    const [row] = await this.run(conn, 'SELECT DB_NAME() AS db, SCHEMA_NAME() AS s').catch(() => [] as Row[])
    if (!row) return
    this.database = String(row.db)
    this.currentDb = (row.s as string | null) ?? ''
  }

  protected async stream(conn: Connection, sql: string): Promise<ExecResult> {
    const database = this.database
    return this.batchResult(conn, sql, await this.send(conn, sql), database, true)
  }

  /**
   * The result of a batch, with every result set. When the batch moved the
   * session away from `database` (USE, even before a failing statement), the
   * auxiliary connection follows and the result names the new database.
   */
  private async batchResult(conn: Connection, sql: string, batch: Batch, database: string, describe: boolean): Promise<ExecResult> {
    const t0 = batch.started
    const tEnd = batch.finished ?? performance.now()
    const tFirst = batch.firstAnswer ?? tEnd
    let error = this.batchError(batch, sql)
    const warnings = batch.warnings
    if (error?.errno !== undefined && noTransactionErrors.has(error.errno) && bareTransactionEnd.test(sql)) {
      // as in PostgreSQL, ending a transaction that is not open is only worth a warning
      warnings.push({ level: 'INFO', code: error.errno, message: error.message })
      error = undefined
    }
    const origins = describe && !error && batch.sets.length === 1 ? await this.describe(sql, batch.sets[0].columns) : undefined
    const resultSets: ResultSet[] = batch.sets.map((s) => ({ columns: s.columns.map((c, i) => column(c, origins?.[i])), rows: s.rows }))
    const result: ExecResult = { resultSets, affectedRows: batch.affectedRows, warnings, durationMs: tFirst - t0, fetchMs: tEnd - tFirst, error }
    if (this.database === database || !this.isAlive(conn)) return result
    await this.syncSessionState(conn)
    if (this.aux && this.isAlive(this.aux)) {
      // a failed USE leaves the auxiliary connection to be reopened on the new database
      await this.run(this.aux, `USE ${mssqlDialect.quoteIdentifier(this.database)}`).catch(() => this.aux && this.destroy(this.aux))
    }
    return { ...result, database: this.database }
  }

  /**
   * Origin of the columns of the batch's only result set (schema, table,
   * column, key) through the auxiliary connection, so the grid can edit it.
   * Without an answer (temporary tables, objects locked by the user's open
   * transaction, columns that do not match) the columns stay without origin.
   */
  private async describe(sql: string, columns: ColumnMetadata[]): Promise<(Described | undefined)[] | undefined> {
    const r = await this.query(
      `SET LOCK_TIMEOUT 1000;
       SELECT d.name, d.system_type_name AS type, d.is_nullable AS nullable, d.is_identity_column AS ident,
              d.source_database AS db, d.source_schema AS sch, d.source_table AS tbl, d.source_column AS col,
              CASE WHEN EXISTS (
                SELECT 1 FROM sys.indexes i
                JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                WHERE i.is_primary_key = 1 AND c.name = d.source_column
                  AND i.object_id = OBJECT_ID(QUOTENAME(d.source_schema) + '.' + QUOTENAME(d.source_table))
              ) THEN 1 ELSE 0 END AS pk
       FROM sys.dm_exec_describe_first_result_set(@p1, NULL, 1) d
       WHERE d.is_hidden = 0
       ORDER BY d.column_ordinal`,
      [sql]
    )
    if (r.error || r.rows.length !== columns.length || r.rows.some((row, i) => (row.name ?? '') !== columns[i].colName)) return undefined
    return r.rows.map((row) => {
      const sourced = row.tbl && row.col && (!row.db || valueText(row.db).toLowerCase() === this.database.toLowerCase())
      if (!sourced) return { name: valueText(row.name), type: valueText(row.type), schema: '', table: '', column: '', attributes: '' }
      const attributes = [row.nullable === 0 && 'NOT_NULL', row.pk === 1 && 'PRI_KEY', row.ident === 1 && 'AUTO_INCREMENT'].filter(Boolean).join(' ')
      return { name: String(row.name), type: String(row.type), schema: String(row.sch), table: String(row.tbl), column: String(row.col), attributes }
    })
  }

  /**
   * Estimated plan as SHOWPLAN_XML rows, on the user connection without the
   * reconnect-and-retry of execute: on a fresh connection the statement would
   * run for real. A session left in SHOWPLAN mode only returns plans, so it is
   * dropped when switching the mode off fails. ON, the statement and OFF take
   * one turn of the connection: a request sent in between (COMMIT, an edit of
   * the grid) would return a plan without running.
   */
  async explain(sql: string): Promise<ExecResult> {
    let conn: Connection
    try {
      ;({ conn } = await this.userConnection())
    } catch (err) {
      return { resultSets: [], warnings: [], durationMs: 0, fetchMs: 0, error: toDbError(err) }
    }
    const database = this.database
    const [sent, batch] = await this.exclusive(conn, async (): Promise<[string, Batch]> => {
      const on = await this.sendNow(conn, 'SET SHOWPLAN_XML ON')
      if (this.batchError(on, '')) return ['SET SHOWPLAN_XML ON', on]
      try {
        return [sql, await this.sendNow(conn, sql)]
      } finally {
        const off = await this.sendNow(conn, 'SET SHOWPLAN_XML OFF')
        if (this.batchError(off, '')) this.destroy(conn)
      }
    })
    return this.batchResult(conn, sent, batch, database, false)
  }

  async setAutocommit(on: boolean): Promise<AutocommitResult> {
    this.autocommit = on
    const conn = this.user
    // a new connection gets the mode from initUser
    if (!conn || !this.isAlive(conn)) return { ended: '' }
    try {
      if (!on) {
        await this.run(conn, 'SET IMPLICIT_TRANSACTIONS ON')
        return { ended: '' }
      }
      // an uncommittable transaction (XACT_STATE() = -1) can only be rolled back
      const [row] = await this.run(
        conn,
        `SET IMPLICIT_TRANSACTIONS OFF;
         DECLARE @ended varchar(8) = '';
         IF XACT_STATE() = -1 BEGIN ROLLBACK; SET @ended = 'ROLLBACK' END
         ELSE IF @@TRANCOUNT > 0 BEGIN WHILE @@TRANCOUNT > 0 COMMIT; SET @ended = 'COMMIT' END;
         SELECT @ended AS ended`
      )
      return { ended: (row?.ended as AutocommitResult['ended']) ?? '' }
    } catch (err) {
      return { ended: '', error: toDbError(err) }
    }
  }

  /** Sends an attention to stop the running batch, on the user connection itself. */
  cancel(): Promise<void> {
    this.user?.cancel()
    return Promise.resolve()
  }
}
