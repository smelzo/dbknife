import { markRaw, reactive } from 'vue'
import type { ConnectionConfig, CsvStatus, ExecOptions, ExecResult, HistoryEntry, ServerInfo, Settings } from '@shared/types'
import { splitStatements, statementAt, type Statement } from '@shared/sql/splitter'
import { applyRowLimit, statementKind } from '@shared/sql/analyze'
import { dialectFor, type Dialect } from '@shared/sql/dialect'
import { redactSecrets } from '@shared/sql/accounts'
import type { MessageKey } from '@shared/i18n'
import { t } from '@/i18n'
import { monaco } from '@/editor/monaco'
import { createCatalog, type Query } from './catalog/catalog'
import { confirmDiscardEdits } from './confirm'
import { engineFeatures, type EngineFeatures } from './engines'
import { Metadata } from './metadata'
import { createResultTab, hasEdits, resolveEditTarget, verticalText, type ResultTab } from './results'
import { formatDuration } from './format'

export type AdminPage = 'status' | 'connections' | 'users' | 'variables' | 'export' | 'import' | 'backup' | 'agent' | 'copy'

const adminTitles: Record<AdminPage, MessageKey> = {
  status: 'workspace.admin.status',
  connections: 'workspace.admin.connections',
  users: 'workspace.admin.users',
  variables: 'workspace.admin.variables',
  export: 'workspace.admin.export',
  import: 'workspace.admin.import',
  backup: 'workspace.admin.backup',
  agent: 'workspace.admin.agent',
  copy: 'workspace.admin.copy'
}

export type RoutineKind = 'VIEW' | 'PROCEDURE' | 'FUNCTION' | 'TRIGGER'

export interface QueryTab {
  kind: 'query'
  id: string
  title: string
  filePath?: string
  /** Content of the file on disk, to detect unsaved changes. */
  savedContent?: string
  dirty: boolean
  /** Text the app opened the tab with (Select Rows, Table Maintenance…): closing it unchanged loses nothing. */
  generatedContent?: string
  /**
   * The model holds more than white space, other than `generatedContent`: text closing the tab would lose;
   * reactive, unlike the model's content.
   */
  textToSave: boolean
  model: monaco.editor.ITextModel
  editor?: monaco.editor.IStandaloneCodeEditor
  results: ResultTab[]
  activeResult: number
  running: boolean
  /** Message of the first statement that failed in the last execution; empty when none failed. */
  lastError: string
}

export type EditorTab =
  | QueryTab
  /** `dirty`: the editor has changes not applied to the database (set by the editor). */
  | { kind: 'table'; id: string; title: string; schema: string; table: string | null; dirty?: boolean }
  | { kind: 'routine'; id: string; title: string; schema: string; objectType: RoutineKind; name: string | null; table?: string; dirty?: boolean }
  | { kind: 'inspector'; id: string; title: string; schema: string; table?: string }
  /** `schema`: the schema the page starts from (Copy Database from the schema's menu). */
  | { kind: 'admin'; id: string; title: string; page: AdminPage; schema?: string }
  | { kind: 'search'; id: string; title: string }

export type OutputStatus = 'running' | 'ok' | 'warning' | 'error' | 'info'

export interface OutputEntry {
  n: number
  time: Date
  action: string
  message: string
  duration: string
  status: OutputStatus
}

export interface StatementOutcome {
  ok: boolean
  error?: string
  result?: ExecResult
  /** Index of the statement that failed. */
  failedAt?: number
}

// dialects are shared constants: keep Vue from wrapping them in reactive proxies
for (const engine of ['mysql', 'postgres', 'sqlite', 'mssql'] as const) markRaw(dialectFor(engine))

let tabSeq = 1
const uid = (): string => `t${tabSeq++}`

export const routineTitles: Record<RoutineKind, MessageKey> = {
  VIEW: 'workspace.tab.view',
  PROCEDURE: 'workspace.tab.procedure',
  FUNCTION: 'workspace.tab.function',
  TRIGGER: 'workspace.tab.trigger'
}

/**
 * The script closing a query tab loses: a file's unsaved changes, or text saved to no file
 * unless `textKept` (the connection closes and `persist` brings the text back with it).
 */
