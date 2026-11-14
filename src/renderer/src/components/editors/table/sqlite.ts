import { alterTableSql, createTableSql, rebuildCleanup } from '@shared/sql/table-ddl-sqlite'
import { t } from '@/i18n'
import type { TableEditorEngine } from './engines'
import { newColumn } from './model'
import { loadSqliteTable } from './load-sqlite'

// Table editor of SQLite: changes ALTER TABLE cannot make rebuild the table.

export const sqliteTableEditor: TableEditorEngine = {
  flags: ['PK', 'NN', 'UQ', 'AI', 'G'],
  dataTypes: ['INTEGER', 'TEXT', 'REAL', 'NUMERIC', 'BLOB', 'VARCHAR(45)', 'VARCHAR(255)', 'DECIMAL(10,2)', 'BOOLEAN', 'DATE', 'DATETIME'],
  defaultType: 'TEXT',
  indexKinds: ['INDEX', 'UNIQUE', 'PRIMARY'],
  indexMethods: [],
  indexLength: false,
  indexComments: false,
  fkActions: ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'],
  mysqlOptions: false,
  comments: false,
  generatedStorage: ['VIRTUAL', 'STORED'],
  reorderColumns: true,
  normalizeType: (type) => type.trim().replace(/^[a-z_ ]+/i, (w) => w.toUpperCase()),
  newTable: () => ({
    name: 'new_table',
    columns: [{ ...newColumn('id', 'INTEGER'), nullable: false }],
    indexes: [{ name: 'PRIMARY', kind: 'PRIMARY', constraint: true, columns: [{ name: 'id', length: null, desc: false }], using: '', comment: '', extra: '' }],
    foreignKeys: [],
    otherDefinitions: [],
    options: { engine: '', charset: '', collation: '', rowFormat: '', autoIncrement: '', comment: '', other: '', partition: '' }
  }),
  load: (ws, schema, table) => loadSqliteTable(ws.query, schema, table),
  collations: async () => ['BINARY', 'NOCASE', 'RTRIM'].map((name) => ({ charset: '', name })),
  create: createTableSql,
  alter: alterTableSql,
  cleanup: rebuildCleanup,
  async afterApply(ws, schema, table) {
    // the rebuild ran without foreign key checks
    const r = await window.api.db.query(ws.sessionId, 'SELECT count(*) AS n FROM pragma_foreign_key_check(?, ?)', [table, schema])
    const n = Number(r.rows[0]?.n ?? 0)
    return n ? t('tableEditor.sqlite.fkViolations', { count: n, table, quoted: ws.dialect.quoteString(table) }) : ''
  }
}
