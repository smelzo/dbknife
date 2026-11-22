import type { Row } from '@shared/types'
import { mssqlDialect } from '@shared/sql/dialect'
import { valueText } from '@shared/value-text'
import type { ColumnMeta, DdlKind, ForeignKeyMeta, IndexMeta, RoutineMeta, SchemaObjects, TableMeta, TriggerMeta } from '../metadata'
import type { Catalog, Query } from './catalog'

const { quoteIdentifier: q, qualified, quoteString } = mssqlDialect

/** A bit or flag column read as a boolean. */
export const yes = (v: unknown): boolean => v === true || v === 1 || v === '1' || v === 'true'
const list = (v: unknown): string[] => {
  const s = valueText(v)
  return s === '' ? [] : s.split('\u0001')
}
const text = valueText

// Metadata functions such as OBJECT_ID wait for the schema lock of an object created or changed in
// an open transaction, whatever the isolation level: names are resolved with joins on the catalog
// views instead. Definitions (defaults, modules) and row counts wait all the same (metadataQuery).

/** object_id of the object @p1.@p2. */
const target = '(SELECT o.object_id FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id WHERE s.name = @p1 AND o.name = @p2)'

/** Objects o of the schema @p1. */
const inSchema = 'sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id AND s.name = @p1'

const routineTypes: Record<string, RoutineMeta['type']> = {
  P: 'PROCEDURE',
  PC: 'PROCEDURE',
  FN: 'FUNCTION',
  IF: 'FUNCTION',
  TF: 'FUNCTION',
  FS: 'FUNCTION',
  FT: 'FUNCTION'
}

/** Column type as T-SQL writes it: nvarchar(50), nvarchar(max), decimal(10,2), datetime2(7). */
function typeName(r: Row): string {
  const type = String(r.type_name)
  // alias types belong to a schema; CLR types (hierarchyid, geography) are system ones
  if (yes(r.user_type)) return qualified(String(r.type_schema), type)
  const length = Number(r.max_length)
  switch (type) {
    case 'char':
    case 'varchar':
    case 'binary':
    case 'varbinary':
      return `${type}(${length === -1 ? 'max' : length})`
    case 'nchar':
    case 'nvarchar':
      return `${type}(${length === -1 ? 'max' : length / 2})`
    case 'decimal':
    case 'numeric':
      return `${type}(${Number(r.precision)},${Number(r.scale)})`
    case 'datetime2':
    case 'datetimeoffset':
    case 'time':
      return `${type}(${Number(r.scale)})`
    default:
      return type
  }
}

/** A column for the navigator and the table editor, and its definition in CREATE TABLE. */
export interface MssqlColumn {
  meta: ColumnMeta
  ddl: string
  /** IDENTITY(seed,increment), '' when not an identity column. */
  identity: string
  /** Definition of a computed column, '' for other columns. */
  computed: string
  persisted: boolean
  /** Name of the default constraint, null without a default. */
  defaultName: string | null
  /** Collation when it differs from the database's, '' otherwise. */
  collation: string
}

export interface MssqlIndex {
  name: string
  type: string
  unique: boolean
  primary: boolean
  /** Backs a PRIMARY KEY or UNIQUE constraint. */
  constraint: boolean
  systemNamed: boolean
  columns: string[]
  descending: string[]
  included: string[]
  filter: string
}

export interface MssqlForeignKey extends ForeignKeyMeta {
  /** Referential actions as REFERENCES writes them, '' for NO ACTION. */
  onDelete: string
  onUpdate: string
  ddl: string
}

/** What the catalog reads of a table: CREATE TABLE is rebuilt from it, the table editor loads it. */
export interface MssqlTable {
  comment: string
  columns: MssqlColumn[]
  indexes: MssqlIndex[]
  checks: { name: string; definition: string; systemNamed: boolean }[]
  foreignKeys: MssqlForeignKey[]
}

/** Longest wait for a lock held by another session, e.g. a DDL transaction of the user connection. */
const lockTimeoutMs = 2000

/**
 * Runs metadata queries of the auxiliary connection under READ UNCOMMITTED:
 * under READ COMMITTED an object created in an open transaction of the user
 * connection blocks them until that transaction ends. What still waits for
 * such an object (its definitions, row counts) fails after lockTimeoutMs
 * instead of hanging. With parameters the driver runs sp_executesql, where
 * the SETs last for that call only: a query without parameters gets an unused
 * one, since a plain batch would keep them for the session (also when it
 * stops before resetting them).
 */