const unsavedScript = (tab: QueryTab, textKept: boolean): boolean =>
  (tab.dirty && !!tab.filePath) || (!textKept && !tab.filePath && tab.textToSave)

/** Text worth saving in a tab without a file: more than white space, and not the text the app generated. */
const textToSave = (value: string, generatedContent: string | undefined): boolean => /\S/.test(value) && value !== generatedContent

/** Grid edits not applied; reads `version` because the edits themselves are not reactive. */
function editsPending(rt: ResultTab): boolean {
  void rt.version
  return hasEdits(rt)
}

/** Formats the "Message" column for an executed statement. */
function outcomeMessage(r: ExecResult): string {
  if (r.error) return t('output.errorCode', { code: r.error.errno ?? r.error.code ?? '', message: r.error.message })
  if (r.resultSets.length) return r.resultSets.map((s) => t('output.rowsReturned', { count: s.rows.length })).join(', ')
  let msg = t('output.rowsAffected', { count: r.affectedRows ?? 0 })
  if (r.info) msg += ` ${r.info.trim()}`
  if (r.warnings.length) msg = t('output.withWarnings', { message: msg, count: r.warnings.length })
  return msg
}

/**
 * State and behaviour of one connection tab: its server session, query and
 * object editor tabs, the action output and the catalog cache.
 */
export class Workspace {
  readonly id = uid()
  sessionId = ''
  info: ServerInfo | null = null
  connected = false
  meta: Metadata
  tabs: EditorTab[] = []
  activeTab = ''
  output: OutputEntry[] = []
  history: HistoryEntry[] = []
  defaultSchema = ''
  autocommit = true
  busy = false
  sidebarVisible = true
  outputVisible = true
  secondaryVisible = false
  /** Object selected in the navigator, shown by the information panel. */
  selection: { kind: string; schema?: string; name?: string } | null = null
  /** @internal */
  outputSeq = 1
  /** @internal */
  resultSeq = 1
  /** @internal */
  cancelRequested = false
  /** @internal */
  saveTimer: ReturnType<typeof setTimeout> | undefined
  /** CSV connection: what its file does not have yet, refreshed after each statement. */
  csvStatus: CsvStatus = { changed: false, transaction: false }

  constructor(
    public config: ConnectionConfig,
    public settings: Settings
  ) {
    this.meta = Metadata.create(createCatalog(config.engine, this.query))
  }

  /** Runs a query on the auxiliary connection, throwing on errors. */
  readonly query: Query = async (sql, params) => {
    const r = await window.api.db.query(this.sessionId, sql, params)
    if (r.error) throw new Error(r.error.message)
    return r.rows
  }

  static create(config: ConnectionConfig, settings: Settings): Workspace {
    return reactive(new Workspace(config, settings)) as Workspace
  }

  get title(): string {
    return this.config.name
  }

  get dialect(): Dialect {
    return dialectFor(this.config.engine)
  }

  get features(): EngineFeatures {
    const f = engineFeatures(this.config.engine)
    // the hidden database of a CSV file is no database of the user's, nor its SQL a SQLite user's
    return this.config.csv ? { ...f, newDatabase: false, snippets: false, vacuumDatabase: undefined } : f
  }

  /** Closing loses work: CSV changes not saved, or a transaction whose changes saving would not include. */
  get csvPending(): boolean {
    return this.csvStatus.changed || this.csvStatus.transaction
  }

  /** Closing the connection loses work: CSV changes, a transaction left open by autocommit off, tabs with changes not applied or saved. */
  get pendingWork(): boolean {
    return this.csvPending || (!this.autocommit && this.connected) || this.tabs.some((tab) => this.tabNeedsConfirm(tab, true))
  }

  get activeEditorTab(): EditorTab | undefined {
    return this.tabs.find((t) => t.id === this.activeTab)
  }

  get activeQueryTab(): QueryTab | undefined {
    const t = this.activeEditorTab
    return t?.kind === 'query' ? t : undefined
  }

