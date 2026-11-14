import { existsSync, readdirSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { t } from '@shared/i18n'
import type { DumpOptions, ImportOptions, SslMode, ToolInfo } from '@shared/types'
import { postgresDialect } from '@shared/sql/dialect'
import { expandHome, type DbSession } from '../db/session'
import { getSettings } from '../store'
import { checkCancelled, fileHead, fileName, importEach, importFiles, report, run, versionOutput, withSecretFile, type Job, type ToolSet } from './jobs'

// Data export/import of PostgreSQL through pg_dump and psql. The connection
// goes through libpq environment variables, the password through a
// temporary password file: no secret is on the command line.

const { quoteIdentifier: q } = postgresDialect

type ToolKind = 'dump' | 'client'
const toolNames: Record<ToolKind, string> = { dump: 'pg_dump', client: 'psql' }

/** Install locations with one directory per major version (Postgres.app, EDB installer, Homebrew). */
function versionedDirs(): string[] {
  const list = (dir: string, re: RegExp, sub: string): string[] => {
    try {
      return readdirSync(dir)
        .filter((n) => re.test(n))
        .map((n) => join(dir, n, sub))
    } catch {
      return []
    }
  }
  return [
    ...list('/Applications/Postgres.app/Contents/Versions', /^\d+$|^latest$/, 'bin'),
    ...list('/Library/PostgreSQL', /^\d+$/, 'bin'),
    ...list('/opt/homebrew/opt', /^postgresql@\d+$/, 'bin'),
    ...list('/usr/local/opt', /^postgresql@\d+$/, 'bin')
  ]
}

// An app started from the Finder gets a minimal PATH: look in the usual install locations too.
const toolDirs = ['/opt/homebrew/opt/libpq/bin', '/usr/local/opt/libpq/bin', '/opt/homebrew/bin', '/usr/local/bin']

/** Runs `<tool> --version`: "pg_dump (PostgreSQL) 17.2". */
async function probe(path: string): Promise<ToolInfo | undefined> {
  const stdout = await versionOutput(path, ['--version'])
  const version = stdout && /\(PostgreSQL\)\s+(\d+(?:\.\d+)*)/.exec(stdout)?.[1]
  return version ? { path, flavor: 'postgres', version } : undefined
}

const major = (version: string): number => parseInt(version, 10) || 0

/** The configured tool, otherwise the newest one found: pg_dump refuses servers newer than itself. */
async function findTool(kind: ToolKind): Promise<ToolInfo | undefined> {
  const override = getSettings()[kind === 'dump' ? 'pgDumpPath' : 'psqlPath']
  if (override) return probe(expandHome(override))
  const dirs = [...toolDirs, ...versionedDirs(), ...(process.env.PATH ?? '').split(':')].filter(Boolean)
  const paths = [...new Set(dirs.map((d) => join(d, toolNames[kind])))].filter((p) => existsSync(p))
  const found = (await Promise.all(paths.map(probe))).filter((t): t is ToolInfo => !!t)
  return found.sort((a, b) => major(b.version) - major(a.version))[0]
}

async function requireTool(kind: ToolKind, session: DbSession): Promise<ToolInfo> {
  const tool = await findTool(kind)
  if (!tool) {
    throw new Error(t('tools.postgres.notFound', { tool: toolNames[kind] }))
  }
  if (kind === 'dump' && major(tool.version) < major(session.info.version)) {
    throw new Error(t('tools.postgres.tooOld', { path: tool.path, version: tool.version, serverVersion: session.info.version }))
  }
  return tool
}

const sslModes: Record<SslMode, string> = {
  disabled: 'disable',
  preferred: 'prefer',
  required: 'require',
  verify_ca: 'verify-ca',
  verify_identity: 'verify-full'
}

/** A line of a password file: any host, port, database and user; ':' and '\' escaped. */
const passLine = (password: string): string => `*:*:*:*:${password.replace(/[\\:]/g, '\\$&')}\n`

/** libpq environment of the session: endpoint (tunnel or socket directory), user, database, SSL. */
function environment(session: DbSession, passFile: string, schema?: string): NodeJS.ProcessEnv {
  const { config, info } = session
  const ep = info.endpoint
  const ssl = config.ssl
  // the user's libpq variables must not override the session
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^PG/.test(k)))
  const env: NodeJS.ProcessEnv = {
    ...inherited,
    PGHOST: ep.socket || ep.host,
    PGPORT: String(ep.port || config.port || 5432),
    PGUSER: config.user,
    PGDATABASE: config.database || 'postgres',
    PGPASSFILE: passFile,
    PGSSLMODE: sslModes[ssl.mode],
    PGAPPNAME: 'DBKnife',
    PGCONNECT_TIMEOUT: String(config.options.connectTimeout || 10)
  }
  if (ssl.ca) env.PGSSLROOTCERT = expandHome(ssl.ca)
  if (ssl.cert) env.PGSSLCERT = expandHome(ssl.cert)
  if (ssl.key) env.PGSSLKEY = expandHome(ssl.key)
  // spaces and backslashes of an option value are escaped with a backslash
  if (schema) env.PGOPTIONS = `-c search_path=${q(schema).replace(/[\\ ]/g, '\\$&')}`
  return env
}

