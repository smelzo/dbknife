import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dialectFor } from '@shared/sql/dialect'
import { violatesSafeUpdates } from '@shared/sql/safe-updates'
import type { ConnectionConfig, DbError, ExecOptions, ExecResult, QueryResult, Row, ServerInfo } from '@shared/types'
import { checkHostKey } from '../store'
import { expandHome, explainStatement, safeUpdatesRefusal, toDbError, transactionLost, type DbSession, type SessionSecrets } from './session'
import { openTunnel, type Tunnel } from './tunnel'

export interface Endpoint {
  host: string
  port: number
  socket?: string
}

/**
 * Session of a network server engine: an optional SSH tunnel, the user and
 * auxiliary connections, and the reconnection of a dropped user connection.
 * Drivers implement the protocol specific parts.
 */
export abstract class ServerSession<C> implements DbSession {
  readonly id = randomUUID()
  info!: ServerInfo
  protected user?: C
  protected aux?: C
  private tunnel?: Tunnel
  protected currentDb = ''
  protected autocommit = true
  /** The server enforces Safe Updates itself (set by initUser), so the client does not check statements. */
  protected readonly serverSafeUpdates: boolean = false

  constructor(
    readonly config: ConnectionConfig,
    readonly secrets: SessionSecrets,
    protected safeUpdates: boolean
  ) {
    this.currentDb = config.defaultSchema
  }

  protected abstract readonly defaultPort: number
  /** Opens a connection to the endpoint (session state of the user connection is set by initUser). */
  protected abstract connect(): Promise<C>
  protected abstract isAlive(conn: C): boolean
  protected abstract destroy(conn: C): void
  /** Session settings of a new user connection (safe updates, SQL mode, autocommit). */
  protected abstract initUser(conn: C): Promise<void>
  /** Server and session information read on a new user connection. */
  protected abstract readInfo(conn: C): Promise<Omit<ServerInfo, 'endpoint'>>
  /** Runs one statement collecting every result set; errors are reported in the result. */
  protected abstract stream(conn: C, sql: string): Promise<ExecResult>
  /** Runs a query returning its rows; errors are thrown. */
  protected abstract run(conn: C, sql: string, params?: unknown[]): Promise<Row[]>
  /** The error means the connection is gone, so the statement may be retried on a new one. */
  protected abstract isFatal(error: DbError): boolean
  /** The statement may have changed the default schema or the autocommit mode. */
  protected abstract changesSessionState(sql: string): boolean
  /** Reads the default schema and autocommit mode back from the user connection. */
  protected abstract syncSessionState(conn: C): Promise<void>
  abstract cancel(): Promise<void>

  protected async endpoint(): Promise<Endpoint> {
    const c = this.config
    if (c.method === 'socket') return { host: 'localhost', port: 0, socket: c.socket }
    if (c.method !== 'ssh') return { host: c.host || '127.0.0.1', port: c.port || this.defaultPort }
    if (!this.tunnel?.isOpen()) {
      const [sshHost, sshPortText] = c.ssh.host.split(':')
      const keyFile = c.ssh.keyFile ? expandHome(c.ssh.keyFile) : ''
      this.tunnel = await openTunnel({
        host: sshHost,
        port: Number(sshPortText || c.ssh.port || 22),
        username: c.ssh.user,
        password: this.secrets.sshPassword,
        privateKey: keyFile ? readFileSync(keyFile) : undefined,
        passphrase: this.secrets.sshPassphrase,
        dstHost: c.host || '127.0.0.1',
        dstPort: c.port || this.defaultPort,
        verifyHostKey: (fp) => checkHostKey(`${sshHost}:${sshPortText || c.ssh.port || 22}`, fp)
      })
    }
    return { host: '127.0.0.1', port: this.tunnel.localPort }
  }

  private async loadInfo(conn: C): Promise<void> {
    const info = await this.readInfo(conn)
    this.currentDb = info.defaultSchema
    this.info = { ...info, endpoint: await this.endpoint() }
  }

  async open(): Promise<void> {
    this.user = await this.connect()
    try {
      await this.initUser(this.user)
      await this.loadInfo(this.user)
      this.aux = await this.connect()
    } catch (err) {
      this.close()
      throw err
    }
  }

  protected async userConnection(): Promise<{ conn: C; reconnected: boolean }> {
    if (this.user && this.isAlive(this.user)) return { conn: this.user, reconnected: false }
    this.user = await this.connect()
    await this.initUser(this.user)
    await this.loadInfo(this.user)
    return { conn: this.user, reconnected: true }
  }

  private async auxConnection(): Promise<C> {
    if (!this.aux || !this.isAlive(this.aux)) this.aux = await this.connect()
    return this.aux
  }

  async execute(sql: string, opts: ExecOptions = {}): Promise<ExecResult> {
    if (this.safeUpdates && !this.serverSafeUpdates && !opts.skipSafeUpdates && violatesSafeUpdates(sql, dialectFor(this.config.engine).rules)) return safeUpdatesRefusal()
    let conn: C
    let reconnected: boolean
    try {
      ;({ conn, reconnected } = await this.userConnection())
    } catch (err) {
      return { resultSets: [], warnings: [], durationMs: 0, fetchMs: 0, error: toDbError(err) }
    }
    if (reconnected && opts.inTransaction) return transactionLost()
    const result = await this.stream(conn, sql)
    // the server dropped the connection (timeout, restart): retry once on a fresh one. Not inside a transaction,
    // which ended with the connection: the error stays, and the connection reopens at the next statement
    if (result.error && this.isFatal(result.error) && !reconnected && !opts.inTransaction) {
      try {
        ;({ conn } = await this.userConnection())
        return { ...(await this.stream(conn, sql)), reconnected: true }
      } catch (err) {
        return { ...result, error: toDbError(err) }
      }
    }
    if (this.changesSessionState(sql) && !result.error) await this.syncSessionState(conn)
    return { ...result, reconnected }
  }

  async explain(sql: string): Promise<ExecResult> {
    return this.execute(explainStatement(this.config.engine, sql))
  }

  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    try {
      return { rows: await this.run(await this.auxConnection(), sql, params) }
    } catch (err) {
      return { rows: [], error: toDbError(err) }
    }
  }

  currentSchema(): string {
    return this.currentDb
  }

  get password(): string {
    return this.secrets.password ?? ''
  }

  close(): void {
    if (this.user) this.destroy(this.user)
    if (this.aux) this.destroy(this.aux)
    this.tunnel?.close()
    this.user = this.aux = undefined
  }
}
