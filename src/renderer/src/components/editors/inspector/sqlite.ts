import type { Dialect } from '@shared/sql/dialect'
import { t } from '@/i18n'
import { f, type InspectorSections, type Section } from './sections'

// SQLite inspector pages from the PRAGMA table-valued functions, sqlite_master
// and dbstat. Parameters: ?1 is the schema (database name), ?2 the table.

const master = (d: Dialect, schema: string): string => `${d.quoteIdentifier(schema)}.sqlite_master`
const userObject = `name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`

const table: Section[] = [
  {
    id: 'info',
    label: t('inspector.section.info'),
    info: true,
    sql: (d, schema, table) =>
      `SELECT l.name AS name, upper(l.type) AS type, l.ncol AS columns_, (SELECT count(*) FROM ${d.qualified(schema, table!)}) AS rows_,
         (SELECT sum(pgsize) FROM dbstat(?1) WHERE name = ?2) AS table_size,
         (SELECT sum(s.pgsize) FROM dbstat(?1) s JOIN ${master(d, schema)} m ON m.name = s.name AND m.type = 'index' WHERE m.tbl_name = ?2) AS index_size,
         (SELECT count(*) FROM ${master(d, schema)} WHERE type = 'index' AND tbl_name = ?2) AS indexes_,
         (SELECT count(*) FROM ${master(d, schema)} WHERE type = 'trigger' AND tbl_name = ?2) AS triggers_,
         CASE l.wr WHEN 1 THEN 'YES' ELSE 'NO' END AS without_rowid, CASE l.strict WHEN 1 THEN 'YES' ELSE 'NO' END AS strict_
       FROM pragma_table_list l WHERE l.schema = ?1 AND l.name = ?2`,
    fields: [
      f(t('inspector.field.tableName'), 'name'),
      f(t('inspector.field.tableType'), 'type'),
      f(t('inspector.field.columns'), 'columns_'),
      f(t('inspector.field.rows'), 'rows_'),
      f(t('inspector.field.tableSize'), 'table_size', true),
      f(t('inspector.field.indexSize'), 'index_size', true),
      f(t('inspector.field.indexes'), 'indexes_'),
      f(t('inspector.field.triggers'), 'triggers_'),
      f(t('inspector.field.withoutRowid'), 'without_rowid'),
      f(t('inspector.field.strict'), 'strict_')
    ]
  },
  {
    id: 'columns',
    label: t('inspector.section.columns'),
    empty: t('inspector.empty.columns'),
    sql: `SELECT name, type, dflt_value AS default_value, CASE "notnull" WHEN 1 THEN 'NO' ELSE 'YES' END AS nullable,
            CASE WHEN pk > 0 THEN pk END AS primary_key,
            CASE hidden WHEN 1 THEN 'HIDDEN' WHEN 2 THEN 'VIRTUAL GENERATED' WHEN 3 THEN 'STORED GENERATED' END AS extra
          FROM pragma_table_xinfo(?2, ?1) ORDER BY cid`,
    fields: [
      f(t('inspector.field.column'), 'name'),
      f(t('inspector.field.type'), 'type'),
      f(t('inspector.field.defaultValue'), 'default_value'),
      f(t('inspector.field.nullable'), 'nullable'),
      f(t('inspector.field.primaryKey'), 'primary_key'),
      f(t('inspector.field.extra'), 'extra')
    ]
  },
  {
    id: 'indexes',
    label: t('inspector.section.indexes'),
    empty: t('inspector.empty.indexes'),
    sql: (d, schema) =>
      `SELECT il.name AS name, CASE il."unique" WHEN 1 THEN 'YES' ELSE 'NO' END AS is_unique,
         CASE il.origin WHEN 'pk' THEN 'PRIMARY KEY' WHEN 'u' THEN 'UNIQUE constraint' ELSE 'CREATE INDEX' END AS origin,
         CASE il.partial WHEN 1 THEN 'YES' ELSE 'NO' END AS partial,
         (SELECT group_concat(coalesce(ii.name, '<expression>') || CASE ii."desc" WHEN 1 THEN ' DESC' ELSE '' END, ', ' ORDER BY ii.seqno)
           FROM pragma_index_xinfo(il.name, ?1) ii WHERE ii.key = 1) AS columns_,
         (SELECT sum(pgsize) FROM dbstat(?1) WHERE name = il.name) AS size, m.sql AS definition
       FROM pragma_index_list(?2, ?1) il LEFT JOIN ${master(d, schema)} m ON m.type = 'index' AND m.name = il.name
       ORDER BY il.origin <> 'pk', il.name`,
    fields: [
      f(t('inspector.field.index'), 'name'),
      f(t('inspector.field.unique'), 'is_unique'),
      f(t('inspector.field.origin'), 'origin'),
      f(t('inspector.field.partial'), 'partial'),
      f(t('inspector.field.columns'), 'columns_'),
      f(t('inspector.field.size'), 'size', true),
      f(t('inspector.field.definition'), 'definition')
    ]
  },
  {
    id: 'triggers',
    label: t('inspector.section.triggers'),
    empty: t('inspector.empty.triggers'),
    sql: (d, schema) => `SELECT name, sql AS definition FROM ${master(d, schema)} WHERE type = 'trigger' AND tbl_name = ?2 COLLATE NOCASE ORDER BY name`,
    fields: [f(t('inspector.field.name'), 'name'), f(t('inspector.field.definition'), 'definition')]
  },
  {
    id: 'fks',
    label: t('inspector.section.fks'),
    empty: t('inspector.empty.fks'),
    sql: `SELECT id, group_concat("from", ', ' ORDER BY seq) AS columns_, "table" AS referenced,
            group_concat(coalesce("to", '(primary key)'), ', ' ORDER BY seq) AS referenced_columns,
            on_update, on_delete, "match"
          FROM pragma_foreign_key_list(?2, ?1) GROUP BY id ORDER BY id`,
    fields: [
      f(t('inspector.field.id'), 'id'),
      f(t('inspector.field.columns'), 'columns_'),
      f(t('inspector.field.referencedTable'), 'referenced'),
      f(t('inspector.field.referencedColumns'), 'referenced_columns'),
      f(t('inspector.field.onUpdate'), 'on_update'),
      f(t('inspector.field.onDelete'), 'on_delete'),
      f(t('inspector.field.match'), 'match')
    ]
  },
  { id: 'ddl', label: 'DDL' }
]

