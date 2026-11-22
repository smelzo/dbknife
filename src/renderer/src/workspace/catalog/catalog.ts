import type { Engine, Row } from '@shared/types'
import type { ColumnMeta, DdlKind, ExtensionMeta, ForeignKeyMeta, IndexMeta, SchemaObjects, TriggerMeta } from '../metadata'
import { MysqlCatalog } from './mysql'
import { SqliteCatalog } from './sqlite'
import { PostgresCatalog } from './postgres'
import { MssqlCatalog } from './mssql'

/** Runs a query on the auxiliary connection, throwing on errors. */
export type Query = (sql: string, params?: unknown[]) => Promise<Row[]>

/**
 * Reads the catalog of one engine into the engine-neutral model of
 * metadata.ts. Column keys use 'PRI' for primary key columns.
 */
export interface Catalog {
  schemas(): Promise<string[]>
  objects(schema: string): Promise<SchemaObjects>
  columns(schema: string, table: string): Promise<ColumnMeta[]>
  indexes(schema: string, table: string): Promise<IndexMeta[]>
  foreignKeys(schema: string, table: string): Promise<ForeignKeyMeta[]>
  triggers(schema: string, table: string): Promise<TriggerMeta[]>
  /** CREATE statement of an object. */
  ddl(kind: DdlKind, schema: string, name?: string): Promise<string>
  /** Extensions of the session's database (PostgreSQL). */
  extensions?(): Promise<ExtensionMeta[]>
}

export function createCatalog(engine: Engine, query: Query): Catalog {
  switch (engine) {
    case 'mysql':
      return new MysqlCatalog(query)
    case 'sqlite':
      return new SqliteCatalog(query)
    case 'postgres':
      return new PostgresCatalog(query)
    case 'mssql':
      return new MssqlCatalog(query)
    default:
      throw new Error(`No catalog for ${String(engine)}`)
  }
}