export function metadataQuery(query: Query): Query {
  return (sql, params) =>
    query(`SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED; SET LOCK_TIMEOUT ${lockTimeoutMs};\n${sql}`, params?.length ? params : [null])
}

/**
 * SQL Server catalog from the sys views of the session's database; its
 * schemas are the navigator's top level.
 */
export class MssqlCatalog implements Catalog {
  private query: Query

  constructor(query: Query) {
    this.query = metadataQuery(query)
  }

  async schemas(): Promise<string[]> {
    // an empty schema named after its user or Windows group is the per-user schema that older
    // versions created with every database user (SSMS lists it only under Security): left out
    const rows = await this.query(
      `SELECT s.name FROM sys.schemas s JOIN sys.database_principals p ON p.principal_id = s.principal_id
       WHERE s.name <> p.name OR p.principal_id <= 4 OR p.type = 'R' OR s.schema_id = SCHEMA_ID()
          OR EXISTS (SELECT 1 FROM sys.objects o WHERE o.schema_id = s.schema_id)
          OR EXISTS (SELECT 1 FROM sys.types t WHERE t.schema_id = s.schema_id)
       ORDER BY s.name`
    )
    return rows.map((r) => String(r.name))
  }

  async objects(schema: string): Promise<SchemaObjects> {
    const [tables, routines, counts] = await Promise.all([
      this.query(
        `SELECT o.name, o.type AS kind, CAST(ep.value AS nvarchar(max)) AS comment
         FROM ${inSchema}
         LEFT JOIN sys.extended_properties ep ON ep.class = 1 AND ep.major_id = o.object_id AND ep.minor_id = 0 AND ep.name = N'MS_Description'
         WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0
         ORDER BY o.name`,
        [schema]
      ),
      this.query(
        `SELECT o.name, o.type AS kind FROM ${inSchema}
         WHERE o.type IN ('P', 'PC', 'FN', 'IF', 'TF', 'FS', 'FT') AND o.is_ms_shipped = 0
         ORDER BY o.name`,
        [schema]
      ),
      // a table in an open DDL transaction makes the counts wait: the schema is listed without them
      this.query(
        `SELECT o.name, SUM(p.rows) AS rows_ FROM ${inSchema}
         JOIN sys.partitions p ON p.object_id = o.object_id AND p.index_id IN (0, 1)
         WHERE o.type = 'U' GROUP BY o.name`,
        [schema]
      ).catch((): Row[] => [])
    ])
    const rowCounts = new Map(counts.map((r) => [String(r.name), Number(r.rows_)]))
    const all: TableMeta[] = tables.map((r) => ({
      name: String(r.name),
      type: String(r.kind).trim() === 'V' ? 'VIEW' : 'BASE TABLE',
      engine: null,
      // partition counts are maintained by the engine, not exact under concurrent changes
      rows: rowCounts.get(String(r.name)) ?? null,
      comment: text(r.comment)
    }))
    return {
      tables: all.filter((t) => t.type !== 'VIEW'),
      views: all.filter((t) => t.type === 'VIEW'),
      routines: routines.map((r) => ({ name: String(r.name), type: routineTypes[String(r.kind).trim()] }))
    }
  }

  async columns(schema: string, table: string): Promise<ColumnMeta[]> {
    return (await this.readColumns(schema, table)).map((c) => c.meta)
  }

