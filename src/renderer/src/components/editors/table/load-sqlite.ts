import type { TableDef } from '@shared/sql/create-table'
import { parseSqliteCreateIndex, parseSqliteCreateTable } from '@shared/sql/create-table-sqlite'
import { sqliteDialect } from '@shared/sql/dialect'
// from @shared, not @/i18n: vitest loads this module without the renderer's window.api
import { t } from '@shared/i18n'
import type { Query } from '../../../workspace/catalog/catalog'

// The SQLite table editor's model, parsed from the statements kept in
// sqlite_master.

/** Reads a table into the model; throws when it cannot be edited. */
export async function loadSqliteTable(query: Query, schema: string, table: string): Promise<TableDef> {
  const rows = await query(
    `SELECT type, name, sql FROM ${sqliteDialect.quoteIdentifier(schema)}.sqlite_master
     WHERE tbl_name = ? COLLATE NOCASE AND sql IS NOT NULL ORDER BY type = 'trigger', name`,
    [table]
  )
  const create = rows.find((row) => row.type === 'table')
  if (!create) throw new Error(t('tableEditor.load.notFound', { schema, table }))
  const def = parseSqliteCreateTable(String(create.sql))
  def.name = String(create.name)
  def.dependents = []
  for (const row of rows) {
    if (row.type === 'table') continue
    const index = row.type === 'index' ? parseSqliteCreateIndex(String(row.sql)) : null
    if (index) def.indexes.push(index)
    else def.dependents.push(String(row.sql))
  }
  // REFERENCES parent without columns targets the parent's primary key
  for (const fk of def.foreignKeys.filter((f) => !f.refColumns.length)) {
    const pk = await query('SELECT name FROM pragma_table_info(?, ?) WHERE pk > 0 ORDER BY pk', [fk.refTable, schema])
    fk.refColumns = pk.map((r) => String(r.name))
  }
  return def
}
