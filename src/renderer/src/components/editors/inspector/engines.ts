import type { Engine } from '@shared/types'
import { mysqlInspector } from './mysql'
import { postgresInspector } from './postgres'
import type { InspectorSections } from './sections'
import { sqliteInspector } from './sqlite'
import { mssqlInspector } from './mssql'

const sections: Record<Engine, InspectorSections> = { mysql: mysqlInspector, postgres: postgresInspector, sqlite: sqliteInspector, mssql: mssqlInspector }

export const inspectorSections = (engine: Engine): InspectorSections => sections[engine]
