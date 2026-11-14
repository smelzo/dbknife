import { t } from '@/i18n'
import { metadataQuery } from '@/workspace/catalog/mssql'
import { f, type InspectorSections, type Section } from './sections'

// SQL Server inspector pages from the sys catalog views.

/** sys.objects o and sys.schemas s of the object @p1.@p2. */
const object = 'sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id AND s.name = @p1 AND o.name = @p2'

/** Allocation units a of the partitions p: in-row and row-overflow data by hobt, LOB data by partition. */
const allocation = 'sys.partitions p JOIN sys.allocation_units a ON (a.type IN (1, 3) AND a.container_id = p.hobt_id) OR (a.type = 2 AND a.container_id = p.partition_id)'

/** Sizes in bytes of the tables whose object_id satisfies `where` (p.object_id): heap or clustered index, other indexes, reserved. */
const sizes = (where: string): string =>
  `SELECT SUM(CASE WHEN p.index_id IN (0, 1) THEN a.used_pages ELSE 0 END) * 8192 AS data_size,
          SUM(CASE WHEN p.index_id > 1 THEN a.used_pages ELSE 0 END) * 8192 AS index_size,
          SUM(a.total_pages) * 8192 AS total_size
   FROM ${allocation} WHERE ${where}`

const description = (alias: string, major: string, minor = '0', klass = 1): string =>
  `LEFT JOIN sys.extended_properties ${alias} ON ${alias}.class = ${klass} AND ${alias}.major_id = ${major} AND ${alias}.minor_id = ${minor} AND ${alias}.name = N'MS_Description'`

/** Column type as T-SQL writes it (c: sys.columns, ty: sys.types). */
const columnType = `CASE WHEN ty.is_user_defined = 1 THEN SCHEMA_NAME(ty.schema_id) + '.' + ty.name
  WHEN ty.name IN ('char', 'varchar', 'binary', 'varbinary') THEN ty.name + '(' + IIF(c.max_length = -1, 'max', CAST(c.max_length AS varchar(10))) + ')'
  WHEN ty.name IN ('nchar', 'nvarchar') THEN ty.name + '(' + IIF(c.max_length = -1, 'max', CAST(c.max_length / 2 AS varchar(10))) + ')'
  WHEN ty.name IN ('decimal', 'numeric') THEN ty.name + '(' + CAST(c.precision AS varchar(3)) + ',' + CAST(c.scale AS varchar(3)) + ')'
  WHEN ty.name IN ('datetime2', 'datetimeoffset', 'time') THEN ty.name + '(' + CAST(c.scale AS varchar(3)) + ')'
  ELSE ty.name END`

/** Columns of index i (key or included ones) separated by commas, descending keys marked. */
const indexColumns = (included: 0 | 1): string =>
  `(SELECT STRING_AGG(c.name + IIF(k.is_descending_key = 1, ' DESC', ''), ', ') WITHIN GROUP (ORDER BY k.key_ordinal, k.index_column_id)
    FROM sys.index_columns k JOIN sys.columns c ON c.object_id = k.object_id AND c.column_id = k.column_id
    WHERE k.object_id = i.object_id AND k.index_id = i.index_id AND k.is_included_column = ${included})`

/** Columns of foreign key fk, on its table or on the referenced one. */
const keyColumns = (side: 'parent' | 'referenced'): string =>
  `(SELECT STRING_AGG(c.name, ', ') WITHIN GROUP (ORDER BY k.constraint_column_id)
    FROM sys.foreign_key_columns k JOIN sys.columns c ON c.object_id = k.${side}_object_id AND c.column_id = k.${side}_column_id
    WHERE k.constraint_object_id = fk.object_id)`

const triggerEvents = `(SELECT STRING_AGG(te.type_desc, ' OR ') WITHIN GROUP (ORDER BY te.type) FROM sys.trigger_events te WHERE te.object_id = tr.object_id)`

const routineTypes = `('P', 'PC', 'FN', 'IF', 'TF', 'FS', 'FT')`

