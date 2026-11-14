import { existsSync } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { t } from '@shared/i18n'
import type { DumpOptions, ImportOptions, SslMode, ToolInfo } from '@shared/types'
import { expandHome, type DbSession } from '../db/session'
import { report, run, versionOutput, withSecretFile, type Job, type ToolSet } from './jobs'

// Data export/import of SQL Server through sqlpackage: the session's whole
// database to a .bacpac file, and a .bacpac file into a new database. The
// password goes through a temporary response file (@file): no secret is on
// the command line.

// An app started from the Finder gets a minimal PATH: look in the usual install locations too
// (`dotnet tool install -g microsoft.sqlpackage`, the zip of the download page, Homebrew).
const toolDirs = [join(homedir(), '.dotnet/tools'), join(homedir(), 'sqlpackage'), '/usr/local/bin', '/opt/homebrew/bin', '/usr/local/sqlpackage']

/** Runs `sqlpackage /version`: "170.4.83.3". The x64 build starts through Rosetta, slowly the first time. */
async function probe(path: string): Promise<ToolInfo | undefined> {
  const stdout = await versionOutput(path, ['/version'], 30000)
  const version = stdout && /^\s*(\d+(?:\.\d+)+)/.exec(stdout)?.[1]
  return version ? { path, flavor: 'mssql', version } : undefined
}

async function findTool(): Promise<ToolInfo | undefined> {
  const dirs = [...(process.env.PATH ?? '').split(':'), ...toolDirs].filter(Boolean)
  for (const path of new Set(dirs.map((d) => join(d, 'sqlpackage')))) {
    const tool = existsSync(path) ? await probe(path) : undefined
    if (tool) return tool
  }
  return undefined
}

async function requireTool(): Promise<ToolInfo> {
  const tool = await findTool()
  if (!tool) throw new Error(t('tools.mssql.notFound'))
  return tool
}

type Side = 'Source' | 'Target'

const encryption: Record<SslMode, { encrypt: boolean; trust: boolean }> = {
  disabled: { encrypt: false, trust: true },
  preferred: { encrypt: true, trust: true },
  required: { encrypt: true, trust: true },
  verify_ca: { encrypt: true, trust: false },
  verify_identity: { encrypt: true, trust: false }
}

/** sqlpackage arguments naming the session's server (its tunnel endpoint, if any), login and encryption. */
function connectionArgs(session: DbSession, side: Side, database: string): string[] {
  const { config, info } = session
  const ep = info.endpoint
  // SQL Server logins only: on macOS sqlpackage has no NTLM with a user name and password
  if (config.user.includes('\\')) throw new Error(t('tools.mssql.sqlLoginOnly'))
  // host\instance finds the instance's port through SQL Browser, as the driver does
  const server = ep.host.includes('\\') ? ep.host : `${ep.host},${ep.port || config.port || 1433}`
  const { encrypt, trust } = encryption[config.ssl.mode]
  const args = [
    `/${side}ServerName:${server}`,
    `/${side}DatabaseName:${database}`,
    `/${side}User:${config.user}`,
    `/${side}EncryptConnection:${encrypt ? 'True' : 'False'}`,
    `/${side}TrustServerCertificate:${trust ? 'True' : 'False'}`,
    `/${side}Timeout:${config.options.connectTimeout || 10}`
  ]
  // through an SSH tunnel the certificate names the server, not 127.0.0.1
  if (encrypt && !trust && ep.host !== config.host) args.push(`/${side}HostNameInCertificate:${config.host.split('\\')[0]}`)
  return args
}

/**
 * Gives `work` the response file argument holding the password, deleted
 * afterwards. In a response file `"` only opens and closes a quoted part and
 * cannot be escaped (backslashes are literal), so a password containing it
 * cannot be passed.
 */
