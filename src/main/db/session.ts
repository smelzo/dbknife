import { homedir } from 'node:os'
import { t } from '@shared/i18n'
import { dialectFor } from '@shared/sql/dialect'
import type { AutocommitResult, ConnectionConfig, DbError, Engine, ExecOptions, ExecResult, QueryResult, ServerInfo } from '@shared/types'

export interface SessionSecrets {
  password?: string
  sshPassword?: string
  sshPassphrase?: string
}

/**
 * A connection tab's database session. Server engines keep a "user"
 * connection running the editor's statements (its own transaction and
 * session state) and an auxiliary connection for metadata and administration.
 */
export interface DbSession {
  readonly id: string
  readonly config: ConnectionConfig
  info: ServerInfo
  open(): Promise<void>
  /** Runs one statement on the user connection, collecting every result set. */
  execute(sql: string, opts?: ExecOptions): Promise<ExecResult>
  /** Execution plan of a statement, run on the user connection (see Dialect.explainPrefix). */
  explain(sql: string): Promise<ExecResult>
  /** Stops the statement running on the user connection. */
  cancel(): Promise<void>
  /** Runs a query on the auxiliary connection; placeholders follow the engine's driver. */
  query(sql: string, params?: unknown[]): Promise<QueryResult>
  currentSchema(): string
  /**
   * Autocommit mode of engines without a session switch (PostgreSQL, SQLite):
   * off, the driver opens a transaction before statements (see
   * opensTransaction); on, the open transaction is committed.
   */
  setAutocommit?(on: boolean): Promise<AutocommitResult>
  /** Database password, for the external client tools. */
  readonly password: string
  close(): void
}

export const expandHome = (path: string): string => (path.startsWith('~/') ? homedir() + path.slice(1) : path)

export function toDbError(err: unknown): DbError {
  const e = err as { message?: string; code?: string; errno?: number; sqlState?: string; sqlMessage?: string }
  return { message: e.sqlMessage || e.message || String(err), code: e.code, errno: e.errno, sqlState: e.sqlState }
}

/** Result of a statement refused by the client-side Safe Updates check (see violatesSafeUpdates). */
export function safeUpdatesRefusal(): ExecResult {
  return { resultSets: [], warnings: [], durationMs: 0, fetchMs: 0, error: { message: t('main.session.safeUpdates'), code: 'SAFE_UPDATES' } }
}

/**
 * Result of a statement of a transaction not run because the user connection was lost before it
 * (ExecOptions.inTransaction): the transaction ended with the old connection, so on the new one the
 * statement would run outside it.
 */
export function transactionLost(): ExecResult {
  return { resultSets: [], warnings: [], durationMs: 0, fetchMs: 0, error: { message: t('main.session.transactionLost') }, reconnected: true }
}

/** The statement returning the plan of `sql`, for the engines with an explain prefix; the others' drivers override explain. */
export function explainStatement(engine: Engine, sql: string): string {
  const prefix = dialectFor(engine).explainPrefix
  if (prefix === null) throw new Error(`${engine} sessions build execution plans in their driver`)
  return prefix + sql
}

/**
 * Id of the channel a connection opens its file through: SQLite database files only, whatever
 * `channel` holds for the others (their SSH secrets are the connection's own).
 */
export const channelId = (config: ConnectionConfig): string | undefined =>
  config.engine === 'sqlite' && !config.csv ? config.channel || undefined : undefined

/** Whether the engine needs a password to open a session. */
export const usesPassword = (engine: Engine): boolean => engine !== 'sqlite'

/** The server rejected the credentials: the renderer asks for the password again. */
export function isAuthError(engine: Engine, error: DbError): boolean {
  if (engine === 'mysql') return error.errno === 1045
  if (engine === 'postgres') return error.code === '28P01' || error.code === '28000'
  if (engine === 'mssql') return error.errno === 18456 || error.code === 'ELOGIN'
  return false
}
