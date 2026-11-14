import { readFileSync } from 'node:fs'
import mysql, { type Connection, type ConnectionOptions, type FieldPacket } from 'mysql2'
import type { Cell, ColumnInfo, ColumnKind, DbError, ExecResult, ResultSet, Row, ServerInfo, SqlWarning } from '@shared/types'
import { ServerSession } from '../server-session'
import { expandHome, toDbError } from '../session'

const typeNames = mysql.Types as unknown as Record<number, string>

// MySQL column flags (include/mysql_com.h)
const Flags = {
  NOT_NULL: 1,
  PRI_KEY: 2,
  UNIQUE_KEY: 4,
  MULTIPLE_KEY: 8,
  BLOB: 16,
  UNSIGNED: 32,
  ZEROFILL: 64,
  BINARY: 128,
  ENUM: 256,
  AUTO_INCREMENT: 512,
  TIMESTAMP: 1024,
  SET: 2048
}

const numericTypes = new Set(['DECIMAL', 'NEWDECIMAL', 'TINY', 'SHORT', 'LONG', 'FLOAT', 'DOUBLE', 'LONGLONG', 'INT24', 'YEAR'])

const typeLabels: Record<string, string> = {
  TINY: 'TINYINT',
  SHORT: 'SMALLINT',
  LONG: 'INT',
  INT24: 'MEDIUMINT',
  LONGLONG: 'BIGINT',
  NEWDECIMAL: 'DECIMAL',
  VAR_STRING: 'VARCHAR',
  STRING: 'CHAR',
  TINY_BLOB: 'TINYBLOB',
  MEDIUM_BLOB: 'MEDIUMBLOB',
  LONG_BLOB: 'LONGBLOB',
  NEWDATE: 'DATE'
}

/** Human readable type of a result column (approximation from protocol metadata). */
function typeLabel(protocolType: string, flags: number, binary: boolean): string {
  let t = typeLabels[protocolType] ?? protocolType
  if (protocolType.endsWith('BLOB') && !binary) t = t.replace('BLOB', 'TEXT')
  if ((protocolType === 'VAR_STRING' || protocolType === 'STRING') && binary) t = protocolType === 'STRING' ? 'BINARY' : 'VARBINARY'
  if (flags & Flags.ENUM) t = 'ENUM'
  if (flags & Flags.SET) t = 'SET'
  if (flags & Flags.UNSIGNED) t += ' UNSIGNED'
  return t
}

function columnKind(protocolType: string, binary: boolean): ColumnKind {
  if (protocolType === 'BIT') return 'bit'
  if (protocolType === 'GEOMETRY') return 'geometry'
  if (numericTypes.has(protocolType)) return 'number'
  return binary && (protocolType.endsWith('BLOB') || protocolType.endsWith('STRING')) ? 'binary' : 'text'
}

const flagNames = (flags: number): string =>
  Object.entries(Flags)
    .filter(([, bit]) => flags & bit)
    .map(([name]) => name)
    .join(' ')

function toColumn(f: FieldPacket): ColumnInfo {
  const raw = f as FieldPacket & { columnType?: number; characterSet?: number; columnLength?: number }
  const protocolType = typeNames[raw.columnType ?? -1] ?? 'UNKNOWN'
  const flags = Number(f.flags ?? 0)
  // character set 63 is "binary"
  const binary = raw.characterSet === 63
  return {
    name: f.name,
    orgName: f.orgName ?? '',
    table: f.table ?? '',
    orgTable: f.orgTable ?? '',
    schema: f.schema ?? '',
    type: typeLabel(protocolType, flags, binary),
    kind: columnKind(protocolType, binary),
    length: raw.columnLength ?? 0,
    decimals: f.decimals ?? 0,
    charset: binary ? 'binary' : String(raw.characterSet ?? ''),
    attributes: flagNames(flags)
  }
}

