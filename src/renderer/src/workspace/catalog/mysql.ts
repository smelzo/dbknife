import { qualified } from '@shared/sql/quote'
import type { ColumnMeta, DdlKind, ForeignKeyMeta, IndexMeta, RoutineMeta, SchemaObjects, TableMeta, TriggerMeta } from '../metadata'
import type { Catalog, Query } from './catalog'

/** MySQL / MariaDB catalog from information_schema and SHOW CREATE. */
export class MysqlCatalog implements Catalog {
  constructor(private query: Query) {}

  async schemas(): Promise<string[]> {
    const rows = await this.query('SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME')
    return rows.map((r) => String(r.name))
  }

  async objects(schema: string): Promise<SchemaObjects> {
    const [tables, routines] = await Promise.all([
      this.query(
        `SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine, TABLE_ROWS AS rows_, TABLE_COMMENT AS comment
         FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
        [schema]
      ),
      this.query(
        `SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type FROM information_schema.ROUTINES
         WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME`,
        [schema]
      )
    ])
    const all: TableMeta[] = tables.map((r) => ({
      name: String(r.name),
      type: String(r.type),
      engine: (r.engine as string) ?? null,
      rows: r.rows_ === null ? null : Number(r.rows_),
      comment: String(r.comment ?? '')
    }))
    return {
      tables: all.filter((t) => !t.type.includes('VIEW')),
      views: all.filter((t) => t.type.includes('VIEW')),
      routines: routines.map((r) => ({ name: String(r.name), type: r.type as RoutineMeta['type'] }))
    }
  }

  async columns(schema: string, table: string): Promise<ColumnMeta[]> {
    const rows = await this.query(
      `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_KEY AS key_,
              COLUMN_DEFAULT AS def, EXTRA AS extra, COLUMN_COMMENT AS comment
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [schema, table]
    )
    return rows.map((r) => ({
      name: String(r.name),
      type: String(r.type),
      nullable: r.nullable === 'YES',
      key: String(r.key_ ?? ''),
      default: r.def === null || r.def === undefined ? null : String(r.def),
      extra: String(r.extra ?? ''),
      comment: String(r.comment ?? '')
    }))
  }

  async indexes(schema: string, table: string): Promise<IndexMeta[]> {
    const rows = await this.query(
      `SELECT INDEX_NAME AS name, MIN(NON_UNIQUE) AS non_unique, INDEX_TYPE AS type,
              GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR '\u0001') AS cols
       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
       GROUP BY INDEX_NAME, INDEX_TYPE ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME`,
      [schema, table]
    )
    return rows.map((r) => ({
      name: String(r.name),
      unique: Number(r.non_unique) === 0,
      type: String(r.type),
      columns: String(r.cols ?? '').split('\u0001')
    }))
  }

  async foreignKeys(schema: string, table: string): Promise<ForeignKeyMeta[]> {
    const rows = await this.query(
      `SELECT CONSTRAINT_NAME AS name, REFERENCED_TABLE_SCHEMA AS ref_schema, REFERENCED_TABLE_NAME AS ref_table,
              GROUP_CONCAT(COLUMN_NAME ORDER BY ORDINAL_POSITION SEPARATOR '\u0001') AS cols,
              GROUP_CONCAT(REFERENCED_COLUMN_NAME ORDER BY ORDINAL_POSITION SEPARATOR '\u0001') AS ref_cols
       FROM information_schema.KEY_COLUMN_USAGE
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL
       GROUP BY CONSTRAINT_NAME, REFERENCED_TABLE_SCHEMA, REFERENCED_TABLE_NAME ORDER BY CONSTRAINT_NAME`,
      [schema, table]
    )
    return rows.map((r) => ({
      name: String(r.name),
      refSchema: String(r.ref_schema),
      refTable: String(r.ref_table),
      columns: String(r.cols ?? '').split('\u0001'),
      refColumns: String(r.ref_cols ?? '').split('\u0001')
    }))
  }

  async triggers(schema: string, table: string): Promise<TriggerMeta[]> {
    const rows = await this.query(
      `SELECT TRIGGER_NAME AS name, ACTION_TIMING AS timing, EVENT_MANIPULATION AS event
       FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ? ORDER BY ACTION_ORDER`,
      [schema, table]
    )
    return rows.map((r) => ({ name: String(r.name), timing: String(r.timing), event: String(r.event) }))
  }

  /** CREATE statement as returned by SHOW CREATE. */
  async ddl(kind: DdlKind, schema: string, name?: string): Promise<string> {
    const target = kind === 'SCHEMA' ? qualified(undefined, schema) : qualified(schema, name!)
    const rows = await this.query(`SHOW CREATE ${kind} ${target}`)
    const row = rows[0] ?? {}
    const col = Object.keys(row).find((k) => /^(Create |SQL Original Statement)/i.test(k) && row[k] !== null)
    return col ? String(row[col]) : ''
  }
}
