import { t } from '@/i18n'
import { f, type InspectorSections, type Section } from './sections'

// MySQL / MariaDB inspector pages from information_schema.

const table: Section[] = [
  {
    id: 'info',
    label: t('inspector.section.info'),
    info: true,
    sql: 'SELECT * FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
    fields: [
      f(t('inspector.field.tableName'), 'TABLE_NAME'),
      f(t('inspector.field.tableType'), 'TABLE_TYPE'),
      f(t('inspector.field.engine'), 'ENGINE'),
      f(t('inspector.field.rowFormat'), 'ROW_FORMAT'),
      f(t('inspector.field.rowsEstimate'), 'TABLE_ROWS'),
      f(t('inspector.field.avgRowLength'), 'AVG_ROW_LENGTH', true),
      f(t('inspector.field.dataLength'), 'DATA_LENGTH', true),
      f(t('inspector.field.indexLength'), 'INDEX_LENGTH', true),
      f(t('inspector.field.dataFree'), 'DATA_FREE', true),
      f(t('inspector.field.maxDataLength'), 'MAX_DATA_LENGTH', true),
      f(t('inspector.field.autoIncrement'), 'AUTO_INCREMENT'),
      f(t('inspector.field.createTime'), 'CREATE_TIME'),
      f(t('inspector.field.updateTime'), 'UPDATE_TIME'),
      f(t('inspector.field.checkTime'), 'CHECK_TIME'),
      f(t('inspector.field.collation'), 'TABLE_COLLATION'),
      f(t('inspector.field.createOptions'), 'CREATE_OPTIONS'),
      f(t('inspector.field.comment'), 'TABLE_COMMENT')
    ]
  },
  {
    id: 'columns',
    label: t('inspector.section.columns'),
    empty: t('inspector.empty.columns'),
    sql: `SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_DEFAULT, IS_NULLABLE, CHARACTER_SET_NAME, COLLATION_NAME, PRIVILEGES, EXTRA, COLUMN_COMMENT
          FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
    fields: [
      f(t('inspector.field.column'), 'COLUMN_NAME'),
      f(t('inspector.field.type'), 'COLUMN_TYPE'),
      f(t('inspector.field.defaultValue'), 'COLUMN_DEFAULT'),
      f(t('inspector.field.nullable'), 'IS_NULLABLE'),
      f(t('inspector.field.characterSet'), 'CHARACTER_SET_NAME'),
      f(t('inspector.field.collation'), 'COLLATION_NAME'),
      f(t('inspector.field.privileges'), 'PRIVILEGES'),
      f(t('inspector.field.extra'), 'EXTRA'),
      f(t('inspector.field.comments'), 'COLUMN_COMMENT')
    ]
  },
  {
    id: 'indexes',
    label: t('inspector.section.indexes'),
    empty: t('inspector.empty.indexes'),
    sql: `SELECT INDEX_NAME, INDEX_TYPE, IF(NON_UNIQUE = 0, 'YES', 'NO') AS IS_UNIQUE,
            GROUP_CONCAT(CONCAT(IFNULL(COLUMN_NAME, '(expression)'), IFNULL(CONCAT('(', SUB_PART, ')'), ''), IF(COLLATION = 'D', ' DESC', ''))
              ORDER BY SEQ_IN_INDEX SEPARATOR ', ') AS COLUMNS_,
            MAX(CARDINALITY) AS CARDINALITY, INDEX_COMMENT
          FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
          GROUP BY INDEX_NAME, INDEX_TYPE, NON_UNIQUE, INDEX_COMMENT ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME`,
    fields: [
      f(t('inspector.field.index'), 'INDEX_NAME'),
      f(t('inspector.field.type'), 'INDEX_TYPE'),
      f(t('inspector.field.unique'), 'IS_UNIQUE'),
      f(t('inspector.field.columns'), 'COLUMNS_'),
      f(t('inspector.field.cardinality'), 'CARDINALITY'),
      f(t('inspector.field.comment'), 'INDEX_COMMENT')
    ]
  },
  {
    id: 'triggers',
    label: t('inspector.section.triggers'),
    empty: t('inspector.empty.triggers'),
    sql: `SELECT TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION, CREATED, DEFINER, SQL_MODE
          FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ? ORDER BY ACTION_ORDER`,
    fields: [
      f(t('inspector.field.name'), 'TRIGGER_NAME'),
      f(t('inspector.field.timing'), 'ACTION_TIMING'),
      f(t('inspector.field.event'), 'EVENT_MANIPULATION'),
      f(t('inspector.field.created'), 'CREATED'),
      f(t('inspector.field.definer'), 'DEFINER'),
      f(t('inspector.field.sqlMode'), 'SQL_MODE')
    ]
  },
  {
    id: 'fks',
    label: t('inspector.section.fks'),
    empty: t('inspector.empty.fks'),
    sql: `SELECT k.CONSTRAINT_NAME, GROUP_CONCAT(k.COLUMN_NAME ORDER BY k.ORDINAL_POSITION SEPARATOR ', ') AS COLUMNS_,
            CONCAT(k.REFERENCED_TABLE_SCHEMA, '.', k.REFERENCED_TABLE_NAME) AS REFERENCED,
            GROUP_CONCAT(k.REFERENCED_COLUMN_NAME ORDER BY k.ORDINAL_POSITION SEPARATOR ', ') AS REFERENCED_COLUMNS,
            r.UPDATE_RULE, r.DELETE_RULE
          FROM information_schema.KEY_COLUMN_USAGE k
          JOIN information_schema.REFERENTIAL_CONSTRAINTS r
            ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
          WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
          GROUP BY k.CONSTRAINT_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, r.UPDATE_RULE, r.DELETE_RULE
          ORDER BY k.CONSTRAINT_NAME`,
    fields: [
      f(t('inspector.field.name'), 'CONSTRAINT_NAME'),
      f(t('inspector.field.columns'), 'COLUMNS_'),
      f(t('inspector.field.referencedTable'), 'REFERENCED'),
      f(t('inspector.field.referencedColumns'), 'REFERENCED_COLUMNS'),
      f(t('inspector.field.onUpdate'), 'UPDATE_RULE'),
      f(t('inspector.field.onDelete'), 'DELETE_RULE')
    ]
  },
  { id: 'ddl', label: 'DDL' }
]

const schema: Section[] = [
  {
    id: 'info',
    label: t('inspector.section.info'),
    info: true,
    sql: `SELECT s.SCHEMA_NAME, s.DEFAULT_CHARACTER_SET_NAME, s.DEFAULT_COLLATION_NAME,
            SUM(t.TABLE_TYPE = 'BASE TABLE') AS TABLES_, SUM(t.TABLE_TYPE = 'VIEW') AS VIEWS_,
            SUM(t.DATA_LENGTH) AS DATA_LENGTH, SUM(t.INDEX_LENGTH) AS INDEX_LENGTH,
            SUM(t.DATA_LENGTH) + SUM(t.INDEX_LENGTH) AS TOTAL_LENGTH,
            (SELECT COUNT(*) FROM information_schema.ROUTINES r WHERE r.ROUTINE_SCHEMA = s.SCHEMA_NAME) AS ROUTINES_
          FROM information_schema.SCHEMATA s LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME
          WHERE s.SCHEMA_NAME = ?
          GROUP BY s.SCHEMA_NAME, s.DEFAULT_CHARACTER_SET_NAME, s.DEFAULT_COLLATION_NAME`,
    fields: [
      f(t('inspector.field.schemaName'), 'SCHEMA_NAME'),
      f(t('inspector.field.defaultCharset'), 'DEFAULT_CHARACTER_SET_NAME'),
      f(t('inspector.field.defaultCollation'), 'DEFAULT_COLLATION_NAME'),
      f(t('inspector.field.tables'), 'TABLES_'),
      f(t('inspector.field.views'), 'VIEWS_'),
      f(t('inspector.field.routines'), 'ROUTINES_'),
      f(t('inspector.field.dataLength'), 'DATA_LENGTH', true),
      f(t('inspector.field.indexLength'), 'INDEX_LENGTH', true),
      f(t('inspector.field.totalSize'), 'TOTAL_LENGTH', true)
    ]
  },
  {
    id: 'tables',
    label: t('inspector.section.tables'),
    empty: t('inspector.empty.tables'),
    open: (ws, schema, row) => ws.openInspector(schema, String(row.TABLE_NAME)),
    sql: `SELECT TABLE_NAME, ENGINE, TABLE_ROWS, AVG_ROW_LENGTH, DATA_LENGTH, INDEX_LENGTH, DATA_FREE, AUTO_INCREMENT,
            TABLE_COLLATION, CREATE_TIME, UPDATE_TIME, TABLE_COMMENT
          FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`,
    fields: [
      f(t('inspector.field.name'), 'TABLE_NAME'),
      f(t('inspector.field.engine'), 'ENGINE'),
      f(t('inspector.field.rows'), 'TABLE_ROWS'),
      f(t('inspector.field.avgRowLength'), 'AVG_ROW_LENGTH', true),
      f(t('inspector.field.dataLength'), 'DATA_LENGTH', true),
      f(t('inspector.field.indexLength'), 'INDEX_LENGTH', true),
      f(t('inspector.field.dataFree'), 'DATA_FREE', true),
      f(t('inspector.field.autoIncrement'), 'AUTO_INCREMENT'),
      f(t('inspector.field.collation'), 'TABLE_COLLATION'),
      f(t('inspector.field.createTime'), 'CREATE_TIME'),
      f(t('inspector.field.updateTime'), 'UPDATE_TIME'),
      f(t('inspector.field.comment'), 'TABLE_COMMENT')
    ]
  },
  {
    id: 'views',
    label: t('inspector.section.views'),
    empty: t('inspector.empty.views'),
    open: (ws, schema, row) => ws.openRoutineEditor(schema, 'VIEW', String(row.TABLE_NAME)),
    sql: `SELECT TABLE_NAME, IS_UPDATABLE, CHECK_OPTION, DEFINER, SECURITY_TYPE, CHARACTER_SET_CLIENT, COLLATION_CONNECTION
          FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME`,
    fields: [
      f(t('inspector.field.name'), 'TABLE_NAME'),
      f(t('inspector.field.updatable'), 'IS_UPDATABLE'),
      f(t('inspector.field.checkOption'), 'CHECK_OPTION'),
      f(t('inspector.field.definer'), 'DEFINER'),
      f(t('inspector.field.security'), 'SECURITY_TYPE'),
      f(t('inspector.field.clientCharset'), 'CHARACTER_SET_CLIENT'),
      f(t('inspector.field.connectionCollation'), 'COLLATION_CONNECTION')
    ]
  },
  {
    id: 'routines',
    label: t('inspector.section.routines'),
    empty: t('inspector.empty.routines'),
    open: (ws, schema, row) => ws.openRoutineEditor(schema, row.ROUTINE_TYPE as 'PROCEDURE' | 'FUNCTION', String(row.ROUTINE_NAME)),
    sql: `SELECT ROUTINE_NAME, ROUTINE_TYPE, DEFINER, CREATED, LAST_ALTERED, SECURITY_TYPE, IS_DETERMINISTIC, SQL_DATA_ACCESS, ROUTINE_COMMENT
          FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_TYPE, ROUTINE_NAME`,
    fields: [
      f(t('inspector.field.name'), 'ROUTINE_NAME'),
      f(t('inspector.field.type'), 'ROUTINE_TYPE'),
      f(t('inspector.field.definer'), 'DEFINER'),
      f(t('inspector.field.created'), 'CREATED'),
      f(t('inspector.field.lastAltered'), 'LAST_ALTERED'),
      f(t('inspector.field.security'), 'SECURITY_TYPE'),
      f(t('inspector.field.deterministic'), 'IS_DETERMINISTIC'),
      f(t('inspector.field.dataAccess'), 'SQL_DATA_ACCESS'),
      f(t('inspector.field.comment'), 'ROUTINE_COMMENT')
    ]
  },
  {
    id: 'triggers',
    label: t('inspector.section.triggers'),
    empty: t('inspector.empty.triggers'),
    open: (ws, schema, row) => ws.openRoutineEditor(schema, 'TRIGGER', String(row.TRIGGER_NAME), String(row.EVENT_OBJECT_TABLE)),
    sql: `SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, CREATED, DEFINER
          FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY EVENT_OBJECT_TABLE, ACTION_ORDER`,
    fields: [
      f(t('inspector.field.name'), 'TRIGGER_NAME'),
      f(t('inspector.field.table'), 'EVENT_OBJECT_TABLE'),
      f(t('inspector.field.timing'), 'ACTION_TIMING'),
      f(t('inspector.field.event'), 'EVENT_MANIPULATION'),
      f(t('inspector.field.created'), 'CREATED'),
      f(t('inspector.field.definer'), 'DEFINER')
    ]
  },
  { id: 'ddl', label: 'DDL' }
]

export const mysqlInspector: InspectorSections = { table, schema }