const schema: Section[] = [
  {
    id: 'info',
    label: t('inspector.section.info'),
    info: true,
    sql: (d, schema) =>
      `SELECT d.name AS name, CASE d.file WHEN '' THEN '(in memory or temporary)' ELSE d.file END AS file,
         (SELECT count(*) FROM ${master(d, schema)} WHERE type = 'table' AND ${userObject}) AS tables_,
         (SELECT count(*) FROM ${master(d, schema)} WHERE type = 'view') AS views_,
         (SELECT count(*) FROM ${master(d, schema)} WHERE type = 'index') AS indexes_,
         (SELECT count(*) FROM ${master(d, schema)} WHERE type = 'trigger') AS triggers_,
         (SELECT page_size FROM pragma_page_size(?1)) AS page_size, (SELECT page_count FROM pragma_page_count(?1)) AS page_count,
         (SELECT page_size FROM pragma_page_size(?1)) * (SELECT page_count FROM pragma_page_count(?1)) AS total_size,
         (SELECT journal_mode FROM pragma_journal_mode(?1)) AS journal_mode,
         (SELECT CASE auto_vacuum WHEN 1 THEN 'FULL' WHEN 2 THEN 'INCREMENTAL' ELSE 'NONE' END FROM pragma_auto_vacuum(?1)) AS auto_vacuum,
         (SELECT encoding FROM pragma_encoding) AS encoding
       FROM pragma_database_list d WHERE d.name = ?1`,
    fields: [
      f(t('inspector.field.schemaName'), 'name'),
      f(t('inspector.field.file'), 'file'),
      f(t('inspector.field.tables'), 'tables_'),
      f(t('inspector.field.views'), 'views_'),
      f(t('inspector.field.indexes'), 'indexes_'),
      f(t('inspector.field.triggers'), 'triggers_'),
      f(t('inspector.field.pageSize'), 'page_size', true),
      f(t('inspector.field.pages'), 'page_count'),
      f(t('inspector.field.totalSize'), 'total_size', true),
      f(t('inspector.field.journalMode'), 'journal_mode'),
      f(t('inspector.field.autoVacuum'), 'auto_vacuum'),
      f(t('inspector.field.encoding'), 'encoding')
    ]
  },
  {
    id: 'tables',
    label: t('inspector.section.tables'),
    empty: t('inspector.empty.tables'),
    open: (ws, schema, row) => ws.openInspector(schema, String(row.name)),
    // one dbstat scan for the sizes of every b-tree
    sql: (d, schema) =>
      `WITH sizes AS (SELECT name, sum(pgsize) AS size FROM dbstat(?1) GROUP BY name)
       SELECT l.name AS name, l.ncol AS columns_, (SELECT size FROM sizes WHERE sizes.name = l.name) AS table_size,
         (SELECT sum(size) FROM sizes JOIN ${master(d, schema)} m ON m.name = sizes.name AND m.type = 'index' WHERE m.tbl_name = l.name) AS index_size,
         CASE l.wr WHEN 1 THEN 'YES' ELSE 'NO' END AS without_rowid, CASE l.strict WHEN 1 THEN 'YES' ELSE 'NO' END AS strict_
       FROM pragma_table_list l WHERE l.schema = ?1 AND l.type = 'table' AND l.${userObject} ORDER BY l.name`,
    fields: [
      f(t('inspector.field.name'), 'name'),
      f(t('inspector.field.columns'), 'columns_'),
      f(t('inspector.field.tableSize'), 'table_size', true),
      f(t('inspector.field.indexSize'), 'index_size', true),
      f(t('inspector.field.withoutRowid'), 'without_rowid'),
      f(t('inspector.field.strict'), 'strict_')
    ]
  },
  {
    id: 'views',
    label: t('inspector.section.views'),
    empty: t('inspector.empty.views'),
    open: (ws, schema, row) => ws.openRoutineEditor(schema, 'VIEW', String(row.name)),
    sql: (d, schema) => `SELECT name, sql AS definition FROM ${master(d, schema)} WHERE type = 'view' ORDER BY name`,
    fields: [f(t('inspector.field.name'), 'name'), f(t('inspector.field.definition'), 'definition')]
  },
  {
    id: 'triggers',
    label: t('inspector.section.triggers'),
    empty: t('inspector.empty.triggers'),
    open: (ws, schema, row) => ws.openRoutineEditor(schema, 'TRIGGER', String(row.name), String(row.table_name)),
    sql: (d, schema) => `SELECT name, tbl_name AS table_name, sql AS definition FROM ${master(d, schema)} WHERE type = 'trigger' ORDER BY tbl_name, name`,
    fields: [f(t('inspector.field.name'), 'name'), f(t('inspector.field.table'), 'table_name'), f(t('inspector.field.definition'), 'definition')]
  },
  {
    id: 'ddl',
    label: 'DDL',
    // the database has no CREATE statement of its own: the statements of all its objects
    text: async (ws, schema) => {
      const r = await window.api.db.query(
        ws.sessionId,
        `SELECT sql FROM ${master(ws.dialect, schema)} WHERE sql IS NOT NULL AND ${userObject}
         ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END, name`
      )
      if (r.error) throw new Error(r.error.message)
      return r.rows.map((row) => `${String(row.sql)};`).join('\n\n')
    }
  }
]

export const sqliteInspector: InspectorSections = { table, schema }
