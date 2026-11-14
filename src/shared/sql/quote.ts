// MySQL quoting. Engine-neutral code quotes through the connection's Dialect
// (dialect.ts); these helpers serve the MySQL-only features (table editor,
// accounts, administration pages).
import type { Cell } from '../types'

export const quoteIdentifier = (name: string): string => '`' + name.replace(/`/g, '``') + '`'

export const qualified = (schema: string | undefined, name: string): string =>
  schema ? `${quoteIdentifier(schema)}.${quoteIdentifier(name)}` : quoteIdentifier(name)

const escapes: Record<string, string> = {
  '\0': '\\0',
  '\b': '\\b',
  '\t': '\\t',
  '\n': '\\n',
  '\r': '\\r',
  '\x1a': '\\Z',
  "'": "\\'",
  '\\': '\\\\'
}

/** Single-quoted string literal with MySQL escapes. */
export const quoteString = (value: string): string =>
  "'" + value.replace(/[\0\b\t\n\r\x1a'\\]/g, (c) => escapes[c]) + "'"

export const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/** SQL literal for a cell value. */
export function sqlLiteral(value: Cell): string {
  if (value === null) return 'NULL'
  if (typeof value === 'number') return String(value)
  if (value instanceof Uint8Array) return value.length === 0 ? "''" : `X'${toHex(value)}'`
  return quoteString(value)
}
