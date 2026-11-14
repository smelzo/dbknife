import { postgresDialect } from '@shared/sql/dialect'
import type { ColumnMeta, DdlKind, ExtensionMeta, ForeignKeyMeta, IndexMeta, RoutineMeta, SchemaObjects, TableMeta, TriggerMeta, TypeMeta } from '../metadata'
import type { Catalog, Query } from './catalog'

const { quoteIdentifier: q, qualified } = postgresDialect

// the driver returns booleans as 'true'/'false'
const yes = (v: unknown): boolean => v === 'true' || v === true
const list = (v: unknown): string[] => (v === null || v === undefined || v === '' ? [] : String(v).split('\u0001'))

const tableTypes: Record<string, string> = {
  r: 'BASE TABLE',
  p: 'PARTITIONED TABLE',
  f: 'FOREIGN TABLE',
  v: 'VIEW',
  m: 'MATERIALIZED VIEW'
}

/** pg_type.typtype of the types listed in the navigator. */
const typeKinds: Record<string, TypeMeta['kind']> = { e: 'enum', d: 'domain', c: 'composite', r: 'range' }

/** pg_class c and pg_namespace n of the relation $1.$2. */
const relation = 'pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = $1 AND c.relname = $2'

/**
 * PostgreSQL catalog from pg_catalog for the session's database; its schemas
 * are the navigator's top level.
 */
export class PostgresCatalog implements Catalog {
  constructor(private query: Query) {}

  async schemas(): Promise<string[]> {
    const rows = await this.query('SELECT nspname AS name FROM pg_namespace ORDER BY nspname')
    return rows.map((r) => String(r.name))
  }

  async objects(schema: string): Promise<SchemaObjects> {
    const [tables, routines, sequences, types] = await Promise.all([
      this.query(
        `SELECT c.relname AS name, c.relkind AS kind, c.reltuples AS rows_, obj_description(c.oid, 'pg_class') AS comment
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'f', 'v', 'm') ORDER BY c.relname`,
        [schema]
      ),
      // overloads share a name; functions of extensions are left out
      this.query(
        `SELECT DISTINCT p.proname AS name, p.prokind AS kind
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = $1 AND p.prokind IN ('f', 'p')
           AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
         ORDER BY 1`,
        [schema]
      ),
      this.query(
        `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind = 'S' ORDER BY 1`,
        [schema]
      ),
      // composite types of their own, not the row types of tables; types of extensions are left out
      this.query(
        `SELECT t.typname AS name, t.typtype AS kind
         FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE n.nspname = $1
           AND (t.typtype IN ('e', 'd', 'r')
                OR (t.typtype = 'c' AND EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind = 'c')))
           AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_type'::regclass AND d.objid = t.oid AND d.deptype = 'e')
         ORDER BY 1`,
        [schema]
      )
    ])
    const all: TableMeta[] = tables.map((r) => ({
      name: String(r.name),
      type: tableTypes[String(r.kind)],
      engine: null,
      // reltuples is -1 until the table is first analyzed
      rows: r.rows_ === null || Number(r.rows_) < 0 ? null : Math.round(Number(r.rows_)),
      comment: String(r.comment ?? '')
    }))
    return {
      tables: all.filter((t) => !t.type.includes('VIEW')),
      views: all.filter((t) => t.type.includes('VIEW')),
      routines: routines.map((r) => ({ name: String(r.name), type: (r.kind === 'p' ? 'PROCEDURE' : 'FUNCTION') as RoutineMeta['type'] })),
      sequences: sequences.map((r) => ({ name: String(r.name) })),
      types: types.map((r) => ({ name: String(r.name), kind: typeKinds[String(r.kind)] }))
    }
  }

  async extensions(): Promise<ExtensionMeta[]> {
    const rows = await this.query(
      `SELECT e.extname AS name, e.extversion AS version, n.nspname AS schema
       FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace ORDER BY 1`
    )
    return rows.map((r) => ({ name: String(r.name), version: String(r.version), schema: String(r.schema) }))
  }

