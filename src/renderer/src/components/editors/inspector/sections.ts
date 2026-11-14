import type { Row } from '@shared/types'
import type { Dialect } from '@shared/sql/dialect'
import type { Query } from '@/workspace/catalog/catalog'
import type { Workspace } from '@/workspace/workspace'

export interface Field {
  label: string
  key: string
  bytes?: boolean
}

/** A tab of the Table or Schema Inspector. */
export interface Section {
  id: string
  label: string
  /** Text of a list section without rows. */
  empty?: string
  /** Query of the section; its parameters are [schema] or [schema, table]. */
  sql?: string | ((d: Dialect, schema: string, table?: string) => string)
  /** Info sections show the first row as label/value pairs, the others as a list. */
  info?: boolean
  fields?: Field[]
  /** Opens the object of a double-clicked row (schema inspector lists). */
  open?: (ws: Workspace, schema: string, row: Row) => void
  /** Text of a DDL section without a query; by default the object's CREATE statement. */
  text?: (ws: Workspace, schema: string) => Promise<string>
}

export interface InspectorSections {
  table: Section[]
  schema: Section[]
  /** Runs the sections' queries; by default ws.query. */
  query?(ws: Workspace): Query
}

export const f = (label: string, key: string, bytes = false): Field => ({ label, key, bytes })