const fatalCodes = new Set(['PROTOCOL_CONNECTION_LOST', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED'])

/** MySQL and MariaDB through mysql2. */
export class MysqlSession extends ServerSession<Connection> {
  protected readonly defaultPort = 3306
  protected readonly serverSafeUpdates = true

  private sslOptions(): ConnectionOptions['ssl'] {
    const s = this.config.ssl
    if (s.mode === 'disabled') return undefined
    const read = (p: string): Buffer | undefined => (p ? readFileSync(expandHome(p)) : undefined)
    const base = { ca: read(s.ca), cert: read(s.cert), key: read(s.key), ciphers: s.cipher || undefined }
    if (s.mode === 'verify_identity') return { ...base, rejectUnauthorized: true, verifyIdentity: true }
    if (s.mode === 'verify_ca') return { ...base, rejectUnauthorized: true, verifyIdentity: false }
    return { ...base, rejectUnauthorized: false }
  }

  protected async connect(withSsl = true): Promise<Connection> {
    const c = this.config
    const ep = await this.endpoint()
    const options: ConnectionOptions = {
      host: ep.host,
      port: ep.port,
      socketPath: ep.socket,
      user: c.user,
      password: this.secrets.password ?? '',
      database: this.currentDb || undefined,
      charset: 'utf8mb4',
      ssl: withSsl ? this.sslOptions() : undefined,
      connectTimeout: (c.options.connectTimeout || 10) * 1000,
      enableKeepAlive: true,
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      jsonStrings: true,
      decimalNumbers: false,
      flags: c.options.compress ? ['+COMPRESS'] : undefined,
      typeCast: (field, next) => (field.type === 'GEOMETRY' ? field.buffer() : next())
    }
    try {
      return await new Promise<Connection>((resolve, reject) => {
        const conn = mysql.createConnection(options)
        conn.connect((err) => (err ? reject(err) : resolve(conn)))
        // without a listener a fatal socket error would crash the main process
        conn.on('error', () => undefined)
      })
    } catch (err) {
      const message = (err as Error).message ?? ''
      if (withSsl && c.ssl.mode === 'preferred' && /secure connection/i.test(message)) return this.connect(false)
      throw err
    }
  }

  protected isAlive(conn: Connection): boolean {
    const state = conn as Connection & { _fatalError?: unknown; _closing?: boolean }
    return !state._fatalError && !state._closing
  }

  protected destroy(conn: Connection): void {
    conn.destroy()
  }

  private exec<T = unknown>(conn: Connection, sql: string, values?: unknown[]): Promise<T> {
    return new Promise((resolve, reject) =>
      conn.query({ sql, values }, (err, rows) => (err ? reject(err) : resolve(rows as T)))
    )
  }

  protected async run(conn: Connection, sql: string, params?: unknown[]): Promise<Row[]> {
    const rows = await this.exec<Row[] | Row>(conn, sql, params)
    return Array.isArray(rows) ? rows : [rows]
  }

  protected async initUser(conn: Connection): Promise<void> {
    if (this.safeUpdates) await this.exec(conn, 'SET SESSION sql_safe_updates = 1')
    if (this.config.options.sqlMode) await this.exec(conn, 'SET SESSION sql_mode = ?', [this.config.options.sqlMode])
    if (!this.autocommit) await this.exec(conn, 'SET autocommit = 0')
  }

  protected async readInfo(conn: Connection): Promise<Omit<ServerInfo, 'endpoint'>> {
    const [row] = await this.exec<Row[]>(
      conn,
      'SELECT VERSION() AS v, CONNECTION_ID() AS id, USER() AS u, CURRENT_USER() AS cu, DATABASE() AS db'
    )
    const ssl = await this.exec<Row[]>(conn, "SHOW SESSION STATUS LIKE 'Ssl_cipher'")
    const version = String(row.v)
    return {
      engine: 'mysql',
      version,
      isMariaDB: /mariadb/i.test(version),
      threadId: Number(row.id),
      user: String(row.u),
      currentUser: String(row.cu),
      defaultSchema: (row.db as string) ?? '',
      ssl: String(ssl[0]?.Value ?? '')
    }
  }

  protected isFatal(error: DbError): boolean {
    return fatalCodes.has(error.code ?? '')
  }

  protected changesSessionState(sql: string): boolean {
    return /^\s*(use|set\s+autocommit)\b/i.test(sql)
  }

  protected async syncSessionState(conn: Connection): Promise<void> {
    const [row] = await this.exec<Row[]>(conn, 'SELECT DATABASE() AS db, @@autocommit AS ac')
    this.currentDb = (row.db as string) ?? ''
    this.autocommit = Number(row.ac) === 1
  }

  protected stream(conn: Connection, sql: string): Promise<ExecResult> {
    return new Promise((resolve) => {
      const t0 = performance.now()
      let tFirst: number | undefined
      const resultSets: ResultSet[] = []
      let current: ResultSet | undefined
      let ok: { affectedRows?: number; insertId?: number; info?: string; warningStatus?: number } | undefined
      let error: DbError | undefined
      let settled = false

      const finish = async (): Promise<void> => {
        if (settled) return
        settled = true
        const tEnd = performance.now()
        tFirst ??= tEnd
        let warnings: SqlWarning[] = []
        if (!error && ok?.warningStatus) {
          const rows = await this.exec<Row[]>(conn, 'SHOW WARNINGS').catch(() => [] as Row[])
          warnings = rows.map((w) => ({ level: String(w.Level), code: Number(w.Code), message: String(w.Message) }))
        }
        resolve({
          resultSets,
          affectedRows: ok?.affectedRows,
          insertId: ok?.insertId,
          info: ok?.info,
          warnings,
          durationMs: tFirst - t0,
          fetchMs: tEnd - tFirst,
          error
        })
      }

      const query = conn.query({ sql, rowsAsArray: true })
      query.on('fields', (fields: FieldPacket[] | undefined) => {
        tFirst ??= performance.now()
        // statements without a result set (DML, DDL) report undefined fields
        if (!fields) return
        current = { columns: fields.map(toColumn), rows: [] }
        resultSets.push(current)
      })
      query.on('result', (row: unknown) => {
        if (Array.isArray(row)) current?.rows.push(row as Cell[])
        else {
          tFirst ??= performance.now()
          ok = row as typeof ok
        }
      })
      query.on('error', (err: unknown) => {
        error = toDbError(err)
        // syntax errors (ER_PARSE_ERROR) end with the line of the statement: "... near 'x' at line 3"
        const line = error.errno === 1064 ? / at line (\d+)$/.exec(error.message) : null
        if (line) error.line = Number(line[1])
        void finish()
      })
      query.on('end', () => void finish())
    })
  }

  /** Kills the running statement through a short-lived extra connection. */
  async cancel(): Promise<void> {
    const conn = await this.connect()
    try {
      await this.exec(conn, `KILL QUERY ${Number(this.info.threadId)}`)
    } finally {
      conn.end()
    }
  }
}