  /** Name the navigator shows for a schema: the file's name (the CSV file's for a CSV connection) for the one that is the database file. */
  schemaLabel(schema: string): string {
    const file = this.config.csv || this.config.file
    return schema === this.features.fileSchema && file ? file.split(/[\\/]/).pop()! : schema
  }

  visibleSchemas(): string[] {
    return this.settings.showSystemSchemas ? this.meta.schemas : this.meta.schemas.filter((s) => !this.dialect.isSystemSchema(s))
  }

  // --- lifecycle ------------------------------------------------------------

  async attach(sessionId: string, info: ServerInfo): Promise<void> {
    this.sessionId = sessionId
    this.info = info
    this.connected = true
    this.defaultSchema = info.defaultSchema
    this.log('info', t('output.connected', { name: this.config.name }), `${info.version} — ${info.currentUser}`)
    void this.meta.loadSchemas().catch((e: Error) => this.log('error', t('output.loadSchemas'), e.message))
    const saved = this.config.temporary ? null : await window.api.workspace.load(this.config.id)
    if (saved?.tabs.length) {
      for (const t of saved.tabs) {
        const tab = this.newQueryTab(t.content, t.title, t.filePath, false, t.generatedContent)
        if (t.filePath && !t.dirty) tab.savedContent = t.content
        else if (t.filePath) tab.savedContent = undefined
        tab.dirty = !!t.dirty
      }
      const active = this.tabs[saved.active] ?? this.tabs[0]
      this.activeTab = active.id
    } else {
      this.newQueryTab()
    }
    this.history = (await window.api.history.load(7)).filter((h) => h.connectionId === this.config.id)
    const sql = saved?.defaultSchema && saved.defaultSchema !== this.defaultSchema && this.dialect.useSchema(saved.defaultSchema)
    if (sql) await this.runStatement(sql, { history: false })
  }

  async close(): Promise<void> {
    this.persist(true)
    for (const t of this.tabs) if (t.kind === 'query') t.model.dispose()
    this.tabs = []
    if (this.sessionId) await window.api.db.close(this.sessionId)
    this.connected = false
  }

  // --- CSV file ---------------------------------------------------------------

  async refreshCsv(): Promise<void> {
    if (!this.config.csv || !this.connected) return
    try {
      this.csvStatus = await window.api.csv.status(this.sessionId)
    } catch {
      // the session is closing
    }
  }

  /** Writes the table back to the CSV file, committing an open transaction first if the user agrees. */
  async saveCsv(): Promise<boolean> {
    const file = this.config.csv
    if (!file) return false
    const ask = async (message: string, detail: string | undefined, okLabel: string): Promise<boolean> =>
      (await window.api.ui.message({ type: 'question', message, detail, buttons: [okLabel, t('common.cancel')], defaultId: 0, cancelId: 1 })) === 0
    const fail = async (error: string): Promise<false> => {
      this.log('error', t('output.csvSave', { file }), error)
      await window.api.ui.message({ type: 'error', message: t('workspace.csv.saveFailed', { file }), detail: error, buttons: [t('common.ok')] })
      return false
    }
    if (this.busy) return fail(t('workspace.busy'))
    await this.refreshCsv()
    if (this.csvStatus.transaction) {
      if (!(await ask(t('workspace.csv.commitFirst'), t('workspace.csv.commitFirstDetail'), t('workspace.csv.commitAndSave')))) return false
      if (!(await this.runStatements(['COMMIT'])).ok) return false
    }
    let r = await window.api.csv.save(this.sessionId, false)
    if (r.conflict) {
      if (!(await ask(t('workspace.csv.changedOnDisk', { file }), undefined, t('workspace.csv.overwrite')))) return false
      r = await window.api.csv.save(this.sessionId, true)
    }
    await this.refreshCsv()
    if (r.error) return fail(r.error)
    this.log('ok', t('output.csvSave', { file }), t('output.csvSaved'))
    return true
  }

