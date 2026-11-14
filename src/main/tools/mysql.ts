import { existsSync } from 'node:fs'
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { t } from '@shared/i18n'
import type { ConnectionConfig, DumpOptions, ImportOptions, ToolInfo } from '@shared/types'
import { quoteIdentifier } from '@shared/sql/quote'
import { expandHome, type DbSession } from '../db/session'
import { getSettings } from '../store'
import { checkCancelled, fileHead, fileName, importEach, importFiles, report, run, versionOutput, withSecretFile, type Job, type RunIo, type runPiped, type ToolSet } from './jobs'

// Data export/import of MySQL and MariaDB through the mysqldump / mysql client binaries.

type ToolKind = 'dump' | 'client'

const toolNames: Record<ToolKind, string[]> = { dump: ['mariadb-dump', 'mysqldump'], client: ['mariadb', 'mysql'] }

// An app started from the Finder gets a minimal PATH: look in the usual install locations too.
const toolDirs = [
  '/opt/homebrew/opt/mysql-client/bin',
  '/usr/local/opt/mysql-client/bin',
  '/usr/local/mysql/bin',
  '/opt/homebrew/opt/mariadb/bin',
  '/usr/local/opt/mariadb/bin',
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/Applications/MySQLWorkbench.app/Contents/MacOS'
]

/** Runs `<tool> --version` (ignoring the user's option files, which may hold options the tool rejects). */
async function probe(path: string): Promise<ToolInfo | undefined> {
  const stdout = await versionOutput(path, ['--no-defaults', '--version'])
  if (stdout === undefined) return undefined
  const mariadb = /(\d+\.\d+\.\d+)-MariaDB/i.exec(stdout)
  const version = mariadb?.[1] ?? /Ver\s+(\d+\.\d+\.\d+)/.exec(stdout)?.[1] ?? ''
  return { path, flavor: mariadb ? 'mariadb' : 'mysql', version }
}

/** The configured tool, otherwise the first one found of the server's flavor (or any flavor). */
async function findTool(kind: ToolKind, session: DbSession): Promise<ToolInfo | undefined> {
  const override = getSettings()[kind === 'dump' ? 'mysqldumpPath' : 'mysqlPath']
  if (override) return probe(expandHome(override))
  const dirs = [...toolDirs, ...(process.env.PATH ?? '').split(':')].filter(Boolean)
  const paths = [...new Set(dirs.flatMap((d) => toolNames[kind].map((n) => join(d, n))))].filter((p) => existsSync(p))
  const found = (await Promise.all(paths.map(probe))).filter((t): t is ToolInfo => !!t)
  const flavor = session.info.isMariaDB ? 'mariadb' : 'mysql'
  return found.find((t) => t.flavor === flavor) ?? found[0]
}

export async function requireTool(kind: ToolKind, session: DbSession): Promise<ToolInfo> {
  const tool = await findTool(kind, session)
  if (!tool) {
    const name = kind === 'dump' ? 'mysqldump' : 'mysql'
    throw new Error(t('tools.mysql.notFound', { tool: name }))
  }
  return tool
}

const major = (version: string): number => parseInt(version, 10) || 0