async function withPassword<T>(session: DbSession, side: Side, work: (arg: string) => Promise<T>): Promise<T> {
  const password = session.password
  if (/["\r\n]/.test(password)) throw new Error(t('tools.mssql.passwordCharacters'))
  return withSecretFile('sqlpackage.rsp', `"/${side}Password:${password}"\n`, (file) => work(`@${file}`))
}

/** sqlpackage logs "Processing Table '[dbo].[orders]'." for every table it exports or imports. */
const tableLine = /^Processing Table '(.+)'\.$/

async function scalar(session: DbSession, sql: string, params?: unknown[]): Promise<unknown> {
  const r = await session.query(sql, params)
  if (r.error) throw new Error(r.error.message)
  return Object.values(r.rows[0] ?? {})[0]
}

async function exportDump(job: Job, session: DbSession, o: DumpOptions): Promise<string> {
  const target = expandHome(o.target.path)
  if (!target) throw new Error(t('tools.dump.noTarget'))
  const tool = await requireTool()
  report(job, { log: t('tools.job.using', { path: tool.path, flavor: 'sqlpackage', version: tool.version }) })
  // the database the session is on (USE moves it)
  const database = String(await scalar(session, 'SELECT DB_NAME()'))
  const tables = Number(await scalar(session, 'SELECT COUNT(*) FROM sys.tables WHERE is_ms_shipped = 0'))
  let done = 0
  const onOutput = (line: string): boolean => {
    const table = tableLine.exec(line.trim())?.[1]
    if (table) report(job, { progress: tables ? done++ / tables : 0, message: t('tools.dump.dumpingObject', { object: table }) })
    else if (line.trim()) report(job, { message: line.trim() })
    return true
  }
  await mkdir(dirname(target), { recursive: true })
  // a failed export removes the file only if it wrote it: an older .bacpac left untouched stays
  const before = await stat(target).catch(() => undefined)
  report(job, { progress: 0, message: t('tools.dump.dumping') })
  try {
    await withPassword(session, 'Source', (password) =>
      run(job, tool, ['/Action:Export', ...connectionArgs(session, 'Source', database), password, `/TargetFile:${target}`, '/OverwriteFiles:True'], { onOutput })
    )
  } catch (err) {
    const after = await stat(target).catch(() => undefined)
    if (after && (!before || after.mtimeMs !== before.mtimeMs || after.size !== before.size)) {
      await rm(target, { force: true })
      report(job, { log: t('tools.dump.removedIncomplete', { file: target }) })
    }
    throw err
  }
  return t('tools.dump.doneFile', { target, count: tables })
}

async function importDump(job: Job, session: DbSession, o: ImportOptions): Promise<string> {
  const source = expandHome(o.source.path)
  if (!source) throw new Error(t('tools.import.noSource'))
  const database = o.database?.trim() ?? ''
  if (!database) throw new Error(t('tools.mssql.noDatabase'))
  const tool = await requireTool()
  report(job, { log: t('tools.job.using', { path: tool.path, flavor: 'sqlpackage', version: tool.version }) })
  // sqlpackage refuses a database that has objects only after building its plan: say it at once
  const exists = async (): Promise<boolean> => (await scalar(session, 'SELECT DB_ID(@p1)', [database])) !== null
  if (await exists()) throw new Error(t('tools.mssql.databaseExists', { database }))
  // the tables of a .bacpac are not known before it is read: the progress stays indeterminate
  const onOutput = (line: string): boolean => {
    const table = tableLine.exec(line.trim())?.[1]
    if (line.trim()) report(job, { progress: -1, message: table ? t('tools.import.importing', { file: table }) : line.trim() })
    return true
  }
  report(job, { progress: -1, message: t('tools.import.importing', { file: source }) })
  try {
    await withPassword(session, 'Target', (password) =>
      run(job, tool, ['/Action:Import', ...connectionArgs(session, 'Target', database), password, `/SourceFile:${source}`], { onOutput })
    )
  } catch (err) {
    // left to the user to drop: it is a new database, but a failed import is worth a look
    if (await exists().catch(() => false)) report(job, { log: t('tools.mssql.importIncomplete', { database }) })
    throw err
  }
  return t('tools.mssql.importDone', { source: o.source.path, database })
}

export const mssqlTools: ToolSet = {
  find: async () => {
    const tool = await findTool()
    return { dump: tool, client: tool }
  },
  exportDump,
  importDump
}