  /**
   * Asks about the work closing the connection tab loses: CSV changes, the transaction
   * left open by autocommit off, tabs with changes not applied or saved. False when the user cancels.
   */
  async confirmClose(): Promise<boolean> {
    await this.refreshCsv()
    // the CSV question covers the transaction too: saving the file commits it first
    const csv = this.csvPending
    if (csv) {
      const r = await window.api.ui.message({
        type: 'question',
        message: t('workspace.saveChanges', { name: this.config.name }),
        detail: t('workspace.csv.unsavedDetail'),
        buttons: [t('common.save'), t('common.cancel'), t('common.dontSave')],
        defaultId: 0,
        cancelId: 1
      })
      if (r === 1) return false
      if (r === 0 && !(await this.saveCsv())) return false
    }
    // asked before the transaction is ended: cancelling here leaves it as it is
    const pending = this.tabs.filter((tab) => this.tabNeedsConfirm(tab, true))
    if (pending.length) {
      const r = await window.api.ui.message({
        type: 'warning',
        message: t('workspace.pendingOnClose', { name: this.config.name }),
        detail: pending.map((tab) => tab.title).join('\n'),
        buttons: [t('workspace.closeAnyway'), t('common.cancel')],
        defaultId: 1,
        cancelId: 1
      })
      if (r !== 0) return false
    }
    if (csv || this.autocommit || !this.connected) return true
    const r = await window.api.ui.message({
      type: 'question',
      message: t('workspace.transactionOnClose', { name: this.config.name }),
      detail: t('workspace.transactionOnCloseDetail'),
      buttons: [t('workspace.commitAndClose'), t('common.cancel'), t('workspace.rollbackAndClose')],
      defaultId: 0,
      cancelId: 1
    })
    if (r === 1) return false
    const ended = await this.runStatements([r === 0 ? 'COMMIT' : 'ROLLBACK'])
    if (ended.ok) return true
    // no transaction to end (SQLite opens one lazily), a lost connection, a statement running: closing must stay possible
    const failed = await window.api.ui.message({
      type: 'warning',
      message: t('workspace.transactionEndFailed', { message: ended.error ?? '' }),
      detail: t('workspace.transactionOnCloseDetail'),
      buttons: [t('workspace.closeAnyway'), t('common.cancel')],
      defaultId: 1,
      cancelId: 1
    })
    return failed === 0
  }

  /** Saves the open query tabs so they come back on the next connection (not for a temporary one). */
  persist(now = false): void {
    clearTimeout(this.saveTimer)
    if (this.config.temporary) return
    const save = (): void => {
      const queries = this.tabs.filter((t): t is QueryTab => t.kind === 'query')
      // an object editor or admin page may be active: then reopen on the last query tab
      const index = queries.findIndex((t) => t.id === this.activeTab)
      const active = index >= 0 ? index : queries.length - 1
      void window.api.workspace.save(this.config.id, {
        active,
        defaultSchema: this.defaultSchema,
        tabs: queries.map((t) => ({
          title: t.title,
          content: t.model.getValue(),
          filePath: t.filePath,
          dirty: t.dirty,
          generatedContent: t.generatedContent
        }))
      })
    }
    if (now) save()
    else this.saveTimer = setTimeout(save, 800)
  }

  // --- tabs ---------------------------------------------------------------

  /** `generatedContent`: the text the app opened the tab with, when it is not the user's (see QueryTab). */
  newQueryTab(content = '', title?: string, filePath?: string, activate = true, generatedContent?: string): QueryTab {
    const used = new Set(this.tabs.map((t) => t.title))
    let n = 1
    while (used.has(t('workspace.tab.query', { n }))) n++
    const model = markRaw(monaco.editor.createModel(content, this.dialect.editorLanguage))
    const tab = reactive<QueryTab>({
      kind: 'query',
      id: uid(),
      title: title ?? t('workspace.tab.query', { n }),
      filePath,
      savedContent: filePath ? content : undefined,
      dirty: false,
      generatedContent,
      textToSave: textToSave(content, generatedContent),
      model,
      results: [],
      activeResult: 0,
      running: false,
      lastError: ''
    }) as QueryTab
    model.onDidChangeContent(() => {
      const value = model.getValue()
      tab.textToSave = textToSave(value, tab.generatedContent)
      tab.dirty = tab.filePath ? value !== tab.savedContent : false
      this.persist()
    })
    this.tabs.push(tab)
    if (activate) this.activeTab = tab.id
    this.persist()
    return tab
  }

