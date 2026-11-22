import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'
import { t } from '@shared/i18n'
import type { AutocommitResult, ConnectionConfig, ExecOptions, ExecResult, QueryResult, ServerInfo } from '@shared/types'
import { statementKind } from '@shared/sql/analyze'
import { sqliteRules } from '@shared/sql/lexer'
import { violatesSafeUpdates } from '@shared/sql/safe-updates'
import { expandHome, explainStatement, safeUpdatesRefusal, transactionLost, type DbSession } from '../session'
import type { SqliteRequest, SqliteResponse } from './sqlite-process'
import processPath from './sqlite-process?modulePath'

/** How long a connection waits for a lock held by the other one (or another program). */
const busyTimeoutMs = 5000

/** One SQLite connection as a session uses it, wherever it runs. */
export interface SqliteLink {
  alive: boolean
  /** A request is waiting for its answer. */
  readonly busy: boolean
  request(req: SqliteRequest): Promise<SqliteResponse>
  /** Ends the connection: a statement running in SQLite stops, an open transaction rolls back. */
  kill(): void
}

/** One SQLite connection living in its own utility process. */
class Connection implements SqliteLink {
  private child: UtilityProcess
  private seq = 0
  private pending = new Map<number, (r: SqliteResponse) => void>()
  private spawned: Promise<void>
  alive = true

  constructor() {
    this.child = utilityProcess.fork(processPath, [], { serviceName: 'DBKnife SQLite' })
    this.spawned = new Promise((resolve) => this.child.once('spawn', resolve))
    this.child.on('message', (r: SqliteResponse) => {
      this.pending.get(r.id)?.(r)
      this.pending.delete(r.id)
    })
    this.child.on('exit', () => {
      this.alive = false
      for (const done of this.pending.values()) done({ id: 0, error: { message: t('main.sqlite.processEnded') } })
      this.pending.clear()
    })
  }

  /** A request is waiting for its answer. */
  get busy(): boolean {
    return this.pending.size > 0
  }

  async request(req: SqliteRequest): Promise<SqliteResponse> {
    await this.spawned
    if (!this.alive) return { id: 0, error: { message: t('main.sqlite.processEnded') } }
    const id = ++this.seq
    return new Promise((done) => {
      this.pending.set(id, done)
      this.child.postMessage({ ...req, id })
    })
  }

  /** Ends the process: a statement running in SQLite stops, an open transaction rolls back. */
  kill(): void {
    this.child.kill()
  }
}

/**
 * SQLite database file through node:sqlite. Like the server engines it keeps a
 * user connection (editor statements, transactions) and an auxiliary one
 * (catalog), each in a utility process so statements never block the main
 * process and Stop can end a running statement by killing its process.
 */
export class SqliteSession implements DbSession {
  readonly id = randomUUID()
  info!: ServerInfo
  private user?: SqliteLink
  private aux?: SqliteLink
  /** The auxiliary connection being reopened. */
  private auxOpening?: Promise<SqliteLink>
  private interrupted?: SqliteLink
  private autocommit = true

  constructor(
    readonly config: ConnectionConfig,
    private readonly safeUpdates = false,
    private readonly file = resolve(expandHome(config.file.trim()))
  ) {}

  /** What open() needs before the first connection. */
  protected prepare(): Promise<void> {
    // a missing file is created, but not its folder
    if (!existsSync(dirname(this.file))) return Promise.reject(new Error(t('main.sqlite.missingFolder', { file: this.file, folder: dirname(this.file) })))
    return Promise.resolve()
  }

  /** Where a connection runs; connect() opens the database on it. */
  protected newLink(): Promise<SqliteLink> {
    return Promise.resolve(new Connection())
  }

  private async connect(): Promise<SqliteLink> {
    const conn = await this.newLink()
    const r = await conn.request({ op: 'open', file: this.file, busyTimeoutMs })
    if (r.error) {
      conn.kill()
      throw Object.assign(new Error(r.error.message), { code: r.error.code, errno: r.error.errno })
    }
    return conn
  }

