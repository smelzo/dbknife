// Editing helpers for the table editor: column flags (PK, UQ)
// map to index changes, and column renames/removals follow into indexes and keys.

import type { ColumnDef, IndexDef, TableDef } from '@shared/sql/create-table'

export interface Collation {
  charset: string
  name: string
}

export function newColumn(name: string, type = 'VARCHAR(45)'): ColumnDef {
  return {
    name,
    type,
    unsigned: false,
    zerofill: false,
    binary: false,
    charset: '',
    collation: '',
    nullable: true,
    default: '',
    autoIncrement: false,
    generated: null,
    comment: '',
    extra: ''
  }
}

/** `base`, or `base` followed by the first number that makes it unused. */
export function uniqueName(base: string, used: string[]): string {
  if (!used.includes(base)) return base
  let n = 1
  while (used.includes(`${base}${n}`)) n++
  return `${base}${n}`
}

const primaryKey = (t: TableDef): IndexDef | undefined => t.indexes.find((i) => i.kind === 'PRIMARY')

export const isPrimary = (t: TableDef, column: string): boolean => !!primaryKey(t)?.columns.some((c) => c.name === column)

const isUniqueOn = (i: IndexDef, column: string): boolean => i.kind === 'UNIQUE' && i.columns.length === 1 && i.columns[0].name === column

export const isUnique = (t: TableDef, column: string): boolean => t.indexes.some((i) => isUniqueOn(i, column))

export function setPrimary(t: TableDef, column: ColumnDef, on: boolean): void {
  let pk = primaryKey(t)
  if (on) {
    if (!pk) {
      pk = { name: 'PRIMARY', kind: 'PRIMARY', columns: [], using: '', comment: '', extra: '' }
      t.indexes.unshift(pk)
    }
    pk.columns.push({ name: column.name, length: null, desc: false })
    column.nullable = false
  } else if (pk) {
    pk.columns = pk.columns.filter((c) => c.name !== column.name)
    if (!pk.columns.length) t.indexes.splice(t.indexes.indexOf(pk), 1)
  }
}

/** UQ: a single-column unique index named `<column>_UNIQUE`. */
export function setUnique(t: TableDef, column: ColumnDef, on: boolean): void {
  if (on) {
    t.indexes.push({
      name: uniqueName(`${column.name}_UNIQUE`, t.indexes.map((i) => i.name)),
      kind: 'UNIQUE',
      columns: [{ name: column.name, length: null, desc: false }],
      using: '',
      comment: '',
      extra: ''
    })
  } else t.indexes = t.indexes.filter((i) => !isUniqueOn(i, column.name))
}

export function renameColumn(t: TableDef, column: ColumnDef, name: string): void {
  const old = column.name
  column.name = name
  for (const i of t.indexes) for (const c of i.columns) if (c.name === old) c.name = name
  for (const f of t.foreignKeys) f.columns = f.columns.map((c) => (c === old ? name : c))
}

export function removeColumn(t: TableDef, column: ColumnDef): void {
  t.columns.splice(t.columns.indexOf(column), 1)
  for (const i of t.indexes) i.columns = i.columns.filter((c) => c.name !== column.name)
  t.indexes = t.indexes.filter((i) => i.columns.length)
  for (const f of t.foreignKeys) {
    const keep = f.columns.map((c) => c !== column.name)
    f.columns = f.columns.filter((_, n) => keep[n])
    f.refColumns = f.refColumns.filter((_, n) => keep[n])
  }
  t.foreignKeys = t.foreignKeys.filter((f) => f.columns.length)
}