/** Gives `work` the libpq environment of the session, with a password file deleted afterwards. */
function withEnvironment<T>(session: DbSession, work: (env: NodeJS.ProcessEnv) => Promise<T>, schema?: string): Promise<T> {
  return withSecretFile('pgpass', passLine(session.password), (passFile) => work(environment(session, passFile, schema)))
}

async function listTables(session: DbSession, schema: string): Promise<string[]> {
  const r = await session.query(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f') ORDER BY 1`,
    [schema]
  )
  if (r.error) throw new Error(r.error.message)
  return r.rows.map((row) => String(row.name))
}

/**
 * The schema's relations that have a file of their own in an export: the
 * tables and views (as listTables) and the sequences tied to a column of one of
 * them (serial or OWNED BY: deptype 'a'; identity: 'i'), which pg_dump writes
 * with their table.
 */
async function relationsWithTable(session: DbSession, schema: string): Promise<string[]> {
  const r = await session.query(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND (c.relkind IN ('r', 'p', 'v', 'm', 'f') OR c.relkind = 'S' AND EXISTS (
       SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
         AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')))
     ORDER BY 1`,
    [schema]
  )
  if (r.error) throw new Error(r.error.message)
  return r.rows.map((row) => String(row.name))
}

/** A pg_dump pattern matching exactly this name: double quotes make every character literal. */
const pattern = (...names: string[]): string => names.map((n) => `"${n.replace(/"/g, '""')}"`).join('.')

/** pg_dump writes CREATE SCHEMA for -n: made idempotent, so a dump goes into a database that has the schema. */
const idempotentSchema = (line: string): string => line.replace(/^CREATE SCHEMA (?!IF NOT EXISTS )/, 'CREATE SCHEMA IF NOT EXISTS ')

const schemaHeader = (schema: string): string => `CREATE SCHEMA IF NOT EXISTS ${q(schema)};\n\n`

/**
 * Owners and privileges are left out: they name roles the target server may
 * not have, and psql stops at the first error.
 */
const baseArgs = ['--verbose', '--no-password', '--no-owner', '--no-privileges']

/** pg_dump --verbose lines worth logging; the progress comes from the "dumping contents" ones. */
const verboseNoise = (line: string): boolean => /^pg_dump: (?!error|warning|detail|hint|dumping contents)/i.test(line)

async function exportDump(job: Job, session: DbSession, o: DumpOptions): Promise<string> {
  const target = expandHome(o.target.path)
  if (!target) throw new Error(t('tools.dump.noTarget'))
  const tool = await requireTool('dump', session)
  report(job, { log: t('tools.job.using', { path: tool.path, flavor: 'PostgreSQL', version: tool.version }) })
  const schemas = await Promise.all(
    o.objects.map(async (s) => ({ ...s, all: !s.tables.length, tables: s.tables.length ? s.tables : await listTables(session, s.schema) }))
  )
  // "routines": the schema's other objects (functions, types, domains, standalone sequences...), dumped with -n
  // minus every relation that goes with a table (-T schema.* would drop the standalone sequences too)
  const withTable = new Map<string, string[]>()
  if (o.routines) for (const s of schemas) withTable.set(s.schema, await relationsWithTable(session, s.schema))
  const objectsArgs = (schema: string): string[] => ['-n', pattern(schema), ...(withTable.get(schema) ?? []).flatMap((r) => ['-T', pattern(schema, r)])]
  const tablesArgs = (schema: string, tables: string[]): string[] => tables.flatMap((t) => ['-t', pattern(schema, t)])
  let current = ''

  return withEnvironment(session, async (env) => {
    try {
      if (o.target.kind === 'file') {
        const units = schemas.reduce((n, s) => n + s.tables.length, 0)
        let done = 0
        const content = o.content === 'data' ? ['--data-only'] : o.content === 'structure' ? ['--schema-only'] : []
        const onLine = (line: string): boolean => {
          const table = /dumping contents of table "(.+)"$/.exec(line)?.[1]
          if (table) report(job, { progress: units ? done++ / units : 0, message: t('tools.dump.dumpingObject', { object: table }) })
          return !verboseNoise(line) && !table
        }
        const dump = (args: string[], schemaLines = false): Promise<void> =>
          run(job, tool, [...baseArgs, ...content, ...args], { env, output: target, onLine, mapLine: schemaLines ? idempotentSchema : undefined })
        await mkdir(dirname(target), { recursive: true })
        current = target
        await writeFile(target, o.createSchema ? schemas.map((s) => schemaHeader(s.schema)).join('') : '')
        report(job, { progress: 0, message: t('tools.dump.dumping'), log: t('tools.dump.dumping') })
        // whole schemas with their objects: one run keeps the dependencies between them in order
        if (o.routines && schemas.every((s) => s.all)) await dump(schemas.flatMap((s) => ['-n', pattern(s.schema)]), true)
        else {
          if (o.routines) for (const s of schemas) await dump(objectsArgs(s.schema), true)
          await dump(schemas.flatMap((s) => tablesArgs(s.schema, s.tables)))
        }
        current = ''
        return t('tools.dump.doneFile', { target, count: units })
      }

      // a project folder: per table its definition and data, and apart its indexes, constraints and triggers,
      // imported after every table (foreign keys need the tables they reference)
      const sections: Record<DumpOptions['content'], { main: string[]; post: string[] }> = {
        both: { main: ['--section=pre-data', '--section=data'], post: ['--section=post-data'] },
        data: { main: ['--section=data'], post: [] },
        structure: { main: ['--section=pre-data'], post: ['--section=post-data'] }
      }
      const { main, post } = sections[o.content]
      const units = schemas.reduce((n, s) => n + s.tables.length + (o.routines ? 1 : 0), 0)
      let done = 0
      const step = (message: string): void => report(job, { progress: units ? done / units : 0, message, log: message })
      const quiet = (line: string): boolean => !verboseNoise(line) && !/dumping contents/.test(line)
      const dumpTo = async (file: string, header: string, args: string[], schemaLines = false): Promise<void> => {
        current = file
        await writeFile(file, header)
        await run(job, tool, [...baseArgs, ...args], { env, output: file, onLine: quiet, mapLine: schemaLines ? idempotentSchema : undefined })
        current = ''
      }
      await mkdir(target, { recursive: true })
      for (const s of schemas) {
        const header = o.createSchema ? schemaHeader(s.schema) : ''
        if (o.routines) {
          step(t('tools.dump.dumpingObjects', { schema: s.schema }))
          await dumpTo(join(target, fileName(s.schema, 'schema')), header, [...main, ...objectsArgs(s.schema)], true)
          done++
        }
        for (const table of s.tables) {
          checkCancelled(job)
          step(t('tools.dump.dumpingObject', { object: `${s.schema}.${table}` }))
          const base = fileName(s.schema, table)
          await dumpTo(join(target, base), header, [...main, '-t', pattern(s.schema, table)])
          if (post.length) await dumpTo(join(target, base.replace(/\.sql$/, '.post-data.sql')), '', [...post, '-t', pattern(s.schema, table)])
          done++
        }
      }
      return t('tools.dump.doneUnits', { target, count: units })
    } catch (err) {
      if (current) {
        await rm(current, { force: true })
        report(job, { log: t('tools.dump.removedIncomplete', { file: current }) })
      }
      throw err
    }
  })
}

/**
 * Import order of a dump project folder's files: the schema objects, the
 * tables, the views (which need the tables), then indexes, constraints and
 * triggers.
 */
async function importRank(file: string): Promise<number> {
  if (/_schema\.sql$/i.test(file)) return 0
  if (/\.post-data\.sql$/i.test(file)) return 3
  return /; Type: (MATERIALIZED )?VIEW;/.test(await fileHead(file)) ? 2 : 1
}

async function importDump(job: Job, session: DbSession, o: ImportOptions): Promise<string> {
  if (!o.source.path) throw new Error(t('tools.import.noSource'))
  const tool = await requireTool('client', session)
  report(job, { log: t('tools.job.using', { path: tool.path, flavor: 'PostgreSQL', version: tool.version }) })
  const files = await importFiles(o, importRank)
  if (!files.length) throw new Error(t('tools.import.noSqlFiles', { path: o.source.path }))
  // -X: no ~/.psqlrc; the script comes from stdin and psql stops at its first error
  const args = ['-X', '-q', '-w', '-v', 'ON_ERROR_STOP=1', '-f', '-']
  await withEnvironment(session, (env) => importEach(job, files, (input) => run(job, tool, args, { input, env })), o.defaultSchema || undefined)
  return t('tools.import.done', { source: o.source.path })
}

export const postgresTools: ToolSet = {
  find: async () => {
    const [dump, client] = await Promise.all([findTool('dump'), findTool('client')])
    return { dump, client }
  },
  exportDump,
  importDump
}