const table: Section[] = [
  {
    id: 'info',
    label: t('inspector.section.info'),
    info: true,
    sql: `SELECT o.name, s.name AS schema_name, IIF(tb.temporal_type = 0, tb.type_desc, tb.temporal_type_desc) AS type,
            USER_NAME(COALESCE(o.principal_id, s.principal_id)) AS owner,
            (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)) AS rows_,
            sz.data_size, sz.index_size, sz.total_size, o.create_date, o.modify_date, CAST(ep.value AS nvarchar(max)) AS comment
          FROM ${object}
          JOIN sys.tables tb ON tb.object_id = o.object_id
          OUTER APPLY (${sizes('p.object_id = o.object_id')}) sz
          ${description('ep', 'o.object_id')}`,
    fields: [
      f(t('inspector.field.tableName'), 'name'),
      f(t('inspector.field.schemaName'), 'schema_name'),
      f(t('inspector.field.tableType'), 'type'),
      f(t('inspector.field.owner'), 'owner'),
      f(t('inspector.field.rows'), 'rows_'),
      f(t('inspector.field.dataSize'), 'data_size', true),
      f(t('inspector.field.indexSize'), 'index_size', true),
      f(t('inspector.field.totalSize'), 'total_size', true),
      f(t('inspector.field.created'), 'create_date'),
      f(t('inspector.field.lastAltered'), 'modify_date'),
      f(t('inspector.field.comment'), 'comment')
    ]
  },
  {
    id: 'columns',
    label: t('inspector.section.columns'),
    empty: t('inspector.empty.columns'),
    sql: `SELECT c.name, ${columnType} AS type, dc.definition AS default_value, IIF(c.is_nullable = 1, 'YES', 'NO') AS nullable,
            c.collation_name AS collation,
            CASE WHEN ic.column_id IS NOT NULL
                   THEN 'IDENTITY(' + CAST(ic.seed_value AS nvarchar(40)) + ',' + CAST(ic.increment_value AS nvarchar(40)) + ')'
                 WHEN cc.column_id IS NOT NULL THEN 'AS ' + cc.definition + IIF(cc.is_persisted = 1, ' PERSISTED', '') END AS extra,
            CAST(ep.value AS nvarchar(max)) AS comment
          FROM ${object}
          JOIN sys.columns c ON c.object_id = o.object_id
          JOIN sys.types ty ON ty.user_type_id = c.user_type_id
          LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
          LEFT JOIN sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id
          LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
          ${description('ep', 'c.object_id', 'c.column_id')}
          ORDER BY c.column_id`,
    fields: [
      f(t('inspector.field.column'), 'name'),
      f(t('inspector.field.type'), 'type'),
      f(t('inspector.field.defaultValue'), 'default_value'),
      f(t('inspector.field.nullable'), 'nullable'),
      f(t('inspector.field.collation'), 'collation'),
      f(t('inspector.field.extra'), 'extra'),
      f(t('inspector.field.comments'), 'comment')
    ]
  },
  {
    id: 'indexes',
    label: t('inspector.section.indexes'),
    empty: t('inspector.empty.indexes'),
    sql: `SELECT i.name, i.type_desc AS method, IIF(i.is_unique = 1, 'YES', 'NO') AS is_unique, IIF(i.is_primary_key = 1, 'YES', 'NO') AS is_primary,
            ${indexColumns(0)} AS columns_, ${indexColumns(1)} AS included, i.filter_definition AS filter,
            (SELECT SUM(a.used_pages) * 8192 FROM ${allocation} WHERE p.object_id = i.object_id AND p.index_id = i.index_id) AS size,
            IIF(i.is_disabled = 1, 'NO', 'YES') AS enabled
          FROM ${object}
          JOIN sys.indexes i ON i.object_id = o.object_id AND i.type > 0 AND i.is_hypothetical = 0
          ORDER BY i.is_primary_key DESC, i.name`,
    fields: [
      f(t('inspector.field.index'), 'name'),
      f(t('inspector.field.method'), 'method'),
      f(t('inspector.field.unique'), 'is_unique'),
      f(t('inspector.field.primary'), 'is_primary'),
      f(t('inspector.field.columns'), 'columns_'),
      f(t('inspector.field.included'), 'included'),
      f(t('inspector.field.filter'), 'filter'),
      f(t('inspector.field.size'), 'size', true),
      f(t('inspector.field.enabled'), 'enabled')
    ]
  },
  {
    id: 'constraints',
    label: t('inspector.section.constraints'),
    empty: t('inspector.empty.constraints'),
    sql: `SELECT k.name, k.type_desc AS type,
            CASE k.type
              WHEN 'C' THEN ck.definition
              WHEN 'D' THEN dc.definition + ' FOR ' + dcol.name
              WHEN 'F' THEN 'REFERENCES ' + rs.name + '.' + ro.name
              ELSE (SELECT STRING_AGG(c.name, ', ') WITHIN GROUP (ORDER BY ic.key_ordinal)
                    FROM sys.key_constraints kc JOIN sys.index_columns ic ON ic.object_id = kc.parent_object_id AND ic.index_id = kc.unique_index_id
                    JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
                    WHERE kc.object_id = k.object_id AND ic.is_included_column = 0) END AS definition
          FROM ${object}
          JOIN sys.objects k ON k.parent_object_id = o.object_id AND k.type IN ('PK', 'UQ', 'F', 'C', 'D')
          LEFT JOIN sys.check_constraints ck ON ck.object_id = k.object_id
          LEFT JOIN sys.default_constraints dc ON dc.object_id = k.object_id
          LEFT JOIN sys.columns dcol ON dcol.object_id = dc.parent_object_id AND dcol.column_id = dc.parent_column_id
          LEFT JOIN sys.foreign_keys fk ON fk.object_id = k.object_id
          LEFT JOIN sys.objects ro ON ro.object_id = fk.referenced_object_id LEFT JOIN sys.schemas rs ON rs.schema_id = ro.schema_id
          ORDER BY CASE k.type WHEN 'PK' THEN 0 WHEN 'UQ' THEN 1 WHEN 'F' THEN 2 WHEN 'C' THEN 3 ELSE 4 END, k.name`,
    fields: [f(t('inspector.field.name'), 'name'), f(t('inspector.field.type'), 'type'), f(t('inspector.field.definition'), 'definition')]
  },
  {
    id: 'triggers',
    label: t('inspector.section.triggers'),
    empty: t('inspector.empty.triggers'),
    sql: `SELECT tr.name, IIF(tr.is_instead_of_trigger = 1, 'INSTEAD OF', 'AFTER') AS timing, ${triggerEvents} AS event,
            IIF(tr.is_disabled = 1, 'NO', 'YES') AS enabled, tr.create_date, tr.modify_date
          FROM ${object} JOIN sys.triggers tr ON tr.parent_id = o.object_id
          ORDER BY tr.name`,
    fields: [
      f(t('inspector.field.name'), 'name'),
      f(t('inspector.field.timing'), 'timing'),
      f(t('inspector.field.event'), 'event'),
      f(t('inspector.field.enabled'), 'enabled'),
      f(t('inspector.field.created'), 'create_date'),
      f(t('inspector.field.lastAltered'), 'modify_date')
    ]
  },
  {
    id: 'fks',
    label: t('inspector.section.fks'),
    empty: t('inspector.empty.fks'),
    sql: `SELECT fk.name, ${keyColumns('parent')} AS columns_, rs.name + '.' + ro.name AS referenced, ${keyColumns('referenced')} AS referenced_columns,
            REPLACE(fk.update_referential_action_desc, '_', ' ') AS on_update, REPLACE(fk.delete_referential_action_desc, '_', ' ') AS on_delete,
            IIF(fk.is_disabled = 1, 'NO', 'YES') AS enabled
          FROM ${object}
          JOIN sys.foreign_keys fk ON fk.parent_object_id = o.object_id
          JOIN sys.objects ro ON ro.object_id = fk.referenced_object_id JOIN sys.schemas rs ON rs.schema_id = ro.schema_id
          ORDER BY fk.name`,
    fields: [
      f(t('inspector.field.name'), 'name'),
      f(t('inspector.field.columns'), 'columns_'),
      f(t('inspector.field.referencedTable'), 'referenced'),
      f(t('inspector.field.referencedColumns'), 'referenced_columns'),
      f(t('inspector.field.onUpdate'), 'on_update'),
      f(t('inspector.field.onDelete'), 'on_delete'),
      f(t('inspector.field.enabled'), 'enabled')
    ]
  },
  { id: 'ddl', label: 'DDL' }
]

