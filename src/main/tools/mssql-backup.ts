import { t } from '@shared/i18n'
import { backupStatement, restoreStatement } from '@shared/sql/mssql-backup'
import type { ConnectionConfig, MssqlBackupOptions, MssqlRestoreOptions } from '@shared/types'
import { valueText } from '@shared/value-text'
import { forkSession } from '../db/create-session'
import type { DbSession } from '../db/session'
import { checkCancelled, report, type Job } from './jobs'

// SQL Server Backup / Restore: BACKUP and RESTORE run on a session of their
// own, so the editor and the navigator stay usable meanwhile. The server reads
// and writes the .bak file on its own disk.

/** Runs `statements` on a new session, logging each one and the server's messages (STATS, at the end of each). */
async function runOnFork(job: Job, session: DbSession, statements: string[], overrides?: Partial<ConnectionConfig>): Promise<void> {
  const fork = await forkSession(session, overrides)
  // Cancel stops the running statement: tedious sends an attention to the server
  const cancel = (): void => void fork.cancel()
  job.cancelers.add(cancel)
  try {
    for (const sql of statements) {
      checkCancelled(job)
      report(job, { log: t('tools.job.running', { command: sql }) })
      const r = await fork.execute(sql)
      for (const w of r.warnings) report(job, { log: w.message })
      if (r.error) throw new Error(r.error.message)
    }
  } finally {
    job.cancelers.delete(cancel)
    fork.close()
  }
}

export async function mssqlBackup(job: Job, session: DbSession, o: MssqlBackupOptions): Promise<string> {
  report(job, { progress: -1, message: t('tools.mssqlBackup.running', { database: o.database }) })
  // the server deletes the file it was writing, but WITH INIT has already emptied a file that was there
  job.cancelledMessage = t('tools.mssqlBackup.cancelled', { path: o.path })
  await runOnFork(job, session, [backupStatement(o.database, o.path)])
  return t('tools.mssqlBackup.done', { path: o.path })
}

export async function mssqlRestore(job: Job, session: DbSession, o: MssqlRestoreOptions): Promise<string> {
  if (!o.database.trim()) throw new Error(t('tools.mssql.noDatabase'))
  // the connection's database, followed after a USE by the auxiliary connection
  const current = await session.query('SELECT DB_NAME() AS db')
  if (current.error) throw new Error(current.error.message)
  if (valueText(current.rows[0]?.db).toLowerCase() === o.database.toLowerCase()) {
    throw new Error(t('tools.mssqlRestore.currentDatabase', { database: o.database }))
  }
  report(job, { progress: -1, message: t('tools.mssqlRestore.running', { database: o.database }) })
  // on master: the database of the connection's settings may be the one restored, or be missing or restoring
  await runOnFork(job, session, [restoreStatement(o.database, o.path, o.moves, o.replace)], { database: 'master' })
  return t('tools.mssqlRestore.done', { path: o.path, database: o.database })
}