  openTab(tab: EditorTab): void {
    // the same object, whatever the state of its editor
    const key = (t: EditorTab): string => JSON.stringify({ ...t, id: '', dirty: undefined })
    const same = this.tabs.find((t) => t.kind === tab.kind && t.kind !== 'query' && key(t) === key(tab))
    if (same) {
      this.activeTab = same.id
      return
    }
    this.tabs.push(tab)
    this.activeTab = tab.id
  }

  openTableEditor(schema: string, table: string | null): void {
    this.openTab({ kind: 'table', id: uid(), title: t('workspace.tab.table', { name: table ?? 'new_table' }), schema, table })
  }

  openRoutineEditor(schema: string, objectType: RoutineKind, name: string | null, table?: string): void {
    this.openTab({
      kind: 'routine',
      id: uid(),
      title: t(routineTitles[objectType], { name: name ?? 'new_' + objectType.toLowerCase() }),
      schema,
      objectType,
      name,
      table
    })
  }

  openInspector(schema: string, table?: string): void {
    this.openTab({ kind: 'inspector', id: uid(), title: t('workspace.tab.inspector', { name: table ?? schema }), schema, table })
  }

  openAdmin(page: AdminPage, schema?: string): void {
    this.openTab({ kind: 'admin', id: uid(), title: t(adminTitles[page]), page, schema })
  }

  openSearch(): void {
    this.openTab({ kind: 'search', id: uid(), title: t('workspace.tab.search') })
  }

  /**
   * Closing the tab loses work: a script not saved, grid edits or editor changes not applied.
   * `closingConnection`: the whole connection tab closes, keeping the query text saved to no file
   * (not a temporary connection's, which `persist` does not save).
   */
  tabNeedsConfirm(tab: EditorTab, closingConnection: boolean): boolean {
    if (tab.kind === 'query') {
      return unsavedScript(tab, closingConnection && !this.config.temporary) || tab.results.some(editsPending)
    }
    return (tab.kind === 'table' || tab.kind === 'routine') && !!tab.dirty
  }

  /** Asks about the work closing the tab loses (`tabNeedsConfirm`); false when the user cancels. */
  async confirmCloseTab(tab: EditorTab): Promise<boolean> {
    if (tab.kind !== 'query') {
      const r = await window.api.ui.message({
        type: 'warning',
        message: t('workspace.discardEditorChanges', { name: tab.title }),
        detail: t('workspace.discardEditorChangesDetail'),
        buttons: [t('results.discardEdits.discard'), t('common.cancel')],
        defaultId: 1,
        cancelId: 1
      })
      return r === 0
    }
    if (unsavedScript(tab, false)) {
      const r = await window.api.ui.message({
        type: 'question',
        message: t('workspace.saveChanges', { name: tab.title }),
        detail: tab.filePath ? undefined : t('workspace.unsavedQueryDetail'),
        buttons: [t('common.save'), t('common.cancel'), t('common.dontSave')],
        defaultId: 0,
        cancelId: 1
      })
      if (r === 1) return false
      if (r === 0 && !(await this.saveTab(tab))) return false
    }
    return confirmDiscardEdits(tab.results)
  }

  async closeTab(id: string): Promise<boolean> {
    const tab = this.tabs.find((t) => t.id === id)
    if (!tab) return true
    if (this.tabNeedsConfirm(tab, false) && !(await this.confirmCloseTab(tab))) return false
    // the dialogs leave the tab list free to change
    const at = this.tabs.indexOf(tab)
    if (at < 0) return true
    this.tabs.splice(at, 1)
    if (tab.kind === 'query') tab.model.dispose()
    if (this.activeTab === id) this.activeTab = this.tabs[Math.min(at, this.tabs.length - 1)]?.id ?? ''
    this.persist()
    return true
  }

  cycleTab(delta: number): void {
    if (!this.tabs.length) return
    const i = this.tabs.findIndex((t) => t.id === this.activeTab)
    this.activeTab = this.tabs[(i + delta + this.tabs.length) % this.tabs.length].id
  }

  // --- files ----------------------------------------------------------------

