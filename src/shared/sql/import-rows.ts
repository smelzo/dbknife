// INSERT statements importing the rows of a file into an existing table.

import type { Dialect } from './dialect'

/** Column types, as the catalogs write them, holding booleans: PostgreSQL/SQLite boolean, MySQL TINYINT(1)/BIT(1), T-SQL bit. */
const booleanType = /^(bool|boolean|bit|bit\(1\)|tinyint\(1\))$/i

/**
 * INSERTs of `rows` into `schema.table`, at most `batch` rows each (500 stays under SQL Server's 1000 rows
 * per VALUES) and at most `maxBytes` characters each: the length of the whole statement, `INSERT … VALUES `
 * plus the row tuples and the `, ` between them. A statement closes when the next row would make it longer;
 * a row longer than `maxBytes` alone goes in its own INSERT. 1 MiB characters is at most 4 MiB in UTF-8, the
 * smallest default `max_allowed_packet` of MySQL/MariaDB. `columns` are the target columns in the order of the
 * values of each row; every value is a literal of the dialect for the column's type.
 *
 * Numbers and booleans (1/0) stay numbers only into a numeric column (`dialect.numericType`); elsewhere they
 * go as text ('12', '1'/'0'). SQL Server types a VALUES list by precedence, so (12), (N'A7') into nvarchar
 * fails converting 'A7' to int; PostgreSQL refuses an integer into a boolean or jsonb column but reads the
 * text; MySQL BIT(1) takes 1 but not '1'.
 *
 * Text (a CSV cell) is written as it is, except true/false (any case) into a boolean column (`booleanType`),
 * which become the booleans above: SQLite would keep 'true' as text in a BOOLEAN column, MySQL refuses it
 * in TINYINT(1).
 */
export function importStatements(
  dialect: Dialect,
  schema: string,
  table: string,
  columns: { name: string; type: string }[],
  rows: (string | number | boolean | null)[][],
  batch = 500,
  maxBytes = 1_048_576
): string[] {
  const head = `INSERT INTO ${dialect.qualified(schema, table)} (${columns.map((c) => dialect.quoteIdentifier(c.name)).join(', ')}) VALUES `
  const value = (v: string | number | boolean | null, type: string): string => {
    const bool = typeof v === 'string' && booleanType.test(type.trim()) && /^(true|false)$/i.test(v) ? /^true$/i.test(v) : v
    const cell = typeof bool === 'boolean' ? (bool ? 1 : 0) : bool
    return dialect.literal(typeof cell === 'number' && !dialect.numericType.test(type) ? String(cell) : cell, { type })
  }
  const statements: string[] = []
  let values: string[] = []
  let length = head.length
  for (const row of rows) {
    const tuple = `(${row.map((v, c) => value(v, columns[c].type)).join(', ')})`
    if (values.length === batch || (values.length > 0 && length + 2 + tuple.length > maxBytes)) {
      statements.push(head + values.join(', '))
      values = []
      length = head.length
    }
    length += (values.length > 0 ? 2 : 0) + tuple.length
    values.push(tuple)
  }
  if (values.length > 0) statements.push(head + values.join(', '))
  return statements
}

/**
 * Whether a column's `extra` (catalog metadata) says the server fills it: auto_increment, identity, serial, SQLite's
 * rowid alias (AUTOINCREMENT or rowid) or generated. MySQL's DEFAULT_GENERATED is only a default expression and doesn't count.
 */
export const serverFilledColumn = (extra: string): boolean =>
  /\b(auto_increment|autoincrement|identity|rowid|serial)\b|(VIRTUAL|STORED) GENERATED|GENERATED ALWAYS|^AS /i.test(extra)
