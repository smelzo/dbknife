import type { ColumnDef, ForeignKeyDef, IndexDef, TableDef } from '@shared/sql/create-table'
import { postgresDialect } from '@shared/sql/dialect'
import { valueText } from '@shared/value-text'
// from @shared, not @/i18n: the vitest integration tests load this module without the renderer's window.api
import { t } from '@shared/i18n'
import type { Query } from '../../../workspace/catalog/catalog'
import { newColumn } from './model'

// The PostgreSQL table editor's model, read from pg_catalog. Indexes and
// constraints it cannot represent (expressions, partial or INCLUDE indexes,
// non-default operator classes, deferrable keys) stay out of it, and the
// editor leaves them as they are.

/** pg_class c and pg_namespace n of the relation $1.$2. */
const relation = 'pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = $1 AND c.relname = $2'

const yes = (v: unknown): boolean => v === 'true' || v === true
const list = (v: unknown): string[] => (v === null || v === undefined || v === '' ? [] : valueText(v).split('\u0001'))
const actions: Record<string, string> = { a: '', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' }

/** Reads a table into the model; throws when it cannot be edited. */
export async function loadPostgresTable(query: Query, schema: string, table: string): Promise<TableDef> {
  const q = (sql: string): ReturnType<Query> => query(sql, [schema, table])
  const [rel] = await q(
    `SELECT c.relkind AS kind, obj_description(c.oid, 'pg_class') AS comment,
            CASE WHEN c.relkind = 'p' THEN 'PARTITION BY ' || pg_get_partkeydef(c.oid) END AS partition_key,
            array_to_string(c.reloptions, ', ') AS options
     FROM ${relation}`
  )
  if (!rel) throw new Error(t('tableEditor.load.notFound', { schema, table }))
  if (rel.kind !== 'r' && rel.kind !== 'p') throw new Error(t('tableEditor.load.notOrdinary'))
  const [columnRows, indexRows, constraintRows] = await Promise.all([
    q(
      `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull,
              pg_get_expr(d.adbin, d.adrelid) AS def, a.attidentity AS identity, a.attgenerated AS generated,
              CASE WHEN a.attcollation <> t.typcollation THEN co.collname END AS collation, col_description(c.oid, a.attnum) AS comment
       FROM ${relation}
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       JOIN pg_type t ON t.oid = a.atttypid
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       LEFT JOIN pg_collation co ON co.oid = a.attcollation
       ORDER BY a.attnum`
    ),
    // indexOption bits (pg_index.h): 1 DESC, 2 NULLS FIRST; DESC sorts nulls first by default
    q(
      `SELECT i.relname AS name, x.indisprimary AS is_primary, x.indisunique AS is_unique, am.amname AS method,
              k.conname IS NOT NULL AS is_constraint, obj_description(i.oid, 'pg_class') AS comment,
              x.indexprs IS NULL AND x.indpred IS NULL AND x.indnatts = x.indnkeyatts AND k.condeferrable IS NOT TRUE
                AND coalesce((to_jsonb(x) ->> 'indnullsnotdistinct')::boolean, false) = false
                AND (SELECT bool_and(o.opcdefault) FROM unnest(x.indclass::oid[]) u(oid) JOIN pg_opclass o ON o.oid = u.oid)
                AND (SELECT bool_and(u.coll = 0 OR u.coll = a.attcollation)
                     FROM unnest(x.indcollation::oid[], x.indkey::int2[]) u(coll, num)
                     JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = u.num)
                AND (SELECT bool_and(u.opt IN (0, 3)) FROM unnest(x.indoption::int2[]) u(opt)) AS modelled,
              (SELECT string_agg(a.attname, chr(1) ORDER BY u.i) FROM unnest(x.indkey::int2[]) WITH ORDINALITY u(num, i)
                JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = u.num) AS columns_,
              (SELECT string_agg((u.opt & 1)::text, chr(1) ORDER BY u.i) FROM unnest(x.indoption::int2[]) WITH ORDINALITY u(opt, i)) AS desc_
       FROM ${relation}
       JOIN pg_index x ON x.indrelid = c.oid JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_am am ON am.oid = i.relam
       LEFT JOIN pg_constraint k ON k.conindid = x.indexrelid AND k.conrelid = c.oid AND k.contype IN ('p', 'u')
       -- the index of an EXCLUDE constraint belongs to the constraint
       WHERE NOT EXISTS (SELECT 1 FROM pg_constraint e WHERE e.conindid = x.indexrelid AND e.contype = 'x')
       ORDER BY x.indisprimary DESC, i.relname`
    ),
    q(
      `SELECT k.conname AS name, k.contype AS type, pg_get_constraintdef(k.oid, true) AS def,
              k.condeferrable AS deferrable, k.confmatchtype AS match, k.confupdtype AS on_update, k.confdeltype AS on_delete,
              fn.nspname AS ref_schema, fc.relname AS ref_table,
              (SELECT string_agg(a.attname, chr(1) ORDER BY u.i) FROM unnest(k.conkey) WITH ORDINALITY u(num, i)
                JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.num) AS columns_,
              (SELECT string_agg(a.attname, chr(1) ORDER BY u.i) FROM unnest(k.confkey) WITH ORDINALITY u(num, i)
                JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.num) AS ref_columns
       FROM ${relation}
       JOIN pg_constraint k ON k.conrelid = c.oid AND k.contype IN ('f', 'c', 'x')
       LEFT JOIN pg_class fc ON fc.oid = k.confrelid LEFT JOIN pg_namespace fn ON fn.oid = fc.relnamespace
       ORDER BY k.contype, k.conname`
    )
  ])

  const columns: ColumnDef[] = columnRows.map((r) => ({
    ...newColumn(String(r.name), String(r.type)),
    oldName: String(r.name),
    nullable: !yes(r.notnull),
    default: r.generated === '' && r.def !== null ? valueText(r.def) : '',
    autoIncrement: r.identity === 'a' || r.identity === 'd',
    generated: r.generated === 's' ? { expression: String(r.def), storage: 'STORED' } : null,
    collation: (r.collation as string | null) ?? '',
    comment: valueText(r.comment)
  }))
  if (columnRows.some((r) => r.generated === 'v')) throw new Error(t('tableEditor.load.virtualGenerated'))

  const indexes: IndexDef[] = []
  const otherDefinitions: string[] = []
  for (const r of indexRows) {
    // other indexes the model cannot represent stay untouched on the server
    if (!yes(r.modelled)) {
      if (yes(r.is_primary)) throw new Error(t('tableEditor.load.primaryKeyOptions'))
      continue
    }
    const descending = list(r.desc_)
    indexes.push({
      name: String(r.name),
      oldName: String(r.name),
      kind: yes(r.is_primary) ? 'PRIMARY' : yes(r.is_unique) ? 'UNIQUE' : 'INDEX',
      constraint: yes(r.is_constraint),
      columns: list(r.columns_).map((name, i) => ({ name, length: null, desc: descending[i] === '1' })),
      using: r.method === 'btree' ? '' : String(r.method),
      comment: yes(r.is_constraint) ? '' : valueText(r.comment),
      extra: ''
    })
  }
  const foreignKeys: ForeignKeyDef[] = []
  for (const r of constraintRows) {
    // MATCH FULL and deferrable keys, CHECK and EXCLUDE constraints are kept as they are
    if (r.type !== 'f' || yes(r.deferrable) || r.match === 'f') {
      otherDefinitions.push(`CONSTRAINT ${postgresDialect.quoteIdentifier(String(r.name))} ${String(r.def)}`)
      continue
    }
    foreignKeys.push({
      name: String(r.name),
      oldName: String(r.name),
      columns: list(r.columns_),
      refSchema: r.ref_schema === schema ? '' : String(r.ref_schema),
      refTable: String(r.ref_table),
      refColumns: list(r.ref_columns),
      onUpdate: actions[String(r.on_update)] ?? '',
      onDelete: actions[String(r.on_delete)] ?? ''
    })
  }
  return {
    name: table,
    columns,
    indexes,
    foreignKeys,
    otherDefinitions,
    options: {
      engine: '',
      charset: '',
      collation: '',
      rowFormat: '',
      autoIncrement: '',
      comment: valueText(rel.comment),
      other: rel.options ? `WITH (${valueText(rel.options)})` : '',
      partition: (rel.partition_key as string | null) ?? ''
    }
  }
}