  private async readColumns(schema: string, table: string): Promise<MssqlColumn[]> {
    const rows = await this.query(
      `SELECT c.name, t.name AS type_name, t.is_user_defined AS user_type, ts.name AS type_schema,
              c.max_length, c.precision, c.scale, c.is_nullable AS nullable,
              CAST(ic.seed_value AS nvarchar(40)) AS seed, CAST(ic.increment_value AS nvarchar(40)) AS increment,
              cc.definition AS computed, cc.is_persisted AS persisted,
              dc.name AS default_name, dc.is_system_named AS default_system_named, dc.definition AS def,
              CASE WHEN c.collation_name <> CAST(DATABASEPROPERTYEX(DB_NAME(), 'Collation') AS sysname) THEN c.collation_name END AS collation,
              CAST(ep.value AS nvarchar(max)) AS comment,
              CASE WHEN EXISTS (SELECT 1 FROM sys.indexes i JOIN sys.index_columns k ON k.object_id = i.object_id AND k.index_id = i.index_id
                                WHERE i.object_id = c.object_id AND i.is_primary_key = 1 AND k.column_id = c.column_id) THEN 1 ELSE 0 END AS pk
       FROM sys.columns c
       JOIN sys.types t ON t.user_type_id = c.user_type_id JOIN sys.schemas ts ON ts.schema_id = t.schema_id
       LEFT JOIN sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id
       LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
       LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
       LEFT JOIN sys.extended_properties ep ON ep.class = 1 AND ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = N'MS_Description'
       WHERE c.object_id = ${target}
       ORDER BY c.column_id`,
      [schema, table]
    )
    return rows.map((r) => {
      const type = typeName(r)
      const identity = r.seed === null || r.seed === undefined ? '' : `IDENTITY(${valueText(r.seed)},${valueText(r.increment)})`
      const computed = r.computed ? `AS ${valueText(r.computed)}${yes(r.persisted) ? ' PERSISTED' : ''}` : ''
      const collation = r.collation ? `COLLATE ${valueText(r.collation)}` : ''
      const def = r.def === null || r.def === undefined ? null : valueText(r.def)
      const nullable = yes(r.nullable)
      const constraint = def !== null && !yes(r.default_system_named) ? ` CONSTRAINT ${q(String(r.default_name))}` : ''
      const ddl = computed
        ? `${q(String(r.name))} ${computed}`
        : [q(String(r.name)), type, collation, identity, nullable ? 'NULL' : 'NOT NULL'].filter(Boolean).join(' ') +
          (def === null ? '' : `${constraint} DEFAULT ${def}`)
      return {
        meta: {
          name: String(r.name),
          type,
          nullable,
          key: yes(r.pk) ? 'PRI' : '',
          default: def,
          extra: [identity, computed, collation].filter(Boolean).join(' '),
          comment: text(r.comment)
        },
        ddl,
        identity,
        computed: text(r.computed),
        persisted: yes(r.persisted),
        defaultName: def === null ? null : String(r.default_name),
        collation: text(r.collation)
      }
    })
  }

  async indexes(schema: string, table: string): Promise<IndexMeta[]> {
    return (await this.readIndexes(schema, table)).map((i) => ({ name: i.name, unique: i.unique, type: i.type, columns: i.columns }))
  }

  private async readIndexes(schema: string, table: string): Promise<MssqlIndex[]> {
    // aggregates of one query must share their order: included columns have key_ordinal 0
    const rows = await this.query(
      `SELECT i.name, i.type_desc AS type, i.is_unique AS uniq, i.is_primary_key AS pk,
              i.is_primary_key | i.is_unique_constraint AS constraint_, kc.is_system_named AS system_named, i.filter_definition AS filter,
              STRING_AGG(CASE WHEN ic.is_included_column = 0 THEN c.name END, CHAR(1)) WITHIN GROUP (ORDER BY ic.key_ordinal, ic.index_column_id) AS cols,
              STRING_AGG(CASE WHEN ic.is_included_column = 0 AND ic.is_descending_key = 1 THEN c.name END, CHAR(1))
                WITHIN GROUP (ORDER BY ic.key_ordinal, ic.index_column_id) AS desc_cols,
              STRING_AGG(CASE WHEN ic.is_included_column = 1 THEN c.name END, CHAR(1)) WITHIN GROUP (ORDER BY ic.key_ordinal, ic.index_column_id) AS included
       FROM sys.indexes i
       JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
       JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
       LEFT JOIN sys.key_constraints kc ON kc.parent_object_id = i.object_id AND kc.unique_index_id = i.index_id
       WHERE i.object_id = ${target} AND i.type > 0 AND i.is_hypothetical = 0
       GROUP BY i.name, i.type_desc, i.is_unique, i.is_primary_key, i.is_unique_constraint, kc.is_system_named, i.filter_definition
       ORDER BY i.is_primary_key DESC, i.name`,
      [schema, table]
    )
    return rows.map((r) => ({
      name: String(r.name),
      type: String(r.type),
      unique: yes(r.uniq),
      primary: yes(r.pk),
      constraint: yes(r.constraint_),
      systemNamed: yes(r.system_named),
      columns: list(r.cols),
      descending: list(r.desc_cols),
      included: list(r.included),
      filter: text(r.filter)
    }))
  }

