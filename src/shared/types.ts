// Types shared between main, preload and renderer (IPC contract).

import type { LanguagePack } from './i18n'

/** Database engine of a connection; MariaDB is a flavour of 'mysql' (see ServerInfo.isMariaDB). */
export type Engine = 'mysql' | 'postgres' | 'sqlite' | 'mssql'

export type ConnectionMethod = 'tcp' | 'socket' | 'ssh'
export type SslMode = 'disabled' | 'preferred' | 'required' | 'verify_ca' | 'verify_identity'
export type ConnectionEnvironment = 'production' | 'staging' | 'test' | 'development'

export interface ConnectionConfig {
  id: string
  /** Display name; "Group/Name" places the connection in a group on the home screen. */
  name: string
  /** Shown as a coloured label on the tile and the connection tab; no other effect. */
  environment?: ConnectionEnvironment
  engine: Engine
  method: ConnectionMethod
  host: string
  port: number
  socket: string
  user: string
  /** PostgreSQL or SQL Server database the session is bound to. */
  database: string
  /** SQLite database file. */
  file: string
  /** Id of the Channel to the machine holding the SQLite file: `file` is then a path on that machine. */
  channel?: string
  defaultSchema: string
  ssl: { mode: SslMode; ca: string; cert: string; key: string; cipher: string }
  ssh: { host: string; port: number; user: string; keyFile: string }
  options: { compress: boolean; connectTimeout: number; sqlMode: string; others: string }
  /** Keychain service name used by MySQL Workbench, used to fetch the password lazily. */
  workbenchKeychain?: string
  lastConnected?: number
  /** A file opened directly (File menu, drop, Finder): never stored, its query tabs are not saved. */
  temporary?: boolean
  /** CSV file opened as the only table of a hidden SQLite database (engine 'sqlite', temporary). */
  csv?: string
}

/** A verified link to another machine, saved with a name and used by SQLite connections. */
export interface Channel {
  id: string
  name: string
  kind: 'ssh'
  host: string
  port: number
  user: string
  /** Empty: ssh-agent or password. */
  keyFile: string
  /**
   * A host of the user's OpenSSH configuration (`~/.ssh/config`). With it `host`, `port`, `user`
   * and `keyFile` do not count: address, user, keys and ProxyJump are read from that
   * configuration at every connection.
   */
  configHost?: string
}

export interface ChannelResult {
  ok: boolean
  error?: DbError
  /** Which secret is missing or rejected, so the renderer can prompt for it. */
  needs?: 'sshPassword' | 'sshPassphrase'
  /** browseOpen: handle for browseList and browseClose. */
  browseId?: string
}

/** The entries of a folder of a channel's machine. */
export interface RemoteListing {
  /** Absolute path of the folder. */
  path: string
  entries: { name: string; dir: boolean; size: number }[]
  error?: string
}

/** State of a CSV connection against its file. */
export interface CsvStatus {
  /** Committed changes not written to the file yet. */
  changed: boolean
  /** The user connection has a transaction open, whose changes saving would not include. */
  transaction: boolean
}

export interface CsvSaveResult {
  ok?: boolean
  /** The file changed on disk since it was read or saved: nothing was written. */
  conflict?: boolean
  error?: string
}

/** 'password' is the database password (stored as 'mysql' by earlier versions). */
export type SecretKind = 'password' | 'ssh' | 'sshPassphrase'

export interface Credentials {
  password?: string
  sshPassword?: string
  sshPassphrase?: string
  /** Store the supplied secrets for later sessions. */
  save?: boolean
}

export interface ServerInfo {
  engine: Engine
  version: string
  isMariaDB: boolean
  threadId: number
  user: string
  currentUser: string
  defaultSchema: string
  /** Database the session is bound to, for the engines whose navigator lists its schemas (PostgreSQL, SQL Server). */
  database?: string
  ssl: string
  /** Local endpoint the server is reachable at (tunnel endpoint for SSH connections). */
  endpoint: { host: string; port: number; socket?: string }
}

export interface OpenSessionResult {
  ok: boolean
  sessionId?: string
  info?: ServerInfo
  error?: DbError
  /** Which secret is missing or rejected, so the renderer can prompt for it. */
  needs?: 'password' | 'sshPassword' | 'sshPassphrase'
}

export interface DbError {
  message: string
  code?: string
  errno?: number
  sqlState?: string
  /** Line of the error in the text sent to the server (1 = first line), when the server reports it. */
  line?: number
}

