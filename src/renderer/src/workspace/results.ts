import { markRaw } from 'vue'
import type { Cell, ColumnInfo, ExecResult, ResultSet } from '@shared/types'
import type { Dialect } from '@shared/sql/dialect'
import { t } from '@/i18n'
import type { Metadata } from './metadata'

/** A value typed as `\func EXPR` in the grid is sent as a raw SQL expression. */
export const FUNC_PREFIX = '\\func '

export interface EditTarget {
  schema: string
  table: string
  /** Indexes of the primary key columns inside the result. */
  keyColumns: number[]
}

export type ResultView = 'grid' | 'form' | 'fields' | 'stats' | 'plan' | 'text'

export interface ResultTab {
  id: number
  title: string
  sql: string
  /** SQL dialect of the connection, for the statements generated from the result. */
  dialect: Dialect
  columns: ColumnInfo[]
  /** Raw rows (not reactive: result sets can be large). Bump `version` after changing them. */
  rows: Cell[][]
  exec: Pick<ExecResult, 'durationMs' | 'fetchMs' | 'warnings'>
  target: EditTarget | null
  readOnlyReason: string
  pinned: boolean
  view: ResultView
  /** The rows are the execution plan of `sql` (api.db.explain). */
  plan: boolean
  /** Row limit added to `sql` for this result set (0: none). */
  rowLimit: number
  /** The result reached `rowLimit`: the query may have more rows. */
  limited: boolean
  /** Pending edits keyed by original row index. */
  changes: Map<number, Map<number, Cell>>
  deleted: Set<number>
  /** New rows; `undefined` cells take the column default. */
  added: (Cell | undefined)[][]
  version: number
  text?: string
}

let nextId = 1

export function createResultTab(set: ResultSet, sql: string, exec: ResultTab['exec'], title: string, dialect: Dialect): ResultTab {
  return {
    id: nextId++,
    title,
    sql,
    dialect,
    columns: set.columns,
    rows: markRaw(set.rows),
    exec,
    target: null,
    readOnlyReason: t('results.checking'),
    pinned: false,
    view: 'grid',
    plan: false,
    rowLimit: 0,
    limited: false,
    changes: markRaw(new Map()),
    deleted: markRaw(new Set()),
    added: markRaw([]),
    version: 0
  }
}

/**
 * A result is editable when every column comes from the same base table and
 * the table's whole primary key is part of the result.
 */
export async function resolveEditTarget(tab: ResultTab, meta: Metadata): Promise<void> {
  const cols = tab.columns
  const first = cols[0]
  if (!first || !first.orgTable || !first.schema) {
    tab.readOnlyReason = t('results.readOnly.notSingleTable')
    return
  }
  if (cols.some((c) => c.orgTable !== first.orgTable || c.schema !== first.schema || !c.orgName)) {
    tab.readOnlyReason = t('results.readOnly.mixedColumns')
    return
  }
  let tableCols: Awaited<ReturnType<Metadata['loadColumns']>>
  try {
    tableCols = await meta.loadColumns(first.schema, first.orgTable)
  } catch {
    tableCols = []
  }
  if (tableCols.length === 0) {
    // orgTable is an alias source we cannot resolve (e.g. a view's base table)
    tab.readOnlyReason = t('results.readOnly.tableNotFound')
    return
  }
  const pk = tableCols.filter((c) => c.key === 'PRI').map((c) => c.name)
  if (pk.length === 0) {
    tab.readOnlyReason = t('results.readOnly.noPrimaryKey')
    return
  }
  const keyColumns = pk.map((name) => cols.findIndex((c) => c.orgName.toLowerCase() === name.toLowerCase()))
  if (keyColumns.includes(-1)) {
    tab.readOnlyReason = t('results.readOnly.keyNotInResult')
    return
  }
  tab.target = { schema: first.schema, table: first.orgTable, keyColumns }
  tab.readOnlyReason = ''
}

export const rowCount = (tab: ResultTab): number => tab.rows.length + tab.added.length

export function cellValue(tab: ResultTab, row: number, col: number): Cell | undefined {
  if (row >= tab.rows.length) return tab.added[row - tab.rows.length]?.[col]
  const changed = tab.changes.get(row)
  if (changed?.has(col)) return changed.get(col)
  return tab.rows[row][col]
}

