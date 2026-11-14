import type {
  AutocommitResult,
  ConnectionConfig,
  CopyOptions,
  CopyPreview,
  CopySchemaRef,
  Credentials,
  CsvSaveResult,
  CsvStatus,
  DumpOptions,
  ExecOptions,
  ExecResult,
  FileContent,
  HistoryEntry,
  I18nInfo,
  ImportedConnections,
  ImportOptions,
  LanguageInfo,
  MenuItemSpec,
  MssqlBackupOptions,
  MssqlRestoreOptions,
  OpenSessionResult,
  QueryResult,
  RecentFile,
  SecretKind,
  Settings,
  Snippet,
  SpreadSheetData,
  ToolInfo,
  ToolProgress,
  WorkspaceState
} from './types'

export interface FileFilter {
  name: string
  extensions: string[]
}

export interface MessageOptions {
  type?: 'none' | 'info' | 'error' | 'question' | 'warning'
  message: string
  detail?: string
  buttons?: string[]
  defaultId?: number
  cancelId?: number
}

/** Menu state the renderer reports so the native menu reflects the active editor. */
export interface MenuState {
  inSqlEditor: boolean
  /** Commands the active connection's engine does not offer. */
  unavailable: string[]
  stopOnError: boolean
  autocommit: boolean
  limitRows: number
}