/** How result values of a column are shown: numbers align right, bit values print as numbers. */
export type ColumnKind = 'number' | 'text' | 'binary' | 'bit' | 'geometry'

export interface ColumnInfo {
  name: string
  orgName: string
  table: string
  orgTable: string
  schema: string
  /** Type as the engine names it, e.g. INT UNSIGNED, VARCHAR, int4. */
  type: string
  kind: ColumnKind
  length: number
  decimals: number
  /** Character set (MySQL collation id, or 'binary'); '' when the engine does not report it. */
  charset: string
  /** Engine specific column attributes shown in the Field Types view (e.g. NOT_NULL PRI_KEY). */
  attributes: string
}

/** Cell values: strings for text/dates/decimals, numbers for ints/floats, bytes for binary data. */
export type Cell = string | number | null | Uint8Array

export interface ResultSet {
  columns: ColumnInfo[]
  rows: Cell[][]
}

export interface SqlWarning {
  level: string
  code: number
  message: string
}

export interface ExecResult {
  resultSets: ResultSet[]
  affectedRows?: number
  insertId?: number
  info?: string
  warnings: SqlWarning[]
  durationMs: number
  fetchMs: number
  error?: DbError
  /** The connection had to be re-established before running the statement. */
  reconnected?: boolean
  /** Database the statement moved the session to (SQL Server USE): the catalog is reloaded. */
  database?: string
}

/** Options of DbSession.execute. */
export interface ExecOptions {
  /**
   * Skips the client-side Safe Updates check: a statement the app generated to change every row on purpose
   * (Truncate Table on SQLite, a DELETE without WHERE). The server's own setting (MySQL) still applies.
   */
  skipSafeUpdates?: boolean
  /**
   * The statement continues a transaction opened by the previous ones (runStatements with `transaction`):
   * if the user connection is lost the statement is not run on a new connection, where it would run outside
   * the transaction the server rolled back. The result is an error; `reconnected` tells whether the
   * connection was already reopened (otherwise it reopens at the next statement).
   */
  inTransaction?: boolean
}

export type Row = Record<string, unknown>

/** Switching autocommit on for an engine without a session switch ends the open transaction. */
export interface AutocommitResult {
  /** How the open transaction ended: 'ROLLBACK' when it had failed; '' when none was open. */
  ended: '' | 'COMMIT' | 'ROLLBACK'
  error?: DbError
}

export interface QueryResult {
  rows: Row[]
  error?: DbError
}

export interface Settings {
  limitRows: number
  safeUpdates: boolean
  stopOnError: boolean
  editorFontSize: number
  editorFontFamily: string
  wordWrap: boolean
  showInvisibles: boolean
  uppercaseKeywords: boolean
  confirmDataChanges: boolean
  mysqldumpPath: string
  mysqlPath: string
  pgDumpPath: string
  psqlPath: string
  theme: 'system' | 'light' | 'dark'
  /** Show information_schema, performance_schema, mysql and sys in the navigator. */
  showSystemSchemas: boolean
  /** What double-click (and Enter) on a table or view in the navigator does. */
  tableDoubleClick: 'openData' | 'insertName'
  /** 'system' or a code of knownLanguages; read at startup. */
  language: string
  /** GPU compositing; off (default), the frames are composited on the CPU. Read at startup. */
  hardwareAcceleration: boolean
  /** How many SQLite and CSV files opened directly the home screen lists. */
  recentFiles: number
  window?: { x?: number; y?: number; width: number; height: number; maximized?: boolean }
}

export const defaultSettings: Settings = {
  limitRows: 1000,
  safeUpdates: true,
  stopOnError: true,
  editorFontSize: 13,
  editorFontFamily: 'Menlo, Monaco, "SF Mono", monospace',
  wordWrap: false,
  showInvisibles: false,
  uppercaseKeywords: true,
  confirmDataChanges: true,
  mysqldumpPath: '',
  mysqlPath: '',
  pgDumpPath: '',
  psqlPath: '',
  theme: 'system',
  showSystemSchemas: false,
  tableDoubleClick: 'openData',
  language: 'system',
  hardwareAcceleration: false,
  recentFiles: 20
}

/** A SQLite or CSV file opened directly, listed on the home screen. */
export interface RecentFile {
  path: string
  openedAt: number
  /** The file is no longer on disk. */
  missing: boolean
}

/** An installed language, with the names of knownLanguages. */
export interface LanguageInfo {
  code: string
  name: string
  nativeName: string
}