  async foreignKeys(schema: string, table: string): Promise<ForeignKeyMeta[]> {
    return (await this.readForeignKeys(schema, table)).map(({ name, refSchema, refTable, columns, refColumns }) => ({
      name,
      refSchema,
      refTable,
      columns,
      refColumns
    }))
  }

  private async readForeignKeys(schema: string, table: string): Promise<MssqlForeignKey[]> {
    const rows = await this.query(
      `SELECT fk.name, rs.name AS ref_schema, ro.name AS ref_table, fk.is_system_named AS system_named,
              fk.delete_referential_action_desc AS on_delete, fk.update_referential_action_desc AS on_update,
              STRING_AGG(pc.name, CHAR(1)) WITHIN GROUP (ORDER BY k.constraint_column_id) AS cols,
              STRING_AGG(rc.name, CHAR(1)) WITHIN GROUP (ORDER BY k.constraint_column_id) AS ref_cols
       FROM sys.foreign_keys fk
       JOIN sys.objects ro ON ro.object_id = fk.referenced_object_id JOIN sys.schemas rs ON rs.schema_id = ro.schema_id
       JOIN sys.foreign_key_columns k ON k.constraint_object_id = fk.object_id
       JOIN sys.columns pc ON pc.object_id = k.parent_object_id AND pc.column_id = k.parent_column_id
       JOIN sys.columns rc ON rc.object_id = k.referenced_object_id AND rc.column_id = k.referenced_column_id
       WHERE fk.parent_object_id = ${target}
       GROUP BY fk.name, rs.name, ro.name, fk.is_system_named, fk.delete_referential_action_desc, fk.update_referential_action_desc
       ORDER BY fk.name`,
      [schema, table]
    )
    return rows.map((r) => {
      const fk = {
        name: String(r.name),
        refSchema: String(r.ref_schema),
        refTable: String(r.ref_table),
        columns: list(r.cols),
        refColumns: list(r.ref_cols)
      }
      // NO_ACTION, CASCADE, SET_NULL, SET_DEFAULT
      const action = (v: unknown): string => (v === 'NO_ACTION' ? '' : String(v).replace('_', ' '))
      const onDelete = action(r.on_delete)
      const onUpdate = action(r.on_update)
      const ddl =
        `${yes(r.system_named) ? '' : `CONSTRAINT ${q(fk.name)} `}FOREIGN KEY (${fk.columns.map(q).join(', ')}) ` +
        `REFERENCES ${qualified(fk.refSchema, fk.refTable)} (${fk.refColumns.map(q).join(', ')})` +
        (onDelete ? ` ON DELETE ${onDelete}` : '') +
        (onUpdate ? ` ON UPDATE ${onUpdate}` : '')
      return { ...fk, onDelete, onUpdate, ddl }
    })
  }

  async triggers(schema: string, table: string): Promise<TriggerMeta[]> {
    // trigger_events.type: 1 INSERT, 2 UPDATE, 3 DELETE
    const rows = await this.query(
      `SELECT tr.name, CASE WHEN tr.is_instead_of_trigger = 1 THEN 'INSTEAD OF' ELSE 'AFTER' END AS timing,
              STRING_AGG(te.type_desc, ' OR ') WITHIN GROUP (ORDER BY te.type) AS event
       FROM sys.triggers tr JOIN sys.trigger_events te ON te.object_id = tr.object_id
       WHERE tr.parent_id = ${target}
       GROUP BY tr.name, tr.is_instead_of_trigger
       ORDER BY tr.name`,
      [schema, table]
    )
    return rows.map((r) => ({ name: String(r.name), timing: String(r.timing), event: String(r.event) }))
  }