const optionValue = (v: string): string =>
  '"' + v.replace(/[\\"\n\r\t]/g, (c) => ({ '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t' })[c]!) + '"'

/** SSL options, which differ between MySQL (--ssl-mode) and MariaDB (--ssl, --skip-ssl) clients. */
function sslOptions(ssl: ConnectionConfig['ssl'], tool: ToolInfo): string[] {
  if (ssl.mode === 'disabled') return [tool.flavor === 'mysql' ? 'ssl-mode=DISABLED' : 'skip-ssl']
  const lines =
    tool.flavor === 'mysql'
      ? [`ssl-mode=${ssl.mode.toUpperCase()}`]
      : ssl.mode === 'preferred'
        ? ['ssl-verify-server-cert=0']
        : ['ssl', `ssl-verify-server-cert=${ssl.mode === 'required' ? 0 : 1}`]
  const files = { 'ssl-ca': ssl.ca, 'ssl-cert': ssl.cert, 'ssl-key': ssl.key }
  for (const [k, v] of Object.entries(files)) if (v) lines.push(`${k}=${optionValue(expandHome(v))}`)
  if (ssl.cipher) lines.push(`ssl-cipher=${optionValue(ssl.cipher)}`)
  return lines
}

/** Option file with the session's credentials and endpoint (tunnel or socket), so no secret is on the command line. */
function optionFile(session: DbSession, tool: ToolInfo): string {
  const { config, info } = session
  const ep = info.endpoint
  const lines = ['[client]', `user=${optionValue(config.user)}`, `password=${optionValue(session.password)}`, 'default-character-set=utf8mb4']
  if (ep.socket) lines.push(`socket=${optionValue(ep.socket)}`, 'protocol=SOCKET')
  else lines.push(`host=${optionValue(ep.host)}`, `port=${ep.port}`, 'protocol=TCP')
  if (config.options.compress) lines.push('compress')
  lines.push(...sslOptions(config.ssl, tool))
  return lines.join('\n') + '\n'
}

/** Gives `run` an option file for the tool, deleted afterwards. */
export function withOptionFile<T>(session: DbSession, tool: ToolInfo, run: (file: string) => Promise<T>): Promise<T> {
  return withSecretFile('client.cnf', optionFile(session, tool), run)
}

type Invocation = Parameters<typeof runPiped>[1]

/** The tool's arguments with the option file, which must come first, hidden in the log. */
export const withDefaults = (tool: ToolInfo, cnf: string, args: string[], io: RunIo = {}): Invocation => ({
  tool,
  args: [`--defaults-file=${cnf}`, ...args],
  io: { ...io, shownArgs: `--defaults-file=… ${args.join(' ')}` }
})

/** Runs the tool with the option file. */
export function runWith(job: Job, tool: ToolInfo, cnf: string, args: string[], io: RunIo): Promise<void> {
  const call = withDefaults(tool, cnf, args, io)
  return run(job, call.tool, call.args, call.io)
}

async function listTables(session: DbSession, schema: string): Promise<string[]> {
  const r = await session.query('SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME', [schema])
  if (r.error) throw new Error(r.error.message)
  return r.rows.map((row) => String(row.name))
}

/** CREATE DATABASE IF NOT EXISTS and USE statements, written before the schema's objects. */
async function schemaHeader(session: DbSession, schema: string): Promise<string> {
  const r = await session.query(`SHOW CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(schema)}`)
  if (r.error) throw new Error(r.error.message)
  return `${String(r.rows[0]['Create Database'])};\n\nUSE ${quoteIdentifier(schema)};\n\n`
}

export function dumpArgs(tool: ToolInfo, session: DbSession, o: Pick<DumpOptions, 'content' | 'triggers' | 'singleTransaction'>): string[] {
  // tablespaces need the PROCESS privilege since MySQL 8.0.21 and are rarely wanted in a logical dump
  const args = ['--verbose', '--no-tablespaces', o.triggers ? '--triggers' : '--skip-triggers']
  if (o.content === 'data') args.push('--no-create-info')
  if (o.content === 'structure') args.push('--no-data')
  if (o.singleTransaction) args.push('--single-transaction')
  if (tool.flavor === 'mysql') {
    // GTID_PURGED breaks imports into other servers and its detection fails on MariaDB
    args.push('--set-gtid-purged=OFF')
    // MySQL 8+ mysqldump reads histograms from information_schema.COLUMN_STATISTICS by default
    if (major(tool.version) >= 8 && (session.info.isMariaDB || major(session.info.version) < 8)) args.push('--column-statistics=0')
  }
  return args
}

async function exportDump(job: Job, session: DbSession, o: DumpOptions): Promise<string> {
  const target = expandHome(o.target.path)
  if (!target) throw new Error(t('tools.dump.noTarget'))
  const tool = await requireTool('dump', session)
  report(job, { log: t('tools.job.using', { path: tool.path, flavor: tool.flavor, version: tool.version }) })
  const base = dumpArgs(tool, session, o)
  const schemas = await Promise.all(
    o.objects.map(async (s) => ({ ...s, all: !s.tables.length, tables: s.tables.length ? s.tables : await listTables(session, s.schema) }))
  )
  const withRoutines = o.routines || o.events
  const units = schemas.reduce((n, s) => n + s.tables.length + (o.target.kind === 'folder' && withRoutines ? 1 : 0), 0)
  let done = 0
  // the file being written, removed if the export does not complete
  let current = ''
  const step = (message: string): void => report(job, { progress: units ? done / units : 0, message, log: message })

  return withOptionFile(session, tool, async (cnf) => {
    try {
      if (o.target.kind === 'file') {
        await mkdir(dirname(target), { recursive: true })
        current = target
        await writeFile(target, '')
        for (const s of schemas) {
          checkCancelled(job)
          if (o.createSchema) await appendFile(target, await schemaHeader(session, s.schema))
          const args = [...base, ...(o.routines ? ['--routines'] : []), ...(o.events ? ['--events'] : [])]
          step(t('tools.dump.dumpingObject', { object: s.schema }))
          // mysqldump --verbose announces each table on stderr: that gives the progress
          const onLine = (line: string): boolean => {
            const table = /^-- Retrieving table structure for table (.+)\.\.\.$/.exec(line)?.[1]
            if (table) {
              report(job, { progress: units ? done++ / units : 0, message: t('tools.dump.dumpingObject', { object: `${s.schema}.${table}` }) })
            }
            return !line.startsWith('-- ')
          }
          await runWith(job, tool, cnf, [...args, '--', s.schema, ...(s.all ? [] : s.tables)], { output: target, onLine })
        }
        current = ''
        return t('tools.dump.doneFile', { target, count: units })
      }

      await mkdir(target, { recursive: true })
      const quiet = (line: string): boolean => !line.startsWith('-- ')
      for (const s of schemas) {
        const header = o.createSchema ? await schemaHeader(session, s.schema) : ''
        for (const table of s.tables) {
          step(t('tools.dump.dumpingObject', { object: `${s.schema}.${table}` }))
          current = join(target, fileName(s.schema, table))
          await writeFile(current, header)
          await runWith(job, tool, cnf, [...base, '--', s.schema, table], { output: current, onLine: quiet })
          done++
        }
        if (withRoutines) {
          step(t('tools.dump.dumpingRoutines', { schema: s.schema }))
          current = join(target, fileName(s.schema, 'routines'))
          await writeFile(current, header)
          const args = [...base, '--no-create-info', '--no-data', '--skip-triggers', ...(o.routines ? ['--routines'] : []), ...(o.events ? ['--events'] : [])]
          await runWith(job, tool, cnf, [...args, '--', s.schema], { output: current, onLine: quiet })
          done++
        }
      }
      current = ''
      return t('tools.dump.doneFiles', { target, count: units })
    } catch (err) {
      if (current) {
        await rm(current, { force: true })
        report(job, { log: t('tools.dump.removedIncomplete', { file: current }) })
      }
      throw err
    }
  })
}

/** Import order of a dump project folder's files: tables, then routines and events, then the views that may call them. */
const importRank = async (file: string): Promise<number> =>
  /_routines\.sql$/i.test(file) ? 1 : /structure for view/i.test(await fileHead(file)) ? 2 : 0

async function importDump(job: Job, session: DbSession, o: ImportOptions): Promise<string> {
  if (!o.source.path) throw new Error(t('tools.import.noSource'))
  const tool = await requireTool('client', session)
  report(job, { log: t('tools.job.using', { path: tool.path, flavor: tool.flavor, version: tool.version }) })
  const files = await importFiles(o, importRank)
  if (!files.length) throw new Error(t('tools.import.noSqlFiles', { path: o.source.path }))
  const args = o.defaultSchema ? [`--database=${o.defaultSchema}`] : []
  await withOptionFile(session, tool, (cnf) => importEach(job, files, (input) => runWith(job, tool, cnf, args, { input })))
  return t('tools.import.done', { source: o.source.path })
}

export const mysqlTools: ToolSet = {
  find: async (session) => {
    const [dump, client] = await Promise.all([findTool('dump', session), findTool('client', session)])
    return { dump, client }
  },
  exportDump,
  importDump
}