/** The language loaded at startup, the built-in languages and the packs in the languages folder. */
export interface I18nInfo {
  /** null when the app runs in English. */
  pack: LanguagePack | null
  /** Languages built into the app, whose packs a pack of the folder overrides entry by entry. */
  builtIn: LanguageInfo[]
  installed: LanguageInfo[]
  /** The language follows the system (no explicit, available choice in the settings). */
  system: boolean
  /** The system's preferred languages, as resolveLocale takes them. */
  systemLanguages: string[]
}

export interface WorkspaceTab {
  title: string
  content: string
  filePath?: string
  /** Content differs from the file on disk. */
  dirty?: boolean
  /** Text the app opened the tab with: an unchanged tab closes without asking. */
  generatedContent?: string
}

export interface WorkspaceState {
  tabs: WorkspaceTab[]
  active: number
  /** Default schema at the last save, selected again on the next connection. */
  defaultSchema?: string
}

export interface HistoryEntry {
  time: number
  connectionId: string
  sql: string
  durationMs?: number
  error?: boolean
}

export interface Snippet {
  id: string
  /** The panel shows a connection only the snippets of its engine. */
  engine: Engine
  category: string
  title: string
  sql: string
}

export interface MenuItemSpec {
  id?: string
  label?: string
  type?: 'separator' | 'checkbox'
  checked?: boolean
  enabled?: boolean
  submenu?: MenuItemSpec[]
}

export interface ToolInfo {
  path: string
  flavor: 'mysql' | 'mariadb' | 'postgres' | 'mssql'
  version: string
}

export interface DumpOptions {
  /** Schema → tables to dump; an empty list means the whole schema. */
  objects: { schema: string; tables: string[] }[]
  content: 'both' | 'data' | 'structure'
  routines: boolean
  events: boolean
  triggers: boolean
  singleTransaction: boolean
  createSchema: boolean
  target: { kind: 'file'; path: string } | { kind: 'folder'; path: string }
}

export interface ImportOptions {
  source: { kind: 'file'; path: string } | { kind: 'folder'; path: string }
  defaultSchema: string
  /** SQL Server: the new database the .bacpac file is imported into. */
  database?: string
}

/** SQL Server backup of a database to a .bak file on the server's disk. */
export interface MssqlBackupOptions {
  database: string
  path: string
}

/** SQL Server restore of a .bak file on the server's disk as `database`, moving each file to `physical`. */
export interface MssqlRestoreOptions {
  path: string
  database: string
  /** Overwrite an existing database (WITH REPLACE). */
  replace: boolean
  moves: { logical: string; physical: string }[]
}

/** A schema to copy and its name in the target. */
export interface CopySchemaRef {
  source: string
  target: string
}

export interface CopyOptions {
  schemas: CopySchemaRef[]
  content: 'structure' | 'both'
  routines: boolean
  triggers: boolean
  events: boolean
  definers: 'keep' | 'remove'
  existing: 'stop' | 'recreate'
  /** Source collation → target collation. */
  collations: Record<string, string>
  target: { kind: 'file'; path: string } | { kind: 'instance' } | { kind: 'connection'; sessionId: string }
}

export interface CopyPreview {
  /** Collations used by the chosen schemas, with their character set. */
  used: { name: string; charset: string }[]
  /** Collations of the target server (empty for a file target), with the default of each charset. */
  available: { name: string; charset: string; isDefault: boolean }[]
  /** Target schemas that already exist. */
  existing: string[]
}

export interface ToolProgress {
  jobId: string
  /** 0..1, or -1 when unknown. */
  progress: number
  message?: string
  log?: string
  done?: boolean
  error?: string
}

export interface ImportedConnections {
  imported: number
  skipped: number
  error?: string
}

export interface FileContent {
  path: string
  content: string
}

/** A cell of a file read for import: dates of spreadsheets as `YYYY-MM-DD[ HH:MM:SS]`, errors and empty cells null. */
export type SpreadCell = string | number | boolean | null

/** A sheet of a file read for import (d-spread, or the CSV reader without it). */
export interface SpreadSheetData {
  /** d-spread's format name (`xlsx`, `ods`, `csv`…). */
  format: string
  /** Sheet names of a workbook; empty for a CSV read without d-spread. */
  sheets: string[]
  /** Index of the sheet in `rows`. */
  sheet: number
  /** From row 1 of the file, header included: `rows[n - 1]` is row n, empty for a row without data. */
  rows: SpreadCell[][]
}
