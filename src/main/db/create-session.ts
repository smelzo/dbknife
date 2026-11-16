import { t } from '@shared/i18n'
import type { ConnectionConfig } from '@shared/types'
import { CsvSession } from './drivers/csv'
import { MssqlSession } from './drivers/mssql'
import { MysqlSession } from './drivers/mysql'
import { SqliteSession } from './drivers/sqlite'
import { RemoteSqliteSession } from './drivers/sqlite-remote'
import { PostgresSession } from './drivers/postgres'
import { ServerSession } from './server-session'
import { channelId, type DbSession, type SessionSecrets } from './session'

export function createSession(config: ConnectionConfig, secrets: SessionSecrets, safeUpdates: boolean): DbSession {
  switch (config.engine) {
    case 'mysql':
      return new MysqlSession(config, secrets, safeUpdates)
    case 'sqlite':
      if (config.csv) return new CsvSession(config, safeUpdates)
      return channelId(config) ? new RemoteSqliteSession(config, secrets, safeUpdates) : new SqliteSession(config, safeUpdates)
    case 'postgres':
      return new PostgresSession(config, secrets, safeUpdates)
    case 'mssql':
      return new MssqlSession(config, secrets, safeUpdates)
    default:
      throw new Error(t('main.session.unsupportedEngine', { engine: String(config.engine) }))
  }
}

/**
 * A new open session with the credentials of `session`, which the caller closes (server engines only);
 * `overrides` replace settings of the connection (e.g. the database it starts on).
 */
export async function forkSession(session: DbSession, overrides: Partial<ConnectionConfig> = {}): Promise<DbSession> {
  if (!(session instanceof ServerSession)) throw new Error(`Cannot fork a ${session.config.engine} session`)
  const fork = createSession({ ...session.config, ...overrides }, session.secrets, false)
  try {
    await fork.open()
  } catch (err) {
    // open() leaves the SSH tunnel up when the first connection fails
    fork.close()
    throw err
  }
  return fork
}
