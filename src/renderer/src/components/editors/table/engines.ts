import type { IndexKind, TableDef } from '@shared/sql/create-table'
import { parseCreateTable } from '@shared/sql/create-table'
import { alterTableSql, createTableSql } from '@shared/sql/table-ddl'
import type { Engine } from '@shared/types'
import type { Workspace } from '@/workspace/workspace'
import { newColumn, type Collation } from './model'
import { postgresTableEditor } from './postgres'
import { sqliteTableEditor } from './sqlite'
import { mssqlTableEditor } from './mssql'

/** Column flags of the editor's grid. */
export type ColumnFlag = 'PK' | 'NN' | 'UQ' | 'B' | 'UN' | 'ZF' | 'AI' | 'G'

/** What the table editor offers for an engine, and how it reads and changes a table. */
export interface TableEditorEngine {
  flags: ColumnFlag[]
  dataTypes: string[]
  /** Type of a column added in the editor. */
  defaultType: string
  indexKinds: IndexKind[]
  /** Index methods (USING); empty when the engine has one only. */
  indexMethods: string[]
  /** Prefix length of index key columns. */
  indexLength: boolean
  indexComments: boolean
  fkActions: string[]
  /** Character sets, collations and storage engines of tables (MySQL). */
  mysqlOptions: boolean
  /** Table and column comments. */
  comments: boolean
  generatedStorage: ('VIRTUAL' | 'STORED')[]
  /** Columns of an existing table can be moved. */
  reorderColumns: boolean
  normalizeType(type: string): string
  newTable(): TableDef
  /** Reads a table into the model; throws when it cannot be edited. */
  load(ws: Workspace, schema: string, table: string): Promise<TableDef>
  collations(ws: Workspace): Promise<Collation[]>
  create(schema: string, t: TableDef): string[]
  /** Throws when a change cannot be made, with the reason for the user. */
  alter(schema: string, from: TableDef, to: TableDef): string[]
  /** Statements restoring the session after the script failed (its transaction is rolled back first). */
  cleanup?: string[]
  /** Warning about the table after the changes were applied. */
  afterApply?(ws: Workspace, schema: string, table: string): Promise<string>
}

const mysqlTableEditor: TableEditorEngine = {
  flags: ['PK', 'NN', 'UQ', 'B', 'UN', 'ZF', 'AI', 'G'],
  dataTypes: [
    'INT',
    'TINYINT',
    'SMALLINT',
    'MEDIUMINT',
    'BIGINT',
    'DECIMAL(10,2)',
    'FLOAT',
    'DOUBLE',
    'BIT(1)',
    'CHAR(1)',
    'VARCHAR(45)',
    'VARCHAR(255)',
    'TINYTEXT',
    'TEXT',
    'MEDIUMTEXT',
    'LONGTEXT',
    'BINARY(16)',
    'VARBINARY(255)',
    'TINYBLOB',
    'BLOB',
    'MEDIUMBLOB',
    'LONGBLOB',
    'DATE',
    'TIME',
    'DATETIME',
    'TIMESTAMP',
    'YEAR',
    'JSON',
    "ENUM('a','b')",
    "SET('a','b')",
    'GEOMETRY',
    'POINT',
    'LINESTRING',
    'POLYGON'
  ],
  defaultType: 'VARCHAR(45)',
  indexKinds: ['INDEX', 'UNIQUE', 'FULLTEXT', 'SPATIAL', 'PRIMARY'],
  indexMethods: ['BTREE', 'HASH'],
  indexLength: true,
  indexComments: true,
  fkActions: ['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION'],
  mysqlOptions: true,
  comments: true,
  generatedStorage: ['VIRTUAL', 'STORED'],
  reorderColumns: true,
  /** Upper-cases the type keyword, leaving parameters (ENUM values) as typed. */
  normalizeType: (type) => type.trim().replace(/^[a-z_ ]+/i, (w) => w.toUpperCase()),
  newTable() {
    const id = { ...newColumn('id', 'INT'), nullable: false }
    return {
      name: 'new_table',
      columns: [id],
      indexes: [{ name: 'PRIMARY', kind: 'PRIMARY', columns: [{ name: 'id', length: null, desc: false }], using: '', comment: '', extra: '' }],
      foreignKeys: [],
      otherDefinitions: [],
      options: { engine: 'InnoDB', charset: '', collation: '', rowFormat: '', autoIncrement: '', comment: '', other: '', partition: '' }
    }
  },
  load: async (ws, schema, table) => parseCreateTable(await ws.meta.ddl('TABLE', schema, table)),
  async collations(ws) {
    const r = await window.api.db.query(ws.sessionId, 'SELECT * FROM information_schema.COLLATION_CHARACTER_SET_APPLICABILITY')
    // MariaDB lists the full collation name separately (COLLATION_NAME can be a shared uca1400 name)
    return r.rows
      .map((row) => ({ charset: String(row.CHARACTER_SET_NAME), name: String(row.FULL_COLLATION_NAME ?? row.COLLATION_NAME) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  },
  create: (schema, t) => [createTableSql(schema, t)],
  alter: alterTableSql
}

const engines: Record<Engine, TableEditorEngine> = { mysql: mysqlTableEditor, postgres: postgresTableEditor, sqlite: sqliteTableEditor, mssql: mssqlTableEditor }

export const tableEditorEngine = (engine: Engine): TableEditorEngine => engines[engine]
