import type { ConnectionConfig } from '@shared/types'
import type { Workspace } from '@/workspace/workspace'
import { alertError } from '@/dialogs'
import { t } from '@/i18n'
import { useApp, withCredentials } from '@/stores/app'

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