  async open(): Promise<void> {
    if (!this.config.file.trim()) throw new Error(t('main.sqlite.noFile'))
    await this.prepare()
    this.user = await this.connect()
    try {
      const r = (await this.user.request({ op: 'execute', sql: 'SELECT sqlite_version()', autocommit: true })).result as ExecResult
      if (r.error) throw new Error(r.error.message)
      this.info = {
        engine: 'sqlite',
        version: String(r.resultSets[0].rows[0][0]),
        isMariaDB: false,
        threadId: 0,
        user: '',
        currentUser: '',
        defaultSchema: 'main',
        ssl: '',
        endpoint: { host: this.file, port: 0 }
      }
      this.aux = await this.connect()
    } catch (err) {
      this.close()
      throw err
    }
  }

  async execute(sql: string, opts: ExecOptions = {}): Promise<ExecResult> {
    if (this.safeUpdates && !opts.skipSafeUpdates && violatesSafeUpdates(sql, sqliteRules)) return safeUpdatesRefusal()
    let reconnected = false
    let lost = false
    try {
      // after Stop the user connection is reopened silently: the interrupted statement already said so
      if (!this.user?.alive) {
        lost = true
        reconnected = !!this.user && this.user !== this.interrupted
        this.user = await this.connect()
      }
    } catch (err) {
      return { resultSets: [], warnings: [], durationMs: 0, fetchMs: 0, error: { message: (err as Error).message } }
    }
    if (lost && opts.inTransaction) return transactionLost()
    const conn = this.user
    const r = await conn.request({ op: 'execute', sql, autocommit: this.autocommit })
    if (conn === this.interrupted) {
      return {
        resultSets: [],
        warnings: [],
        durationMs: 0,
        fetchMs: 0,
        error: { message: t('main.sqlite.interrupted'), errno: 9 }
      }
    }
    const result = (r.result as ExecResult | undefined) ?? { resultSets: [], warnings: [], durationMs: 0, fetchMs: 0, error: r.error }
    // attached databases belong to a connection: keep the catalog's connection in step
    if (!result.error && /^(ATTACH|DETACH)$/.test(statementKind(sql, sqliteRules))) await this.query(sql)
    return { ...result, reconnected }
  }

  async explain(sql: string): Promise<ExecResult> {
    return this.execute(explainStatement('sqlite', sql))
  }

  /** A request on the auxiliary connection, reopened if its process ended. */
  protected async auxRequest(req: SqliteRequest): Promise<SqliteResponse> {
    if (this.aux?.alive) return this.aux.request(req)
    // requests coming together wait for the same connection: each opening its own would leave all but the last unused
    this.auxOpening ??= this.connect()
      .then((link) => (this.aux = link))
      .finally(() => (this.auxOpening = undefined))
    return (await this.auxOpening).request(req)
  }

  /** A request on the user connection; none when its process ended (after Stop). */
  protected async userRequest(req: SqliteRequest): Promise<SqliteResponse | undefined> {
    return this.user?.alive ? this.user.request(req) : undefined
  }

  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    try {
      const r = await this.auxRequest({ op: 'query', sql, params })
      return (r.result as QueryResult | undefined) ?? { rows: [], error: r.error }
    } catch (err) {
      return { rows: [], error: { message: (err as Error).message } }
    }
  }

  async setAutocommit(on: boolean): Promise<AutocommitResult> {
    this.autocommit = on
    if (!on || !this.user?.alive) return { ended: '' }
    const r = await this.user.request({ op: 'commit' })
    return { ended: r.committed ? 'COMMIT' : '', error: r.error }
  }

  /** Kills the user connection's process if a statement is running; the next statement reopens it. */
  cancel(): Promise<void> {
    if (this.user?.busy) {
      this.interrupted = this.user
      this.user.kill()
    }
    return Promise.resolve()
  }

  currentSchema(): string {
    return 'main'
  }

  get password(): string {
    return ''
  }

  close(): void {
    this.user?.kill()
    this.aux?.kill()
    this.user = this.aux = undefined
  }
}