  async columns(schema: string, table: string): Promise<ColumnMeta[]> {
    const rows = await this.query(
      `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
              coalesce(a.attnum = ANY (pk.indkey), false) AS pk, pg_get_expr(d.adbin, d.adrelid) AS def,
              a.attidentity AS identity, a.attgenerated AS generated, col_description(c.oid, a.attnum) AS comment
       FROM ${relation}
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       LEFT JOIN pg_index pk ON pk.indrelid = c.oid AND pk.indisprimary
       ORDER BY a.attnum`,
      [schema, table]
    )
    return rows.map((r) => {
      const def = r.def === null || r.def === undefined ? null : String(r.def)
      const generated = r.generated === 's' ? `GENERATED ALWAYS AS (${def}) STORED` : ''
      const identity = r.identity === 'a' ? 'GENERATED ALWAYS AS IDENTITY' : r.identity === 'd' ? 'GENERATED BY DEFAULT AS IDENTITY' : ''
      const serial = def?.startsWith('nextval(') ? 'serial' : ''
      return {
        name: String(r.name),
        type: String(r.type),
        nullable: yes(r.nullable),
        key: yes(r.pk) ? 'PRI' : '',
        default: generated ? null : def,
        extra: generated || identity || serial,
        comment: String(r.comment ?? '')
      }
    })
  }

  async indexes(schema: string, table: string): Promise<IndexMeta[]> {
    const rows = await this.query(
      `SELECT i.relname AS name, x.indisunique AS uniq, am.amname AS method,
              (SELECT string_agg(pg_get_indexdef(x.indexrelid, k, true), chr(1) ORDER BY k)
               FROM generate_series(1, x.indnkeyatts) k) AS cols
       FROM ${relation}
       JOIN pg_index x ON x.indrelid = c.oid JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_am am ON am.oid = i.relam
       ORDER BY x.indisprimary DESC, i.relname`,
      [schema, table]
    )
    return rows.map((r) => ({ name: String(r.name), unique: yes(r.uniq), type: String(r.method), columns: list(r.cols) }))
  }

  async foreignKeys(schema: string, table: string): Promise<ForeignKeyMeta[]> {
    const names = (rel: string, keys: string): string =>
      `(SELECT string_agg(a.attname, chr(1) ORDER BY k.i) FROM unnest(${keys}) WITH ORDINALITY AS k(num, i)
        JOIN pg_attribute a ON a.attrelid = ${rel} AND a.attnum = k.num)`
    const rows = await this.query(
      `SELECT con.conname AS name, fn.nspname AS ref_schema, fc.relname AS ref_table,
              ${names('con.conrelid', 'con.conkey')} AS cols, ${names('con.confrelid', 'con.confkey')} AS ref_cols
       FROM ${relation}
       JOIN pg_constraint con ON con.conrelid = c.oid AND con.contype = 'f'
       JOIN pg_class fc ON fc.oid = con.confrelid JOIN pg_namespace fn ON fn.oid = fc.relnamespace
       ORDER BY con.conname`,
      [schema, table]
    )
    return rows.map((r) => ({
      name: String(r.name),
      refSchema: String(r.ref_schema),
      refTable: String(r.ref_table),
      columns: list(r.cols),
      refColumns: list(r.ref_cols)
    }))
  }

  async triggers(schema: string, table: string): Promise<TriggerMeta[]> {
    // tgtype bits (pg_trigger.h): 2 BEFORE, 64 INSTEAD; 4 INSERT, 8 DELETE, 16 UPDATE, 32 TRUNCATE
    const rows = await this.query(
      `SELECT t.tgname AS name,
              CASE WHEN t.tgtype & 2 <> 0 THEN 'BEFORE' WHEN t.tgtype & 64 <> 0 THEN 'INSTEAD OF' ELSE 'AFTER' END AS timing,
              concat_ws(' OR ', CASE WHEN t.tgtype & 4 <> 0 THEN 'INSERT' END, CASE WHEN t.tgtype & 16 <> 0 THEN 'UPDATE' END,
                        CASE WHEN t.tgtype & 8 <> 0 THEN 'DELETE' END, CASE WHEN t.tgtype & 32 <> 0 THEN 'TRUNCATE' END) AS event
       FROM ${relation} JOIN pg_trigger t ON t.tgrelid = c.oid AND NOT t.tgisinternal
       ORDER BY t.tgname`,
      [schema, table]
    )
    return rows.map((r) => ({ name: String(r.name), timing: String(r.timing), event: String(r.event) }))
  }

