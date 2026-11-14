import { ipcMain } from 'electron'
import { t } from '@shared/i18n'
import type { CopyOptions, CopySchemaRef, DumpOptions, Engine, ImportOptions, MssqlBackupOptions, MssqlRestoreOptions } from '@shared/types'
import type { DbSession } from '../db/session'
import { copyDatabase, copyPreview } from './copy-mysql'
import { jobs, startJob, type ToolSet } from './jobs'
import { mssqlTools } from './mssql'
import { mssqlBackup, mssqlRestore } from './mssql-backup'
import { mysqlTools } from './mysql'
import { postgresTools } from './postgres'

// Data export/import through the engines' client tools.

const toolSets: Record<Exclude<Engine, 'sqlite'>, ToolSet> = { mysql: mysqlTools, postgres: postgresTools, mssql: mssqlTools }

export function registerToolHandlers(getAnySession: (id: string) => DbSession): void {
  const get = (id: string): [DbSession, ToolSet] => {
    const session = getAnySession(id)
    const engine = session.config.engine
    if (engine === 'sqlite') throw new Error(t('tools.sqliteUnavailable'))
    return [session, toolSets[engine]]
  }
  const getMysql = (id: string): DbSession => {
    const session = getAnySession(id)
    if (session.config.engine !== 'mysql') throw new Error(t('tools.copy.unsupported'))
    return session
  }
  const getMssql = (id: string): DbSession => {
    const session = getAnySession(id)
    if (session.config.engine !== 'mssql') throw new Error(t('tools.mssqlBackup.unsupported'))
    return session
  }
  ipcMain.handle('tools:find', async (_e, sessionId: string) => {
    const [session, tools] = get(sessionId)
    return tools.find(session)
  })
  ipcMain.handle('tools:exportDump', (e, sessionId: string, options: DumpOptions) => {
    const [session, tools] = get(sessionId)
    return startJob(e.sender, (job) => tools.exportDump(job, session, options))
  })
  ipcMain.handle('tools:importDump', (e, sessionId: string, options: ImportOptions) => {
    const [session, tools] = get(sessionId)
    return startJob(e.sender, (job) => tools.importDump(job, session, options))
  })
  ipcMain.handle('tools:copyPreview', (_e, sessionId: string, schemas: CopySchemaRef[], targetSessionId: string | null) =>
    copyPreview(getMysql(sessionId), schemas, targetSessionId === null ? undefined : getMysql(targetSessionId))
  )
  ipcMain.handle('tools:copyDatabase', (e, sessionId: string, options: CopyOptions) => {
    const source = getMysql(sessionId)
    const target = options.target.kind === 'connection' ? getMysql(options.target.sessionId) : undefined
    return startJob(e.sender, (job) => copyDatabase(job, source, options, target))
  })
  ipcMain.handle('tools:mssqlBackup', (e, sessionId: string, options: MssqlBackupOptions) => {
    const session = getMssql(sessionId)
    return startJob(e.sender, (job) => mssqlBackup(job, session, options))
  })
  ipcMain.handle('tools:mssqlRestore', (e, sessionId: string, options: MssqlRestoreOptions) => {
    const session = getMssql(sessionId)
    return startJob(e.sender, (job) => mssqlRestore(job, session, options))
  })
  ipcMain.handle('tools:cancel', (_e, jobId: string) => {
    const job = jobs.get(jobId)
    if (!job) return
    job.cancelled = true
    for (const child of job.children) child.kill()
    for (const cancel of job.cancelers) cancel()
  })
}
