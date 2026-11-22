import type { Component } from 'vue'
import type { MessageKey } from '@shared/i18n'
import type { ConnectionConfig, Engine } from '@shared/types'
import { sqliteExtensions } from '@shared/file-types'
import { alertError, confirm, openDialog, promptText } from '@/dialogs'
import { t } from '@/i18n'
import { useApp } from '@/stores/app'
import SchemaDialog from '@/components/workspace/SchemaDialog.vue'
import PostgresSchemaDialog from '@/components/workspace/PostgresSchemaDialog.vue'
import MssqlSchemaDialog from '@/components/workspace/MssqlSchemaDialog.vue'
import { engineLabels, type MaintenanceOp } from './engines'
import { reviewAndApply } from './review'
import type { Workspace } from './workspace'

export type ObjectKind = 'schema' | 'table' | 'view' | 'procedure' | 'function' | 'trigger' | 'column' | 'index' | 'fk'

export interface ObjectRef {
  kind: ObjectKind
  schema: string
  name?: string
  table?: string
}

export type StatementKind = 'name-short' | 'name-long' | 'select' | 'insert' | 'update' | 'delete' | 'create'

/** Builds the "Copy to Clipboard / Send to SQL Editor" texts for an object. */
export async function objectStatement(ws: Workspace, obj: ObjectRef, kind: StatementKind): Promise<string> {
  const d = ws.dialect
  const name = obj.name ?? obj.schema
  if (kind === 'name-short') return d.quoteIdentifier(name)
  if (kind === 'name-long') return obj.kind === 'schema' ? d.quoteIdentifier(obj.schema) : d.qualified(obj.schema, name)
  if (kind === 'create') {
    const ddlKind = obj.kind === 'schema' ? 'SCHEMA' : obj.kind === 'table' ? 'TABLE' : (obj.kind.toUpperCase() as 'VIEW')
    const ddl = await ws.meta.ddl(ddlKind, obj.schema, obj.name)
    const routine = obj.kind === 'procedure' || obj.kind === 'function' || obj.kind === 'trigger'
    // routine bodies contain `;`: the mysql client needs another delimiter around them
    if (d.rules.clientDelimiter && routine) return `DELIMITER $$\n${ddl}$$\nDELIMITER ;`
    // a T-SQL module, view included, must be alone in its batch
    if (d.rules.batchSeparator && (routine || obj.kind === 'view')) return `${ddl}\nGO`
    return `${ddl};`
  }
  const table = d.qualified(obj.schema, name)
  const cols = (await ws.meta.loadColumns(obj.schema, name)).map((c) => c.name)
  const q = cols.map(d.quoteIdentifier)
  switch (kind) {
    case 'select':
      return `SELECT ${q.map((c) => `${d.quoteIdentifier(name)}.${c}`).join(',\n    ')}\nFROM ${table};`
    case 'insert':
      return `INSERT INTO ${table}\n(${q.join(',\n')})\nVALUES\n(${cols.map((c) => `<{${c}: }>`).join(',\n')});`
    case 'update':
      return `UPDATE ${table}\nSET\n${q.map((c, i) => `${c} = <{${cols[i]}: }>`).join(',\n')}\nWHERE <{where_expression}>;`
    case 'delete':
      return `DELETE FROM ${table}\nWHERE <{where_expression}>;`
  }
}

/** Opens a new query tab with `sql` and runs it ("Select Rows"); closing it unchanged asks nothing. */
export async function runInNewTab(ws: Workspace, sql: string, title?: string): Promise<void> {
  const tab = ws.newQueryTab(sql, title, undefined, true, sql)
  // the editor instance is created when the tab is rendered
  for (let i = 0; i < 50 && !tab.editor; i++) await new Promise((r) => setTimeout(r, 20))
  await ws.execute(tab, 'all')
}

export function selectRows(ws: Workspace, schema: string, table: string): Promise<void> {
  return runInNewTab(ws, `SELECT * FROM ${ws.dialect.qualified(schema, table)};`, table)
}

export function sendToEditor(ws: Workspace, text: string): void {
  const tab = ws.activeQueryTab ?? ws.newQueryTab()
  const editor = tab.editor
  if (!editor) {
    tab.model.setValue(tab.model.getValue() + text)
    return
  }
  const sel = editor.getSelection()!
  editor.executeEdits('send-to-editor', [{ range: sel, text, forceMoveMarkers: true }])
  editor.focus()
}

const dropTitles: Record<string, MessageKey> = {
  schema: 'workspace.drop.schema',
  table: 'workspace.drop.table',
  view: 'workspace.drop.view',
  procedure: 'workspace.drop.procedure',
  function: 'workspace.drop.function',
  trigger: 'workspace.drop.trigger'
}

const dropKeyword: Record<string, string> = {
  schema: 'SCHEMA',
  table: 'TABLE',
  view: 'VIEW',
  procedure: 'PROCEDURE',
  function: 'FUNCTION',
  trigger: 'TRIGGER'
}