export const isModified = (tab: ResultTab, row: number, col: number): boolean => !!tab.changes.get(row)?.has(col)

export const hasEdits = (tab: ResultTab): boolean => tab.changes.size > 0 || tab.deleted.size > 0 || tab.added.length > 0

export function setCell(tab: ResultTab, row: number, col: number, value: Cell): void {
  if (row >= tab.rows.length) {
    tab.added[row - tab.rows.length][col] = value
  } else {
    const original = tab.rows[row][col]
    const map = tab.changes.get(row) ?? new Map<number, Cell>()
    if (sameValue(original, value)) map.delete(col)
    else map.set(col, value)
    if (map.size) tab.changes.set(row, map)
    else tab.changes.delete(row)
  }
  tab.version++
}

function sameValue(a: Cell, b: Cell): boolean {
  if (a instanceof Uint8Array || b instanceof Uint8Array) return false
  return a === b || (a !== null && b !== null && String(a) === String(b))
}

export function addRow(tab: ResultTab): number {
  tab.added.push(new Array<Cell | undefined>(tab.columns.length).fill(undefined))
  tab.version++
  return rowCount(tab) - 1
}

export function deleteRows(tab: ResultTab, rows: number[]): void {
  for (const r of [...rows].sort((a, b) => b - a)) {
    if (r >= tab.rows.length) tab.added.splice(r - tab.rows.length, 1)
    else tab.deleted.add(r)
  }
  tab.version++
}

export function discardEdits(tab: ResultTab): void {
  tab.changes.clear()
  tab.deleted.clear()
  tab.added.length = 0
  tab.version++
}

const literal = (d: Dialect, v: Cell, column: ColumnInfo): string =>
  typeof v === 'string' && v.startsWith(FUNC_PREFIX) ? v.slice(FUNC_PREFIX.length) : d.literal(v, column)

/** Original-key WHERE clause identifying a row. */
function whereKey(tab: ResultTab, row: number): string {
  const t = tab.target!
  const d = tab.dialect
  return t.keyColumns
    .map((c) => {
      const v = tab.rows[row][c]
      const col = d.quoteIdentifier(tab.columns[c].orgName)
      return v === null ? `${col} IS NULL` : `${col} = ${d.literal(v, tab.columns[c])}`
    })
    .join(' AND ')
}

/** Statements applying the pending edits, in this order: updates, deletes, inserts. */
export function editStatements(tab: ResultTab): string[] {
  const t = tab.target
  if (!t) return []
  const d = tab.dialect
  const table = d.qualified(t.schema, t.table)
  const out: string[] = []
  for (const [row, changes] of tab.changes) {
    if (tab.deleted.has(row)) continue
    const set = [...changes].map(([c, v]) => `${d.quoteIdentifier(tab.columns[c].orgName)} = ${literal(d, v, tab.columns[c])}`).join(', ')
    out.push(`UPDATE ${table} SET ${set} WHERE (${whereKey(tab, row)})`)
  }
  for (const row of tab.deleted) out.push(`DELETE FROM ${table} WHERE (${whereKey(tab, row)})`)
  for (const row of tab.added) {
    const cols: string[] = []
    const vals: string[] = []
    row.forEach((v, c) => {
      if (v === undefined) return
      cols.push(d.quoteIdentifier(tab.columns[c].orgName))
      vals.push(literal(d, v, tab.columns[c]))
    })
    out.push(cols.length ? `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${vals.join(', ')})` : d.insertDefaults(table))
  }
  return out
}

/** `\G`-style vertical text rendering of a result set. */
export function verticalText(set: ResultSet): string {
  const width = Math.max(0, ...set.columns.map((c) => c.name.length))
  const lines: string[] = []
  set.rows.forEach((row, i) => {
    lines.push(`${'*'.repeat(27)} ${t('results.vertical.row', { n: i + 1 })} ${'*'.repeat(27)}`)
    set.columns.forEach((c, j) => {
      const v = row[j]
      const text = v === null ? 'NULL' : v instanceof Uint8Array ? `<${v.length} bytes>` : String(v)
      lines.push(`${c.name.padStart(width)}: ${text}`)
    })
  })
  lines.push(t('results.vertical.rowsInSet', { count: set.rows.length }))
  return lines.join('\n')
}
