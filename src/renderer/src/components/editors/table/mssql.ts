import { alterTableSql, createTableSql } from '@shared/sql/table-ddl-mssql'
import { inTransaction } from '@shared/sql/transaction'
import { metadataQuery } from '@/workspace/catalog/mssql'
import type { TableEditorEngine } from './engines'
import { newColumn } from './model'
import { loadMssqlTable } from './load-mssql'

// Table editor of SQL Server: DDL of table-ddl-mssql.ts, run in one transaction.

/** Type names as the catalog writes them, lower case; alias types (schema.name, [name]) as typed. */
const normalizeType = (type: string): string => (/[[.\]"]/.test(type) ? type.trim() : type.trim().toLowerCase())

export const mssqlTableEditor: TableEditorEngine = {
  flags: ['PK', 'NN', 'UQ', 'AI', 'G'],
  dataTypes: [
    'int',
    'bigint',
    'smallint',
    'tinyint',
    'bit',
    'decimal(18,2)',
    'numeric(18,2)',
    'money',
    'float',
    'real',
    'char(10)',
    'varchar(50)',
    'varchar(max)',
    'nchar(10)',
    'nvarchar(50)',
    'nvarchar(255)',
    'nvarchar(max)',
    'binary(16)',
    'varbinary(max)',
    'date',
    'time(7)',
    'datetime2(7)',
    'datetimeoffset(7)',
    'datetime',
    'smalldatetime',
    'uniqueidentifier',
    'xml',
    'sql_variant',
    'hierarchyid',
    'geography',
    'geometry'
  ],
  defaultType: 'nvarchar(50)',
  indexKinds: ['INDEX', 'UNIQUE', 'PRIMARY'],
  indexMethods: ['CLUSTERED', 'NONCLUSTERED'],
  indexLength: false,
  indexComments: false,
  fkActions: ['NO ACTION', 'CASCADE', 'SET NULL', 'SET DEFAULT'],
  mysqlOptions: false,
  comments: true,
  generatedStorage: ['VIRTUAL', 'STORED'],
  reorderColumns: false,
  normalizeType,
  newTable: () => ({
    name: 'new_table',
    columns: [{ ...newColumn('id', 'int'), nullable: false }],
    indexes: [{ name: 'PRIMARY', kind: 'PRIMARY', constraint: true, columns: [{ name: 'id', length: null, desc: false }], using: '', comment: '', extra: '' }],
    foreignKeys: [],
    otherDefinitions: [],
    options: { engine: '', charset: '', collation: '', rowFormat: '', autoIncrement: '', comment: '', other: '', partition: '' }
  }),
  load: (ws, schema, table) => loadMssqlTable(ws.query, schema, table),
  async collations(ws) {
    const rows = await metadataQuery(ws.query)('SELECT name FROM sys.fn_helpcollations() ORDER BY name')
    return rows.map((row) => ({ charset: '', name: String(row.name) }))
  },
  // DDL is transactional: the changes apply together or not at all
  create: (schema, t) => inTransaction(createTableSql(schema, t), 'BEGIN TRANSACTION'),
  alter: (schema, from, to) => inTransaction(alterTableSql(schema, from, to), 'BEGIN TRANSACTION')
}