  async openScript(): Promise<void> {
    const file = await window.api.files.openSql()
    if (!file) return
    const current = this.activeQueryTab
    const name = file.path.split('/').pop()!
    if (current && !current.filePath && current.model.getValue().trim() === '') {
      current.filePath = file.path
      current.title = name
      current.savedContent = file.content
      current.model.setValue(file.content)
      current.dirty = false
    } else {
      this.newQueryTab(file.content, name, file.path)
    }
  }

  async saveTab(tab: QueryTab, saveAs = false): Promise<boolean> {
    let path = saveAs ? undefined : tab.filePath
    if (!path) {
      path =
        (await window.api.files.chooseSave({
          title: t('workspace.saveScript'),
          defaultPath: `${tab.title.replace(/\.sql$/i, '')}.sql`,
          filters: [{ name: t('main.files.sqlFiles'), extensions: ['sql'] }]
        })) ?? undefined
      if (!path) return false
    }
    const content = tab.model.getValue()
    await window.api.files.write(path, content)
    tab.filePath = path
    tab.title = path.split('/').pop()!
    tab.savedContent = content
    tab.dirty = false
    this.persist()
    return true
  }

  async revertTab(tab: QueryTab): Promise<void> {
    if (!tab.filePath) return
    const content = await window.api.files.read(tab.filePath)
    tab.savedContent = content
    tab.model.setValue(content)
    tab.dirty = false
  }

  // --- output ---------------------------------------------------------------

  log(status: OutputStatus, action: string, message: string, duration = ''): OutputEntry {
    const entry = reactive<OutputEntry>({ n: this.outputSeq++, time: new Date(), action, message, duration, status })
    this.output.push(entry)
    if (this.output.length > 2000) this.output.splice(0, this.output.length - 2000)
    return entry
  }

  /** @internal */
  record(sql: string, r?: ExecResult): void {
    const entry: HistoryEntry = {
      time: Date.now(),
      connectionId: this.config.id,
      sql,
      durationMs: r?.durationMs,
      error: !!r?.error
    }
    this.history.push(entry)
    void window.api.history.append([entry])
  }

  // --- execution --------------------------------------------------------------

  /** Runs one statement on the user connection, or reads its plan (`explain`), logging it in the action output. */
  async runStatement(sql: string, opts: { history?: boolean; explain?: boolean } & ExecOptions = {}): Promise<ExecResult> {
    // passwords never reach the output or the history in clear
    const shown = redactSecrets(opts.explain ? `${this.dialect.explainPrefix ?? ''}${sql}` : sql)
    const entry = this.log('running', shown.replace(/\s+/g, ' ').slice(0, 300), t('output.running'))
    const r = await (opts.explain ? window.api.db.explain(this.sessionId, sql) : window.api.db.execute(this.sessionId, sql, { skipSafeUpdates: opts.skipSafeUpdates, inTransaction: opts.inTransaction }))
    if (r.reconnected) this.log('warning', t('output.reconnect'), t('output.reconnected'))
    entry.status = r.error ? 'error' : r.warnings.length ? 'warning' : 'ok'
    entry.message = outcomeMessage(r)
    entry.duration = r.resultSets.length
      ? `${formatDuration(r.durationMs)} / ${formatDuration(r.fetchMs)}`
      : formatDuration(r.durationMs + r.fetchMs)
    // PostgreSQL notices have no numeric code: their severity is shown instead
    for (const w of r.warnings) this.log('warning', '', `${w.code || w.level} ${w.message}`)
    if (opts.history !== false) this.record(shown, r)
    // SQL Server: USE moved the session (and the catalog's connection) to another database
    if (r.database) {
      if (this.info) this.info = { ...this.info, database: r.database }
      this.refreshAfterDdl()
    }
    if (r.database || (!r.error && !opts.explain && /^(USE|SET)$/.test(statementKind(sql, this.dialect.rules)))) {
      this.defaultSchema = await window.api.db.currentSchema(this.sessionId)
      this.persist()
    }
    void this.refreshCsv()
    return r
  }