/** API exposed by the preload script as `window.api`. */
export interface Api {
  connections: {
    list(): Promise<ConnectionConfig[]>
    save(config: ConnectionConfig): Promise<void>
    remove(id: string): Promise<void>
    /** Persists the tile order of the home screen. */
    reorder(ids: string[]): Promise<void>
    importWorkbench(): Promise<ImportedConnections>
  }
  secrets: {
    status(id: string): Promise<Record<SecretKind, boolean>>
    set(id: string, kind: SecretKind, value: string): Promise<boolean>
    clear(id: string): Promise<void>
  }
  db: {
    open(connectionId: string, credentials: Credentials): Promise<OpenSessionResult>
    test(config: ConnectionConfig, credentials: Credentials): Promise<OpenSessionResult>
    /** Opens a session for a connection that is not stored (ConnectionConfig.temporary). */
    openTemporary(config: ConnectionConfig): Promise<OpenSessionResult>
    close(sessionId: string): Promise<void>
    /** Runs one statement on the session's user connection. */
    execute(sessionId: string, sql: string, opts?: ExecOptions): Promise<ExecResult>
    /**
     * Execution plan of one statement, run on the user connection: the
     * statement with Dialect.explainPrefix, or the driver's own way when the
     * dialect has none (SQL Server).
     */
    explain(sessionId: string, sql: string): Promise<ExecResult>
    /** Kills the statement running on the user connection. */
    cancel(sessionId: string): Promise<void>
    /** Runs a query on the auxiliary (metadata) connection. */
    query(sessionId: string, sql: string, params?: unknown[]): Promise<QueryResult>
    currentSchema(sessionId: string): Promise<string>
    /** Autocommit mode of engines that have no SQL statement for it (see Dialect.autocommitStatement). */
    setAutocommit(sessionId: string, on: boolean): Promise<AutocommitResult>
  }
  csv: {
    /** Whether a CSV connection has changes its file does not have yet. */
    status(sessionId: string): Promise<CsvStatus>
    /** Writes the table back to the CSV file; `overwrite` also when the file changed on disk. */
    save(sessionId: string, overwrite: boolean): Promise<CsvSaveResult>
  }
  tools: {
    find(sessionId: string): Promise<{ dump?: ToolInfo; client?: ToolInfo }>
    exportDump(sessionId: string, options: DumpOptions): Promise<string>
    importDump(sessionId: string, options: ImportOptions): Promise<string>
    /** Collations and existing schemas for a copy to the target session (the same id for the same instance, null for a file). */
    copyPreview(sessionId: string, schemas: CopySchemaRef[], targetSessionId: string | null): Promise<CopyPreview>
    /** Starts a Copy Database job (MySQL/MariaDB); returns its id. */
    copyDatabase(sessionId: string, options: CopyOptions): Promise<string>
    /** Starts a backup of a SQL Server database to a .bak file on the server; returns the job id. */
    mssqlBackup(sessionId: string, options: MssqlBackupOptions): Promise<string>
    /** Starts a restore of a .bak file on the SQL Server machine; returns the job id. */
    mssqlRestore(sessionId: string, options: MssqlRestoreOptions): Promise<string>
    cancel(jobId: string): Promise<void>
    onProgress(callback: (progress: ToolProgress) => void): () => void
  }
  files: {
    openSql(): Promise<FileContent | null>
    read(path: string): Promise<string>
    readBinary(path: string): Promise<Uint8Array>
    write(path: string, data: string | Uint8Array): Promise<void>
    /** Writes an xlsx with d-spread-write from its input lines (src/shared/spread-write.ts). */
    writeXlsx(path: string, lines: string[]): Promise<void>
    /** Whether d-spread and d-spread-write are there for this platform. */
    spreadAvailable(): Promise<boolean>
    /** A sheet of a spreadsheet or CSV file (the active sheet without `sheet`), read by d-spread; without it, as CSV. */
    readSpread(path: string, sheet?: number): Promise<SpreadSheetData>
    /** Open dialog for a file to import into a table: CSV, and spreadsheets where d-spread is there. */
    chooseImportFile(): Promise<string | null>
    chooseOpen(options: { title?: string; filters?: FileFilter[]; folder?: boolean }): Promise<string | null>
    chooseSave(options: { title?: string; defaultPath?: string; filters?: FileFilter[] }): Promise<string | null>
    /** Path on disk of a file dropped on the window. */
    pathForFile(file: File): string
    /** Shows the file selected in the Finder. */
    reveal(path: string): Promise<void>
    /** An empty SQLite database at `path`, replacing the file there (the save dialog has asked). */
    newSqlite(path: string): Promise<void>
  }
  /** SQLite and CSV files opened directly, most recent first, without those of a saved connection. */
  recentFiles: {
    list(): Promise<RecentFile[]>
    remove(path: string): Promise<void>
  }
  ui: {
    contextMenu(items: MenuItemSpec[]): Promise<string | null>
    message(options: MessageOptions): Promise<number>
    setMenuState(state: MenuState): void
    onMenu(callback: (command: string, fromShortcut: boolean) => void): () => void
    openExternal(url: string): Promise<void>
  }
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
  }
  workspace: {
    load(connectionId: string): Promise<WorkspaceState | null>
    save(connectionId: string, state: WorkspaceState): Promise<void>
  }
  history: {
    append(entries: HistoryEntry[]): Promise<void>
    load(days: number): Promise<HistoryEntry[]>
  }
  snippets: {
    load(): Promise<Snippet[]>
    save(snippets: Snippet[]): Promise<void>
  }
  i18n: {
    /** The language loaded at startup, read synchronously when the preload runs. */
    info: I18nInfo
    /** Packs in the languages folder now. */
    list(): Promise<LanguageInfo[]>
    /** Lets the user pick a pack file and installs it; null when cancelled. */
    install(): Promise<{ installed?: LanguageInfo; error?: string } | null>
    remove(code: string): Promise<void>
    openFolder(): Promise<void>
  }
  app: {
    /** Data export/import jobs still running. */
    jobsRunning(): Promise<number>
    /** Starts the app again, after the renderer has warned about the work a restart loses. */
    restart(): void
    /** The version downloaded and ready to install with a restart. */
    updateReady(): Promise<string | null>
    onUpdateReady(callback: (version: string) => void): () => void
    /** Files the system asks the app to open (Finder "Open With", Dock icon); those that arrived before the call too. */
    onOpenFile(callback: (path: string) => void): () => void
    /** Whether closing the window loses work (CSV changes not saved): then closing asks the renderer first. */
    setUnsaved(unsaved: boolean): void
    /** Closing the window or quitting waits for the renderer, which ends with closeConfirmed() unless the user cancels. */
    onCloseRequest(callback: () => void): () => void
    closeConfirmed(): void
  }
}
