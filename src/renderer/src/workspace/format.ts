import type { Cell, ColumnInfo } from '@shared/types'
import type { Dialect } from '@shared/sql/dialect'
import { toHex } from '@shared/sql/quote'
import { csvField } from '@shared/csv'

/** Numbers and bit values align right and sort numerically. */
export const isNumericColumn = (c: ColumnInfo): boolean => c.kind === 'number' || c.kind === 'bit'

/** BIT values arrive as big-endian bytes; show them as numbers. */
function bitValue(bytes: Uint8Array): string {
  let v = 0n
  for (const b of bytes) v = (v << 8n) | BigInt(b)
  return v.toString()
}

/** Text shown in a grid cell (single line). */
export function cellText(value: Cell | undefined, column?: ColumnInfo): string {
  if (value === undefined) return ''
  if (value === null) return 'NULL'
  if (value instanceof Uint8Array) {
    if (column?.kind === 'bit') return bitValue(value)
    if (column?.kind === 'geometry') return 'GEOMETRY'
    if (value.length <= 32) return value.length === 0 ? '' : '0x' + toHex(value).toUpperCase()
    return 'BLOB'
  }
  const s = String(value)
  return s.length > 1000 ? s.slice(0, 1000) + '…' : s.replace(/\r?\n/g, '↵')
}

/** Full value as text, for copy and the value editor. */
export function cellFullText(value: Cell | undefined, column?: ColumnInfo): string {
  if (value === undefined || value === null) return ''
  if (value instanceof Uint8Array) return column?.kind === 'bit' ? bitValue(value) : new TextDecoder().decode(value)
  return String(value)
}

// --- export -----------------------------------------------------------------

export type ExportFormat = 'csv' | 'csv-semicolon' | 'tsv' | 'json' | 'sql' | 'html' | 'xlsx'

export const exportFormats: { id: ExportFormat; label: string; ext: string }[] = [
  { id: 'csv', label: 'CSV', ext: 'csv' },
  { id: 'csv-semicolon', label: 'CSV (; separated)', ext: 'csv' },
  { id: 'tsv', label: 'Tab separated', ext: 'tsv' },
  { id: 'json', label: 'JSON', ext: 'json' },
  { id: 'sql', label: 'SQL INSERT statements', ext: 'sql' },
  { id: 'html', label: 'HTML', ext: 'html' },
  // written by d-spread-write in the main process (spreadWriteLines), not by exportRows
  { id: 'xlsx', label: 'Excel (XLSX)', ext: 'xlsx' }
]

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

function jsonValue(value: Cell, column: ColumnInfo): unknown {
  if (value === null) return null
  if (value instanceof Uint8Array) return column.kind === 'bit' ? Number(bitValue(value)) : toHex(value)
  return value
}

export function exportRows(
  format: ExportFormat,
  columns: ColumnInfo[],
  rows: Cell[][],
  dialect: Dialect,
  target?: { schema?: string; table: string }
): string {
  switch (format) {
    case 'csv':
    case 'csv-semicolon':
    case 'tsv': {
      const sep = format === 'csv' ? ',' : format === 'tsv' ? '\t' : ';'
      const line = (cells: string[]): string => cells.map((c) => csvField(c, sep)).join(sep)
      return [
        line(columns.map((c) => c.name)),
        ...rows.map((r) => line(r.map((v, i) => (v === null ? 'NULL' : cellFullText(v, columns[i])))))
      ].join('\n')
    }
    case 'json':
      return JSON.stringify(
        rows.map((r) => Object.fromEntries(columns.map((c, i) => [c.name, jsonValue(r[i], c)]))),
        null,
        2
      )
    case 'sql': {
      const table = target ? dialect.qualified(target.schema, target.table) : dialect.quoteIdentifier(columns[0]?.orgTable || 'table')
      const cols = columns.map((c) => dialect.quoteIdentifier(c.orgName || c.name)).join(', ')
      return rows.map((r) => `INSERT INTO ${table} (${cols}) VALUES (${r.map((v, i) => dialect.literal(v, columns[i])).join(', ')});`).join('\n')
    }
    case 'html':
      return [
        '<!doctype html><html><head><meta charset="utf-8"><title>Export</title></head><body><table border="1">',
        '<tr>' + columns.map((c) => `<th>${escapeHtml(c.name)}</th>`).join('') + '</tr>',
        ...rows.map(
          (r) =>
            '<tr>' + r.map((v, i) => `<td>${v === null ? '<i>NULL</i>' : escapeHtml(cellFullText(v, columns[i]))}</td>`).join('') + '</tr>'
        ),
        '</table></body></html>'
      ].join('\n')
    case 'xlsx':
      throw new Error('XLSX is written by d-spread-write, not as text')
  }
}

export const formatDuration = (ms: number): string => `${(ms / 1000).toFixed(3)} sec`

/** Whole seconds, for a clock that ticks while something runs. */
export const formatSeconds = (ms: number): string => `${Math.round(ms / 1000)} sec`

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return ''
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}