/** Drop with the choice between reviewing the SQL and dropping right away. */
export async function dropObject(ws: Workspace, obj: ObjectRef): Promise<void> {
  const d = ws.dialect
  const target = obj.kind === 'schema' ? d.quoteIdentifier(obj.schema) : d.qualified(obj.schema, obj.name!)
  // a PostgreSQL trigger belongs to its table
  const on = obj.kind === 'trigger' && d.engine === 'postgres' ? ` ON ${d.qualified(obj.schema, obj.table!)}` : ''
  // a PostgreSQL schema has to be emptied first, while MySQL drops a schema with its objects
  const cascade = obj.kind === 'schema' && d.engine === 'postgres' ? ' CASCADE' : ''
  const sql = `DROP ${dropKeyword[obj.kind]} ${obj.kind === 'trigger' && on ? d.quoteIdentifier(obj.name!) : target}${on}${cascade}`
  const choice = await window.api.ui.message({
    type: 'warning',
    message: t(dropTitles[obj.kind], { name: obj.kind === 'schema' ? obj.schema : `${obj.schema}.${obj.name}` }),
    detail: t('workspace.drop.detail'),
    buttons: [t('workspace.drop.review'), t('workspace.drop.dropNow'), t('common.cancel')],
    defaultId: 0,
    cancelId: 2
  })
  if (choice === 2) return
  const ok = choice === 0 ? await reviewAndApply(ws, [sql]) : (await ws.runStatements([sql])).ok
  if (ok) {
    if (obj.kind === 'schema') ws.refreshAfterDdl()
    else {
      ws.meta.invalidate(obj.schema)
      void ws.meta.loadObjects(obj.schema)
    }
  }
}

export async function truncateTable(ws: Workspace, schema: string, table: string): Promise<void> {
  const choice = await window.api.ui.message({
    type: 'warning',
    message: t('workspace.truncate.message', { name: `${schema}.${table}` }),
    detail: t('workspace.truncate.detail'),
    buttons: [t('workspace.drop.review'), t('workspace.truncate.truncateNow'), t('common.cancel')],
    defaultId: 0,
    cancelId: 2
  })
  if (choice === 2) return
  // SQLite has no TRUNCATE: a DELETE without WHERE (SQLite's truncate optimization), exempt from Safe Updates
  const target = ws.dialect.qualified(schema, table)
  const sql = ws.dialect.engine === 'sqlite' ? `DELETE FROM ${target}` : `TRUNCATE TABLE ${target}`
  if (choice === 0) await reviewAndApply(ws, [sql], { exempt: [sql] })
  else await ws.runStatements([sql], { exempt: [sql] })
}

export function maintenance(ws: Workspace, op: MaintenanceOp, schema: string, table: string): Promise<void> {
  return runInNewTab(ws, `${op.statement(ws.dialect, schema, table)};`, `${op.name} ${table}`)
}

/** Rebuilds the database file of a schema (SQLite VACUUM); the outcome goes to the output, a failure also to a message box. */
export async function vacuumDatabase(ws: Workspace, schema: string): Promise<void> {
  const statement = ws.features.vacuumDatabase
  if (!statement) return
  const r = await ws.runStatements([statement(ws.dialect, schema)])
  if (!r.ok) await alertError(t('database.vacuumFailed', { name: ws.schemaLabel(schema) }), r.error)
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- type of a .vue import, not read by typescript-eslint
const schemaDialogs: Partial<Record<Engine, Component>> = { postgres: PostgresSchemaDialog, mssql: MssqlSchemaDialog }

export async function schemaDialog(ws: Workspace, schema: string | null): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- type of a .vue import, not read by typescript-eslint
  await openDialog(schemaDialogs[ws.dialect.engine] ?? SchemaDialog, { ws, schema })
}

/** Saves a connection and opens it in a new tab. */
async function openConnection(config: ConnectionConfig): Promise<void> {
  await window.api.connections.save(config)
  await useApp().connect(config)
}

/**
 * A new, empty SQLite database file, opened as a file opened directly (no
 * tile, listed among the recent files). A file chosen in the save dialog is
 * replaced, unless a connection tab has it open.
 */
export async function newSqliteDatabase(): Promise<void> {
  const file = await window.api.files.chooseSave({
    title: t('connection.newDatabase'),
    defaultPath: 'database.sqlite',
    filters: [{ name: t('connection.sqliteDatabases'), extensions: sqliteExtensions }]
  })
  if (!file) return
  const app = useApp()
  // a connection through a channel has a path of another machine
  if (app.workspaces.some((w) => !w.config.channel && w.config.file === file)) {
    await alertError(t('database.sqliteInUse', { file }))
    return
  }
  try {
    await window.api.files.newSqlite(file)
  } catch (err) {
    await alertError(t('database.sqliteFailed', { file }), (err as Error).message)
    return
  }
  await app.openFile(file)
}

/**
 * New Database: a session is bound to one database, so the new one is opened
 * in a connection of its own (a copy of this one, on the new database).
 * SQLite: a new database file.
 */
export async function newDatabase(ws: Workspace): Promise<void> {
  if (ws.dialect.engine === 'sqlite') return newSqliteDatabase()
  const name = (await promptText(t('database.createTitle'), t('database.name'), 'new_database'))?.trim()
  if (!name || !(await reviewAndApply(ws, [`CREATE DATABASE ${ws.dialect.quoteIdentifier(name)}`]))) return
  const open = await confirm(
    t('database.openConnectionTitle', { name }),
    t('database.openConnectionDetail', { engine: engineLabels[ws.dialect.engine], name }),
    t('database.openConnection')
  )
  if (!open) return
  const copy: ConnectionConfig = {
    ...(JSON.parse(JSON.stringify(ws.config)) as ConnectionConfig),
    id: crypto.randomUUID(),
    name: t('database.connectionName', { name: ws.config.name, database: name }),
    database: name,
    // the schema set as default in this database may not exist in the new one
    defaultSchema: '',
    lastConnected: undefined
  }
  await openConnection(copy)
}