  /** CREATE statement of an object; a table's is rebuilt from the catalog, followed by its other indexes. */
  async ddl(kind: DdlKind, schema: string, name?: string): Promise<string> {
    const one = async (sql: string, params: unknown[]): Promise<string[]> => (await this.query(sql, params)).map((r) => String(r.ddl))
    switch (kind) {
      case 'SCHEMA':
        return `CREATE SCHEMA ${q(schema)}`
      case 'TABLE':
        return this.tableDdl(schema, name!)
      case 'VIEW': {
        const [row] = await this.query(`SELECT c.relkind AS kind, pg_get_viewdef(c.oid, true) AS def FROM ${relation}`, [schema, name])
        if (!row) return ''
        const def = String(row.def).trim().replace(/;$/, '')
        return row.kind === 'm' ? `CREATE MATERIALIZED VIEW ${qualified(schema, name!)} AS\n${def}` : `CREATE OR REPLACE VIEW ${qualified(schema, name!)} AS\n${def}`
      }
      case 'FUNCTION':
      case 'PROCEDURE': {
        const defs = await one(
          `SELECT pg_get_functiondef(p.oid) AS ddl FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind = $3 ORDER BY p.oid`,
          [schema, name, kind === 'PROCEDURE' ? 'p' : 'f']
        )
        return defs.map((d) => d.trim()).join(';\n\n')
      }
      case 'TRIGGER': {
        // trigger names are unique per table only: the first one of the schema is taken
        const [def] = await one(
          `SELECT pg_get_triggerdef(t.oid, true) AS ddl FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND t.tgname = $2 AND NOT t.tgisinternal
           ORDER BY c.relname LIMIT 1`,
          [schema, name]
        )
        return def ?? ''
      }
      default:
        return ''
    }
  }

  private async tableDdl(schema: string, table: string): Promise<string> {
    const [rel] = await this.query(
      `SELECT c.oid, c.relkind AS kind, CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END AS partition_key FROM ${relation}`,
      [schema, table]
    )
    if (!rel) return ''
    const [columns, constraints, indexes] = await Promise.all([
      this.columns(schema, table),
      this.query(
        `SELECT conname AS name, pg_get_constraintdef(oid, true) AS def FROM pg_constraint
         WHERE conrelid = $1 AND contype IN ('p', 'u', 'c', 'f', 'x')
         ORDER BY CASE contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'c' THEN 2 WHEN 'f' THEN 3 ELSE 4 END, conname`,
        [rel.oid]
      ),
      // indexes backing a constraint are created by the constraint
      this.query(
        `SELECT pg_get_indexdef(x.indexrelid) AS def FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
         WHERE x.indrelid = $1 AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = x.indexrelid AND k.conrelid = x.indrelid)
         ORDER BY i.relname`,
        [rel.oid]
      )
    ])
    const lines = [
      ...columns.map((c) => {
        let line = `${q(c.name)} ${c.type}`
        if (c.extra.startsWith('GENERATED')) line += ` ${c.extra}`
        else if (c.default !== null) line += ` DEFAULT ${c.default}`
        return c.nullable ? line : `${line} NOT NULL`
      }),
      ...constraints.map((k) => `CONSTRAINT ${q(String(k.name))} ${k.def}`)
    ]
    const partition = rel.partition_key ? ` PARTITION BY ${rel.partition_key}` : ''
    const create = `CREATE TABLE ${qualified(schema, table)} (\n    ${lines.join(',\n    ')}\n)${partition}`
    return [create, ...indexes.map((i) => String(i.def))].join(';\n')
  }
}