  /**
   * CREATE statement of an object: modules as written (sys.sql_modules, empty
   * when encrypted); a table's is rebuilt from the catalog, followed by its other indexes.
   */
  async ddl(kind: DdlKind, schema: string, name?: string): Promise<string> {
    switch (kind) {
      case 'SCHEMA':
        return `CREATE SCHEMA ${q(schema)}`
      case 'TABLE':
        return this.tableDdl(schema, name!)
      case 'VIEW':
      case 'PROCEDURE':
      case 'FUNCTION':
      case 'TRIGGER': {
        const [row] = await this.query(`SELECT definition AS ddl FROM sys.sql_modules WHERE object_id = ${target}`, [schema, name])
        return text(row?.ddl).trim()
      }
      default:
        return ''
    }
  }

  /** The table @schema.@table as the catalog reads it; null when there is no such table. */
  async table(schema: string, table: string): Promise<MssqlTable | null> {
    const [columns, indexes, checks, foreignKeys, [comment]] = await Promise.all([
      this.readColumns(schema, table),
      this.readIndexes(schema, table),
      this.query(
        `SELECT name, definition AS def, is_system_named AS system_named FROM sys.check_constraints
         WHERE parent_object_id = ${target} ORDER BY name`,
        [schema, table]
      ),
      this.readForeignKeys(schema, table),
      this.query(
        `SELECT CAST(value AS nvarchar(max)) AS comment FROM sys.extended_properties
         WHERE class = 1 AND major_id = ${target} AND minor_id = 0 AND name = N'MS_Description'`,
        [schema, table]
      )
    ])
    if (!columns.length) return null
    return {
      comment: text(comment?.comment),
      columns,
      indexes,
      checks: checks.map((k) => ({ name: String(k.name), definition: String(k.def), systemNamed: yes(k.system_named) })),
      foreignKeys
    }
  }

  private async tableDdl(schema: string, table: string): Promise<string> {
    const t = await this.table(schema, table)
    if (!t) return ''
    const { columns, indexes, checks, foreignKeys } = t
    const named = (systemNamed: boolean, name: string): string => (systemNamed ? '' : `CONSTRAINT ${q(name)} `)
    const keys = (i: MssqlIndex): string => i.columns.map((c) => (i.descending.includes(c) ? `${q(c)} DESC` : q(c))).join(', ')
    const lines = [
      ...columns.map((c) => c.ddl),
      ...indexes
        .filter((i) => i.constraint)
        .map((i) => `${named(i.systemNamed, i.name)}${i.primary ? 'PRIMARY KEY' : 'UNIQUE'} ${i.type} (${keys(i)})`),
      ...checks.map((k) => `${named(k.systemNamed, k.name)}CHECK ${k.definition}`),
      ...foreignKeys.map((k) => k.ddl)
    ]
    const name = qualified(schema, table)
    const create = `CREATE TABLE ${name} (\n    ${lines.join(',\n    ')}\n)`
    // XML and spatial indexes need their own syntax and are left out
    const others = indexes
      .filter((i) => !i.constraint)
      .flatMap((i) => {
        const unique = i.unique ? 'UNIQUE ' : ''
        const filter = i.filter ? ` WHERE ${i.filter}` : ''
        switch (i.type) {
          case 'CLUSTERED':
          case 'NONCLUSTERED': {
            const include = i.included.length ? ` INCLUDE (${i.included.map(q).join(', ')})` : ''
            return [`CREATE ${unique}${i.type} INDEX ${q(i.name)} ON ${name} (${keys(i)})${include}${filter}`]
          }
          case 'CLUSTERED COLUMNSTORE':
            return [`CREATE CLUSTERED COLUMNSTORE INDEX ${q(i.name)} ON ${name}`]
          case 'NONCLUSTERED COLUMNSTORE':
            return [`CREATE NONCLUSTERED COLUMNSTORE INDEX ${q(i.name)} ON ${name} (${i.included.map(q).join(', ')})${filter}`]
          default:
            return []
        }
      })
    // comments are extended properties, added once the table exists
    const comment = (value: string, column?: string): string =>
      `EXEC sys.sp_addextendedproperty N'MS_Description', ${quoteString(value)}, N'SCHEMA', ${quoteString(schema)}, N'TABLE', ${quoteString(table)}` +
      (column === undefined ? '' : `, N'COLUMN', ${quoteString(column)}`)
    const comments = [
      ...(t.comment ? [comment(t.comment)] : []),
      ...columns.filter((c) => c.meta.comment).map((c) => comment(c.meta.comment, c.meta.name))
    ]
    return [create, ...others, ...comments].join(';\n')
  }
}
