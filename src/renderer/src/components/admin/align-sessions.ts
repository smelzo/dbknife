import { reactive } from 'vue'
import type { AlignEnd, AlignOptions, Alignment, ConnectionConfig } from '@shared/types'
import type { Workspace } from '@/workspace/workspace'
import { alertError, promptText } from '@/dialogs'
import { t } from '@/i18n'
import { useApp, withCredentials } from '@/stores/app'

// Sessions, sides and saving of an alignment, shared by the Alignment page,
// its editor and the quick dialog of the table menu.

/** A session to read or align a side of an alignment; `close` ends it when the caller opened it. */
export interface AlignSession {
  sessionId: string
  close: () => void
}

/** The saved connection, or the workspace's own (which may be a temporary one, not in the list). */
export function alignConnection(ws: Workspace, connectionId: string): ConnectionConfig | undefined {
  return connectionId === ws.config.id ? ws.config : useApp().connections.find((c) => c.id === connectionId)
}

/**
 * The workspace's session for its own connection (left open), a new one on another
 * saved connection, asking for the secrets it lacks; undefined when the connection
 * is not saved any more, the prompt is cancelled or the connection fails (said in an alert).
 */
export async function openSessionFor(ws: Workspace, connectionId: string): Promise<AlignSession | undefined> {
  if (connectionId === ws.config.id) return { sessionId: ws.sessionId, close: () => undefined }
  const config = alignConnection(ws, connectionId)
  if (!config) return undefined
  const r = await withCredentials(config, (c) => window.api.db.open(config.id, c))
  if (r?.ok) {
    const sessionId = r.sessionId!
    return { sessionId, close: () => void window.api.db.close(sessionId) }
  }
  if (r) await alertError(t('app.connectFailed', { name: config.name }), r.error?.message)
  return undefined
}

/** The workspace's connection first, then the other MySQL/MariaDB ones. */
export const alignConnections = (ws: Workspace): ConnectionConfig[] => [ws.config, ...useApp().connections.filter((c) => c.engine === 'mysql' && c.id !== ws.config.id)]

export const defaultAlignOptions: Readonly<AlignOptions> = { structure: true, data: true, deleteRows: false, definers: 'keep', backup: true }

/** A side of an alignment being chosen: the connection with its open session and its schemas. */
export interface AlignSide {
  connectionId: string
  schema: string
  schemas: string[]
  session?: AlignSession
  /** Number of the latest choice: a session still opening for an earlier one is closed when it arrives. */
  opening: number
}

export const alignSide = (ws: Workspace, e?: Partial<AlignEnd>): AlignSide =>
  reactive({ connectionId: e?.connectionId ?? ws.config.id, schema: e?.schema ?? '', schemas: [], opening: 0 })

const schemataSql = 'SELECT SCHEMA_NAME AS s FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME'

/**
 * Chooses the side's connection: opens its session and lists its schemas, without the
 * system ones and those `skip` leaves out; the schema chosen stays if the list has it.
 */
export async function chooseSide(ws: Workspace, side: AlignSide, connectionId: string, skip?: (schema: string) => boolean): Promise<void> {
  const n = ++side.opening
  side.session?.close()
  side.session = undefined
  side.schemas = []
  side.connectionId = connectionId
  if (!connectionId) return
  const s = await openSessionFor(ws, connectionId)
  if (n !== side.opening) return s?.close()
  if (!s) {
    side.connectionId = ''
    return
  }
  side.session = s
  const r = await window.api.db.query(s.sessionId, schemataSql)
  if (n !== side.opening) return
  if (r.error) await alertError(t('admin.align.schemasFailed', { name: alignConnection(ws, connectionId)?.name ?? '' }), r.error.message)
  side.schemas = r.error ? [] : r.rows.map((x) => String(x.s)).filter((x) => !ws.dialect.isSystemSchema(x) && !skip?.(x))
  if (!side.schemas.includes(side.schema)) side.schema = ''
}

/** Closes the side's session, also one still opening (when the component goes away). */
export function closeSide(side: AlignSide): void {
  side.opening++
  side.session?.close()
}

/** An alignment without its identity and runs, as the editor and the dialog build it. */
export type AlignmentFields = Omit<Alignment, 'id' | 'name' | 'runs'>

/** Asks the name of a new alignment and saves it; undefined when cancelled or not saved (said in an alert). */
export async function saveNewAlignment(fields: AlignmentFields): Promise<Alignment | undefined> {
  const typed = await promptText(t('admin.align.saveTitle'), t('admin.align.name'), t('admin.align.defaultName', { source: fields.source.schema, target: fields.target.schema }))
  const name = typed?.trim()
  if (!name) return undefined
  const alignment: Alignment = { ...fields, id: crypto.randomUUID(), name, runs: [] }
  try {
    await window.api.alignments.save(alignment)
    return alignment
  } catch (err) {
    await alertError(t('admin.align.saveFailed', { name }), (err as Error).message)
    return undefined
  }
}
