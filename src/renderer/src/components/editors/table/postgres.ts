import { alterTableSql, createTableSql } from '@shared/sql/table-ddl-postgres'
import { inTransaction } from '@shared/sql/transaction'
import type { TableEditorEngine } from './engines'
import { newColumn } from './model'
import { loadPostgresTable } from './load-postgres'

// Table editor of PostgreSQL: DDL of table-ddl-postgres.ts, run in one transaction.

export const postgresTableEditor: TableEditorEngine = {
  flags: ['PK', 'NN', 'UQ', 'AI', 'G'],
  dataTypes: [
    'integer',
    'bigint',
    'smallint',
    'numeric(10,2)',
    'real',
    'double precision',
    'boolean',
    'varchar(45)',
    'varchar(255)',
    'char(1)',
    'text',
    'date',
    'time',
    'timestamp',
    'timestamptz',
    'interval',
    'uuid',
    'json',
    'jsonb',
    'bytea',
    'inet',
    'cidr',
    'money',
    'xml',
    'text[]',
    'integer[]'
  ],
  defaultType: 'varchar(45)',
  indexKinds: ['INDEX', 'UNIQUE', 'PRIMARY'],
  indexMethods: ['btree', 'hash', 'gist', 'gin', 'brin', 'spgist'],
  indexLength: false,
  indexComments: true,
  fkActions: ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'],
  mysqlOptions: false,
  comments: true,
  generatedStorage: ['STORED'],
  reorderColumns: false,
  // type names are lower case in the catalog (format_type)
  normalizeType: (type) => type.trim(),
  newTable: () => ({
    name: 'new_table',
    columns: [{ ...newColumn('id', 'integer'), nullable: false }],
    indexes: [{ name: 'PRIMARY', kind: 'PRIMARY', constraint: true, columns: [{ name: 'id', length: null, desc: false }], using: '', comment: '', extra: '' }],
    foreignKeys: [],
    otherDefinitions: [],
    options: { engine: '', charset: '', collation: '', rowFormat: '', autoIncrement: '', comment: '', other: '', partition: '' }
  }),
  load: (ws, schema, table) => loadPostgresTable(ws.query, schema, table),
  async collations(ws) {
    const r = await window.api.db.query(ws.sessionId, "SELECT collname AS name FROM pg_collation WHERE collname <> 'default' ORDER BY 1")
    return r.rows.map((row) => ({ charset: '', name: String(row.name) }))
  },
  // DDL is transactional: the changes apply together or not at all
  create: (schema, t) => inTransaction(createTableSql(schema, t)),
  alter: (schema, from, to) => inTransaction(alterTableSql(schema, from, to))
}