  /**
   * Runs a script of statements (DDL from editors, result edits). Stops at the first error.
   * `history: false` keeps the statements out of the history. `transaction`: the script is one transaction,
   * so after its first statement a lost connection fails it without running the statement on a new
   * connection, outside the transaction the server dropped (ExecOptions.inTransaction). `exempt`: statements
   * generated by the app that run without the client-side Safe Updates check (ExecOptions.skipSafeUpdates),
   * compared by their text.
   */
  async runStatements(statements: string[], opts: { history?: boolean; transaction?: boolean; exempt?: string[] } = {}): Promise<StatementOutcome> {
    if (this.busy) return { ok: false, error: t('workspace.busy') }
    this.busy = true
    try {
      let last: ExecResult | undefined
      for (const [i, sql] of statements.entries()) {
        last = await this.runStatement(sql, { history: opts.history, skipSafeUpdates: opts.exempt?.includes(sql.trim()), inTransaction: opts.transaction && i > 0 })
        if (opts.transaction && i > 0 && last.reconnected) {
          return { ok: false, error: t('workspace.transactionLost', { n: i + 1, total: statements.length }), result: last, failedAt: i }
        }
        if (last.error) return { ok: false, error: outcomeMessage(last), result: last, failedAt: i }
      }
      return { ok: true, result: last }
    } finally {
      this.busy = false
    }
  }

  /**
   * Executes the editor content: the selection or the whole
   * script ("all"), or the statement under the caret.
   */
  async execute(tab: QueryTab, mode: 'all' | 'current' | 'explain' | 'vertical'): Promise<void> {
    if (this.busy || !tab.editor) return
    const model = tab.model
    const editor = tab.editor
    const dialect = this.dialect
    const selection = editor.getSelection()
    let statements: Statement[]
    if (mode === 'all') {
      if (selection && !selection.isEmpty()) {
        const base = model.getOffsetAt(selection.getStartPosition())
        statements = splitStatements(model.getValueInRange(selection), dialect.rules).map((s) => ({
          ...s,
          start: s.start + base,
          end: s.end + base,
          delimiterEnd: s.delimiterEnd + base
        }))
      } else {
        statements = splitStatements(model.getValue(), dialect.rules)
      }
    } else {
      const all = splitStatements(model.getValue(), dialect.rules)
      const caret = model.getOffsetAt(editor.getPosition() ?? { lineNumber: 1, column: 1 })
      const current = statementAt(all, caret)
      statements = current ? [current] : []
    }
    if (!statements.length) return
    // the results that are not pinned are replaced: their grid edits would be lost
    if (!(await confirmDiscardEdits(tab.results.filter((r) => !r.pinned)))) return
    // another execution may have started while the question was open
    if (this.busy) return

    monaco.editor.setModelMarkers(model, 'exec', [])
    tab.lastError = ''
    tab.results = tab.results.filter((r) => r.pinned)
    tab.activeResult = 0
    this.busy = tab.running = true
    this.cancelRequested = false
    try {
      for (const st of statements) {
        if (st.goCount !== undefined && st.goCount !== 1) this.log('warning', `GO ${st.goCount}`, t('output.goCountIgnored'))
        const explain = mode === 'explain'
        const sql = explain ? st.text : applyRowLimit(st.text, this.settings.limitRows, dialect)
        const r = await this.runStatement(sql, { history: true, explain })
        if (r.error) {
          // the first failure is the one that explains the others
          if (!tab.lastError) tab.lastError = outcomeMessage(r)
          // a Stop asked by the user is no news worth reopening the Output for
          if (!this.cancelRequested) this.outputVisible = true
          let start = model.getPositionAt(st.start)
          let end = model.getPositionAt(st.end)
          // only the line the server names; the row limit and the explain prefix add no lines
          const line = r.error.line ? Math.min(start.lineNumber + r.error.line - 1, end.lineNumber) : 0
          if (line) {
            if (line > start.lineNumber) start = new monaco.Position(line, 1)
            if (line < end.lineNumber) end = new monaco.Position(line, model.getLineMaxColumn(line))
          }
          monaco.editor.setModelMarkers(model, 'exec', [
            {
              severity: monaco.MarkerSeverity.Error,
              message: r.error.message,
              startLineNumber: start.lineNumber,
              startColumn: start.column,
              endLineNumber: end.lineNumber,
              endColumn: end.column
            }
          ])
          if (this.cancelRequested || this.settings.stopOnError || statements.length === 1) break
          continue
        }
        r.resultSets.forEach((set, i) => {
          const tableName = set.columns[0]?.orgTable
          const singleTable = tableName && set.columns.every((c) => c.orgTable === tableName)
          const n = this.resultSeq++
          const title = mode === 'explain' ? t('workspace.result.explain', { n }) : singleTable ? `${tableName} ${n}` : t('workspace.result.title', { n })
          const rt = reactive(createResultTab(set, sql, r, title, dialect)) as ResultTab
          if (explain) rt.view = 'plan'
          rt.plan = explain
          // sql differs from the statement only when applyRowLimit added the limit, which binds the first result set
          rt.rowLimit = i === 0 && sql !== st.text ? this.settings.limitRows : 0
          rt.limited = rt.rowLimit > 0 && set.rows.length === rt.rowLimit
          if (mode === 'vertical') {
            rt.view = 'text'
            rt.text = verticalText(set)
          }
          tab.results.push(rt)
          if (mode !== 'explain') void resolveEditTarget(rt, this.meta)
          else rt.readOnlyReason = t('results.readOnly.plain')
        })
        if (/^(CREATE|ALTER|DROP|RENAME)$/.test(statementKind(st.text, dialect.rules))) this.refreshAfterDdl()
        if (this.cancelRequested) break
      }
    } finally {
      this.busy = tab.running = false
    }
    if (tab.results.length) tab.activeResult = tab.results.length - 1
  }

