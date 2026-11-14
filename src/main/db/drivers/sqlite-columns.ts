import type { Cell, ColumnInfo, ColumnKind } from '@shared/types'

/** Result column metadata as node:sqlite's StatementSync.columns() reports it. */
export interface SqliteColumn {
  name: string
  column: string | null
  table: string | null
  database: string | null
  type: string | null
}

/** Type affinity of a declared column type (https://www.sqlite.org/datatype3.html, 3.1). */
export function typeAffinity(declared: string): 'INTEGER' | 'TEXT' | 'BLOB' | 'REAL' | 'NUMERIC' {
  const t = declared.toUpperCase()
  if (t.includes('INT')) return 'INTEGER'
  if (t.includes('CHAR') || t.includes('CLOB') || t.includes('TEXT')) return 'TEXT'
  if (t.includes('BLOB') || t === '') return 'BLOB'
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'REAL'
  return 'NUMERIC'
}

/**
 * How a column's values are shown. Declared types follow their affinity, except
 * dates and times (NUMERIC affinity, but stored as text in practice); columns
 * without a declared type (expressions) take the kind of their values.
 */
function columnKind(declared: string, values: Cell[]): ColumnKind {
  if (declared.trim() === '') {
    const present = values.filter((v) => v !== null)
    if (present.length && present.every((v) => typeof v === 'number')) return 'number'
    if (present.length && present.every((v) => v instanceof Uint8Array)) return 'binary'
    return 'text'
  }
  switch (typeAffinity(declared)) {
    case 'TEXT':
      return 'text'
    case 'BLOB':
      return 'binary'
    case 'NUMERIC':
      return /DATE|TIME/i.test(declared) ? 'text' : 'number'
    default:
      return 'number'
  }
}

/** Integers beyond JavaScript's safe range travel as strings. */
export function toCell(value: unknown): Cell {
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString()
  }
  return value as Cell
}

export function toColumnInfo(c: SqliteColumn, values: Cell[]): ColumnInfo {
  const type = c.type ?? ''
  return {
    name: c.name,
    orgName: c.column ?? '',
    table: c.table ?? '',
    orgTable: c.table ?? '',
    schema: c.database ?? '',
    type,
    kind: columnKind(type, values),
    length: 0,
    decimals: 0,
    charset: '',
    attributes: ''
  }
}