const schema: Section[] = [
  {
    id: 'info',
    label: t('inspector.section.info'),
    info: true,
    sql: `SELECT s.name, USER_NAME(s.principal_id) AS owner,
            (SELECT COUNT(*) FROM sys.tables x WHERE x.schema_id = s.schema_id) AS tables_,
            (SELECT COUNT(*) FROM sys.views x WHERE x.schema_id = s.schema_id) AS views_,
            (SELECT COUNT(*) FROM sys.objects x WHERE x.schema_id = s.schema_id AND x.type IN ${routineTypes}) AS routines_,
            (SELECT COUNT(*) FROM sys.sequences x WHERE x.schema_id = s.schema_id) AS sequences_,
            sz.data_size, sz.index_size, sz.total_size, CAST(ep.value AS nvarchar(max)) AS comment
          FROM sys.schemas s
          OUTER APPLY (${sizes('p.object_id IN (SELECT x.object_id FROM sys.tables x WHERE x.schema_id = s.schema_id)')}) sz
          ${description('ep', 's.schema_id', '0', 3)}
          WHERE s.name = @p1`,
    fields: [
      f(t('inspector.field.schemaName'), 'name'),
      f(t('inspector.field.owner'), 'owner'),
      f(t('inspector.field.tables'), 'tables_'),
      f(t('inspector.field.views'), 'views_'),
      f(t('inspector.field.routines'), 'routines_'),
      f(t('inspector.field.sequences'), 'sequences_'),
      f(t('inspector.field.dataSize'), 'data_size', true),
      f(t('inspector.field.indexSize'), 'index_size', true),
      f(t('inspector.field.totalSize'), 'total_size', true),
      f(t('inspector.field.comment'), 'comment')
    ]
  },
  {
    id: 'tables',
    label: t('inspector.section.tables'),
    empty: t('inspector.empty.tables'),
    open: (ws, schema, row) => ws.openInspector(schema, String(row.name)),
    sql: `SELECT o.name, (SELECT SUM(p.rows) FROM sys.partitions p WHERE p.object_id = o.object_id AND p.index_id IN (0, 1)) AS rows_,
            sz.data_size, sz.index_size, sz.total_size, o.create_date, o.modify_date, CAST(ep.value AS nvarchar(max)) AS comment
          FROM sys.tables o JOIN sys.schemas s ON s.schema_id = o.schema_id AND s.name = @p1
          OUTER APPLY (${sizes('p.object_id = o.object_id')}) sz
          ${description('ep', 'o.object_id')}
          ORDER BY o.name`,
    fields: [
      f(t('inspector.field.name'), 'name'),
      f(t('inspector.field.rows'), 'rows_'),
      f(t('inspector.field.dataSize'), 'data_size', true),
      f(t('inspector.field.indexSize'), 'index_size', true),
      f(t('inspector.field.totalSize'), 'total_size', true),
      f(t('inspector.field.created'), 'create_date'),
      f(t('inspector.field.lastAltered'), 'modify_date'),
      f(t('inspector.field.comment'), 'comment')
    ]
  },
  {
    id: 'views',
    label: t('inspector.section.views'),
    empty: t('inspector.empty.views'),
    open: (ws, schema, row) => ws.openRoutineEditor(schema, 'VIEW', String(row.name)),
    sql: `SELECT o.name, o.create_date, o.modify_date, CAST(ep.value AS nvarchar(max)) AS comment
          FROM sys.views o JOIN sys.schemas s ON s.schema_id = o.schema_id AND s.name = @p1
          ${description('ep', 'o.object_id')}
          ORDER BY o.name`,
    fields: [f(t('inspector.field.name'), 'name'), f(t('inspector.field.created'), 'create_date'), f(t('inspector.field.lastAltered'), 'modify_date'), f(t('inspector.field.comment'), 'comment')]
  },
  {
    id: 'routines',
    label: t('inspector.section.routines'),
    empty: t('inspector.empty.routines'),
    open: (ws, schema, row) => {
      if (row.type === 'PROCEDURE' || row.type === 'FUNCTION') ws.openRoutineEditor(schema, row.type, String(row.name))
    },
    sql: `SELECT o.name, IIF(o.type IN ('P', 'PC'), 'PROCEDURE', 'FUNCTION') AS type, o.type_desc AS kind, o.create_date, o.modify_date,
            CAST(ep.value AS nvarchar(max)) AS comment
          FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id AND s.name = @p1
          ${description('ep', 'o.object_id')}
          WHERE o.type IN ${routineTypes} AND o.is_ms_shipped = 0
          ORDER BY 2, 1`,
    fields: [
      f(t('inspector.field.name'), 'name'),
      f(t('inspector.field.type'), 'type'),
      f(t('inspector.field.extra'), 'kind'),
      f(t('inspector.field.created'), 'create_date'),
      f(t('inspector.field.lastAltered'), 'modify_date'),
      f(t('inspector.field.comment'), 'comment')
    ]
  },
  {
    id: 'triggers',
    label: t('inspector.section.triggers'),
    empty: t('inspector.empty.triggers'),
    open: (ws, schema, row) => ws.openRoutineEditor(schema, 'TRIGGER', String(row.name), String(row.table_name)),
    sql: `SELECT tr.name, o.name AS table_name, IIF(tr.is_instead_of_trigger = 1, 'INSTEAD OF', 'AFTER') AS timing, ${triggerEvents} AS event,
            IIF(tr.is_disabled = 1, 'NO', 'YES') AS enabled
          FROM sys.triggers tr JOIN sys.objects o ON o.object_id = tr.parent_id JOIN sys.schemas s ON s.schema_id = o.schema_id AND s.name = @p1
          ORDER BY o.name, tr.name`,
    fields: [
      f(t('inspector.field.name'), 'name'),
      f(t('inspector.field.table'), 'table_name'),
      f(t('inspector.field.timing'), 'timing'),
      f(t('inspector.field.event'), 'event'),
      f(t('inspector.field.enabled'), 'enabled')
    ]
  },
  { id: 'ddl', label: 'DDL' }
]

// the catalog's guard against DDL transactions of the user connection holds for these queries too
export const mssqlInspector: InspectorSections = { table, schema, query: (ws) => metadataQuery(ws.query) }
