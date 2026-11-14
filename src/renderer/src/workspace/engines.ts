import type { Engine } from '@shared/types'
import type { Dialect } from '@shared/sql/dialect'
import { t } from '@/i18n'
import type { AdminPage } from './workspace'

/** An entry of the navigator's Table Maintenance menu: a statement run in a new query tab. */
export interface MaintenanceOp {
  label: string
  /** Statement verb, not translated: names the query tab and lets code find an operation ('analyze'). */
  name: string
  statement(d: Dialect, schema: string, table: string): string
}

const tableStatement =
  (prefix: string): MaintenanceOp['statement'] =>
  (d, schema, table) =>
    `${prefix} ${d.qualified(schema, table)}`

/** Schema prefix of a SQLite PRAGMA or VACUUM: none for main, as Dialect.qualified does. */
const sqliteSchema = (d: Dialect, schema: string): string => (schema === 'main' ? '' : d.quoteIdentifier(schema))

/**
 * What the interface offers for an engine. Engine-specific features exist
 * only where they are listed here; menus and navigator entries of the
 * missing ones are hidden.
 */
export interface EngineFeatures {
  /** Administration pages of the navigator and the Server menu. */
  adminPages: AdminPage[]
  /** Stored procedures and functions. */
  routines: boolean
  triggers: boolean
  /** Create/Alter/Drop Schema. */
  schemaEditor: boolean
  /**
   * New Database: a database or SQLite file opened in a connection of its
   * own, since a session is bound to one. MySQL's databases are its schemas.
   */
  newDatabase: boolean
  /** Reconnect (toolbar, Query menu): a database file has no server to connect to again. */
  reconnect: boolean
  /** Snippets panel (secondary sidebar), with the snippets of the connection's engine. */
  snippets: boolean
  /** Table Maintenance menu; empty when the engine has none. */
  maintenance: MaintenanceOp[]
  /** Vacuum Database on a schema node, run at once: a SQLite schema is a database file. */
  vacuumDatabase?: (d: Dialect, schema: string) => string
  /**
   * What Data Export/Import move: SQL scripts of the chosen schemas and
   * tables, or the whole database as a .bacpac package (sqlpackage).
   */
  dumpFormat: 'sql' | 'bacpac'
  /** Sequences, types and extensions in the navigator. */
  extraPgObjects: boolean
  /** Schema that is the connection's database file (SQLite's main): the navigator shows the file's name for it. */
  fileSchema?: string
}

const features: Record<Engine, EngineFeatures> = {
  mysql: {
    reconnect: true,
    snippets: true,
    adminPages: ['status', 'connections', 'users', 'variables', 'export', 'import', 'copy'],
    routines: true,
    triggers: true,
    schemaEditor: true,
    newDatabase: false,
    maintenance: [
      { label: t('workspace.maintenance.analyzeTable'), name: 'analyze', statement: tableStatement('ANALYZE TABLE') },
      { label: t('workspace.maintenance.optimizeTable'), name: 'optimize', statement: tableStatement('OPTIMIZE TABLE') },
      { label: t('workspace.maintenance.checkTable'), name: 'check', statement: tableStatement('CHECK TABLE') },
      { label: t('workspace.maintenance.repairTable'), name: 'repair', statement: tableStatement('REPAIR TABLE') },
      { label: t('workspace.maintenance.checksumTable'), name: 'checksum', statement: tableStatement('CHECKSUM TABLE') }
    ],
    dumpFormat: 'sql',
    extraPgObjects: false
  },
  postgres: {
    reconnect: true,
    snippets: true,
    adminPages: ['status', 'connections', 'users', 'variables', 'export', 'import'],
    routines: true,
    triggers: true,
    schemaEditor: true,
    newDatabase: true,
    // VERBOSE: the server reports what it did as INFO notices, shown in the output
    maintenance: [
      { label: t('workspace.maintenance.vacuumTable'), name: 'vacuum', statement: tableStatement('VACUUM (VERBOSE)') },
      { label: t('workspace.maintenance.vacuumFullTable'), name: 'vacuum', statement: tableStatement('VACUUM (FULL, VERBOSE)') },
      { label: t('workspace.maintenance.analyzeTable'), name: 'analyze', statement: tableStatement('ANALYZE VERBOSE') },
      { label: t('workspace.maintenance.reindexTable'), name: 'reindex', statement: tableStatement('REINDEX (VERBOSE) TABLE') }
    ],
    dumpFormat: 'sql',
    extraPgObjects: true
  },
  sqlite: {
    reconnect: false,
    snippets: true,
    adminPages: [],
    routines: false,
    triggers: true,
    schemaEditor: false,
    newDatabase: true,
    maintenance: [
      { label: t('workspace.maintenance.analyzeTable'), name: 'analyze', statement: tableStatement('ANALYZE') },
      { label: t('workspace.maintenance.reindexTable'), name: 'reindex', statement: tableStatement('REINDEX') },
      { label: t('workspace.maintenance.checkIntegrity'), name: 'check', statement: (d, schema, table) => `PRAGMA ${[sqliteSchema(d, schema), `integrity_check(${d.quoteIdentifier(table)})`].filter(Boolean).join('.')}` }
    ],
    vacuumDatabase: (d, schema) => `VACUUM ${sqliteSchema(d, schema)}`.trimEnd(),
    dumpFormat: 'sql',
    extraPgObjects: false,
    fileSchema: 'main'
  },
  mssql: {
    reconnect: true,
    snippets: true,
    adminPages: ['status', 'connections', 'users', 'variables', 'agent', 'export', 'import', 'backup'],
    routines: true,
    triggers: true,
    schemaEditor: true,
    newDatabase: true,
    maintenance: [
      { label: t('workspace.maintenance.updateStatistics'), name: 'analyze', statement: tableStatement('UPDATE STATISTICS') },
      { label: t('workspace.maintenance.rebuildIndexes'), name: 'rebuild', statement: (d, schema, table) => `ALTER INDEX ALL ON ${d.qualified(schema, table)} REBUILD` },
      { label: t('workspace.maintenance.reorganizeIndexes'), name: 'reorganize', statement: (d, schema, table) => `ALTER INDEX ALL ON ${d.qualified(schema, table)} REORGANIZE` },
      { label: t('workspace.maintenance.checkTable'), name: 'check', statement: (d, schema, table) => `DBCC CHECKTABLE (${d.quoteString(d.qualified(schema, table))})` }
    ],
    dumpFormat: 'bacpac',
    extraPgObjects: false
  }
}

export const engineFeatures = (engine: Engine): EngineFeatures => features[engine]

export const engineLabels: Record<Engine, string> = { mysql: 'MySQL', postgres: 'PostgreSQL', sqlite: 'SQLite', mssql: 'SQL Server' }