  /** Re-runs the query behind a result tab (after applying edits or on refresh). */
  async refreshResult(rt: ResultTab): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      const r = await this.runStatement(rt.sql, { explain: rt.plan })
      const set = r.resultSets[0]
      if (!set) return
      rt.limited = rt.rowLimit > 0 && set.rows.length === rt.rowLimit
      rt.columns = set.columns
      rt.rows = markRaw(set.rows)
      rt.changes.clear()
      rt.deleted.clear()
      rt.added.length = 0
      rt.exec = r
      rt.version++
    } finally {
      this.busy = false
    }
  }

  async cancel(): Promise<void> {
    if (!this.busy) return
    this.cancelRequested = true
    await window.api.db.cancel(this.sessionId)
  }

  refreshAfterDdl(): void {
    this.meta.invalidate()
    void this.meta.loadSchemas()
  }

  async setDefaultSchema(schema: string): Promise<void> {
    const sql = this.dialect.useSchema(schema)
    if (!sql) return
    const r = await this.runStatements([sql])
    if (r.ok) this.defaultSchema = schema
  }

  async setAutocommit(on: boolean): Promise<void> {
    const sql = this.dialect.autocommitStatement(on)
    if (sql) {
      if ((await this.runStatements([sql])).ok) this.autocommit = on
      return
    }
    if (this.busy) return
    // the driver opens transactions itself; switching autocommit on commits the open one
    const r = await window.api.db.setAutocommit(this.sessionId, on)
    void this.refreshCsv()
    const action = t(on ? 'output.autocommitOn' : 'output.autocommitOff')
    if (r.error) {
      this.log('error', action, t('output.errorCode', { code: r.error.code ?? r.error.errno ?? '', message: r.error.message }))
      return
    }
    this.autocommit = on
    const message = t(on ? 'output.autocommitOnMessage' : 'output.autocommitOffMessage')
    this.log(
      'info',
      action,
      r.ended === 'COMMIT'
        ? t('output.transactionCommitted', { message })
        : r.ended === 'ROLLBACK'
          ? t('output.transactionRolledBack', { message })
          : message
    )
  }

  async commit(): Promise<void> {
    await this.runStatements(['COMMIT'])
  }

  async rollback(): Promise<void> {
    await this.runStatements(['ROLLBACK'])
  }

  async reconnect(): Promise<void> {
    // a trivial statement goes through the session's reconnect logic
    const r = await this.runStatements(['SELECT 1'])
    if (r.ok) this.log('info', t('output.reconnect'), t('output.connectionAlive'))
  }
}
