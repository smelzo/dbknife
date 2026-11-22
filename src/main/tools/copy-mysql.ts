import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { t } from '@shared/i18n'
import { buildCopyPlan, tableTypeKinds, type CopyKind, type PlanInput, type PlanStep, type PlanWarning, type SourceObject } from '@shared/sql/copy-plan'
import { quoteIdentifier } from '@shared/sql/quote'
import type { CopyOptions, CopyPreview, CopySchemaRef, Row } from '@shared/types'
import { forkSession } from '../db/create-session'
import { expandHome, type DbSession } from '../db/session'
import { checkCancelled, report, runPiped, type Job } from './jobs'
import { dumpArgs, requireTool, runWith, withDefaults, withOptionFile } from './mysql'

// Copy Database (MySQL/MariaDB): reads the source objects on a session of its
// own, rebuilds them on the target in the order of copy-plan.ts and copies the
// data in between, piping mysqldump into the target's mysql client (or
// appending its output to a script file).

/** Column of the SHOW CREATE … result holding the definition (MariaDB's SHOW CREATE SEQUENCE uses Create Table). */
const definitionColumns: Record<CopyKind, string> = {
  table: 'Create Table',
  sequence: 'Create Table',
  view: 'Create View',
  procedure: 'Create Procedure',
  function: 'Create Function',
  trigger: 'SQL Original Statement',
  event: 'Create Event'
}

/** Collations the chosen schemas use, in their objects and in the session settings stored with them. */
const usedCollationsSql = `SELECT DEFAULT_COLLATION_NAME AS c FROM information_schema.SCHEMATA WHERE SCHEMA_NAME IN (?)
UNION SELECT TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA IN (?) AND TABLE_COLLATION IS NOT NULL
UNION SELECT COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA IN (?) AND COLLATION_NAME IS NOT NULL
UNION SELECT DATABASE_COLLATION FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA IN (?)
UNION SELECT COLLATION_CONNECTION FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA IN (?)
UNION SELECT COLLATION_CONNECTION FROM information_schema.VIEWS WHERE TABLE_SCHEMA IN (?)
UNION SELECT DATABASE_COLLATION FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA IN (?)
UNION SELECT COLLATION_CONNECTION FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA IN (?)
UNION SELECT DATABASE_COLLATION FROM information_schema.EVENTS WHERE EVENT_SCHEMA IN (?)
UNION SELECT COLLATION_CONNECTION FROM information_schema.EVENTS WHERE EVENT_SCHEMA IN (?)`

export async function select(session: DbSession, sql: string, params?: unknown[]): Promise<Row[]> {
  const r = await session.query(sql, params)
  if (r.error) throw new Error(r.error.message)
  return r.rows
}

const text = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v))

/**
 * The server's collations. COLLATIONS lists MariaDB 10.10+'s UCA 14 collations without their
 * character set (`uca1400_ai_ci`), so they are read with their full names from the applicability table.
 */
export async function collations(session: DbSession): Promise<CopyPreview['available']> {
  const rows = await select(
    session,
    'SELECT a.*, cs.DEFAULT_COLLATE_NAME AS default_collation FROM information_schema.COLLATION_CHARACTER_SET_APPLICABILITY a JOIN information_schema.CHARACTER_SETS cs USING (CHARACTER_SET_NAME)'
  )
  return rows.map((r) => {
    const name = String(r.FULL_COLLATION_NAME ?? r.COLLATION_NAME)
    return { name, charset: String(r.CHARACTER_SET_NAME), isDefault: name === r.default_collation }
  })
}

export async function copyPreview(source: DbSession, schemas: CopySchemaRef[], target?: DbSession): Promise<CopyPreview> {
  const names = schemas.map((s) => s.source)
  const targets = schemas.map((s) => s.target)
  const charsets = new Map((await collations(source)).map((c) => [c.name.toLowerCase(), c.charset]))
  const used = names.length ? await select(source, usedCollationsSql, usedCollationsSql.match(/\?/g)!.map(() => names)) : []
  return {
    used: used
      .map((r) => String(r.c))
      .sort()
      .map((name) => ({ name, charset: charsets.get(name.toLowerCase()) ?? '' })),
    available: target ? await collations(target) : [],
    existing:
      target && targets.length
        ? (await select(target, 'SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME IN (?)', [targets])).map((r) => String(r.name))
        : []
  }
}

const lowerKeys = (map: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]))

/** Target names given, distinct, and not the source itself on the same instance. */
function checkNames(o: CopyOptions): void {
  if (!o.schemas.length) throw new Error(t('tools.copy.noSchemas'))
  const seen = new Set<string>()
  for (const s of o.schemas) {
    // schema names are case-insensitive on macOS and Windows servers
    const name = s.target.toLowerCase()
    if (!name) throw new Error(t('tools.copy.noTargetName', { schema: s.source }))
    if (seen.has(name)) throw new Error(t('tools.copy.duplicateTarget', { schema: s.target }))
    if (o.target.kind === 'instance' && name === s.source.toLowerCase()) throw new Error(t('tools.copy.sameSchema', { schema: s.source }))
    seen.add(name)
  }
}

/** The target server has every collation used (or the one it is mapped to), and no target schema exists unless recreating. */
async function checkTarget(reader: DbSession, writer: DbSession, o: CopyOptions): Promise<void> {
  const preview = await copyPreview(reader, o.schemas, writer)
  const available = new Set(preview.available.map((c) => c.name.toLowerCase()))
  const mapped = lowerKeys(o.collations)
  const missing = preview.used.map((c) => c.name).filter((c) => !available.has((mapped[c.toLowerCase()] || c).toLowerCase()))
  if (missing.length) throw new Error(t('tools.copy.missingCollations', { collations: missing.join(', ') }))
  if (o.existing === 'stop' && preview.existing.length) throw new Error(t('tools.copy.targetExists', { schemas: preview.existing.join(', ') }))
}

export async function readObject(session: DbSession, schema: string, kind: CopyKind, name: string): Promise<SourceObject> {
  const [row] = await select(session, `SHOW CREATE ${kind.toUpperCase()} ${quoteIdentifier(name)}`)
  // NULL when the user may not see the body (not the definer and no SHOW_ROUTINE / SELECT privilege)
  const ddl = text(row?.[definitionColumns[kind]])
  if (ddl === undefined) throw new Error(t('tools.copy.noDefinition', { object: `${schema}.${name}` }))
  return {
    kind,
    schema,
    name,
    ddl,
    sqlMode: text(row.sql_mode),
    timeZone: text(row.time_zone),
    collationConnection: text(row.collation_connection),
    databaseCollation: text(row['Database Collation'])
  }
}

/** The schema's definition and objects, read with the schema as the default database. */
async function readSchema(job: Job, session: DbSession, schema: string, o: CopyOptions): Promise<{ schema: PlanInput['schemas'][number]; objects: SourceObject[] }> {
  // SHOW CREATE VIEW leaves unqualified the tables of the default database (as mysqldump reads it)
  await select(session, `USE ${quoteIdentifier(schema)}`)
  const [db] = await select(session, `SHOW CREATE DATABASE ${quoteIdentifier(schema)}`)
  const [info] = await select(session, 'SELECT DEFAULT_COLLATION_NAME AS c FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [schema])
  const list: { kind: CopyKind; name: string }[] = []
  const tables = await select(session, 'SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME', [schema])
  for (const r of tables) {
    const kind = tableTypeKinds[String(r.type)]
    if (kind) list.push({ kind, name: String(r.name) })
  }
  if (o.routines) {
    const routines = await select(session, 'SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME', [schema])
    for (const r of routines) {
      // MariaDB's PACKAGE and PACKAGE BODY (Oracle mode) are left out
      if (r.type === 'PROCEDURE' || r.type === 'FUNCTION') list.push({ kind: r.type === 'PROCEDURE' ? 'procedure' : 'function', name: String(r.name) })
      else report(job, { log: t('tools.copy.skippedObject', { object: `${schema}.${String(r.name)}`, type: String(r.type) }) })
    }
  }
  if (o.triggers) {
    const triggers = await select(session, 'SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY EVENT_OBJECT_TABLE, ACTION_ORDER', [schema])
    for (const r of triggers) list.push({ kind: 'trigger', name: String(r.name) })
  }
  if (o.events) {
    const events = await select(session, 'SELECT EVENT_NAME AS name FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME', [schema])
    for (const r of events) list.push({ kind: 'event', name: String(r.name) })
  }
  const objects: SourceObject[] = []
  for (const x of list) {
    checkCancelled(job)
    objects.push(await readObject(session, schema, x.kind, x.name))
  }
  return { schema: { name: schema, ddl: String(db['Create Database']), collation: String(info.c) }, objects }
}

/** Relations already in the target schemas, `schema.name` → kind, so recreating drops them with the right statement. */
export async function targetKinds(session: DbSession, schemas: string[]): Promise<Record<string, CopyKind>> {
  const rows = await select(session, 'SELECT TABLE_SCHEMA AS s, TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA IN (?)', [schemas])
  const kinds: Record<string, CopyKind> = {}
  for (const r of rows) {
    const kind = tableTypeKinds[String(r.type)]
    if (kind) kinds[`${String(r.s)}.${String(r.name)}`] = kind
  }
  return kinds
}

export function warningText(w: PlanWarning): string {
  switch (w.code) {
    case 'qualifiedReference':
      return t('tools.copy.warning.qualifiedReference', { object: w.object })
    case 'externalSchema':
      return t('tools.copy.warning.externalSchema', { object: w.object, schema: w.schema })
    case 'viewCycle':
      return t('tools.copy.warning.viewCycle', { objects: w.objects.join(', ') })
  }
}

/** Plan steps as script text; compound bodies hold `;`, so they go between DELIMITER ;; and DELIMITER ;. */
export const script = (steps: PlanStep[]): string =>
  steps.map((s) => (s.compound ? `DELIMITER ;;\n${s.sql} ;;\nDELIMITER ;\n\n` : `${s.sql};\n\n`)).join('')

export async function copyDatabase(job: Job, source: DbSession, o: CopyOptions, target?: DbSession): Promise<string> {
  const path = o.target.kind === 'file' ? expandHome(o.target.path) : ''
  if (o.target.kind === 'file' && !path) throw new Error(t('tools.dump.noTarget'))
  checkNames(o)
  const withData = o.content === 'both'
  const dump = withData ? await requireTool('dump', source) : undefined
  if (dump) report(job, { log: t('tools.job.using', { path: dump.path, flavor: dump.flavor, version: dump.version }) })

  // sessions of the job's own: USE changes the default database, which the tab's sessions keep
  const reader = await forkSession(source)
  let writer: DbSession | undefined
  try {
    if (o.target.kind === 'instance') writer = reader
    else if (o.target.kind === 'connection') writer = await forkSession(target!)
    if (writer) await checkTarget(reader, writer, o)

    const schemas: PlanInput['schemas'] = []
    const objects: SourceObject[] = []
    for (const s of o.schemas) {
      checkCancelled(job)
      const message = t('tools.copy.reading', { schema: s.source })
      report(job, { progress: -1, message, log: message })
      const read = await readSchema(job, reader, s.source, o)
      schemas.push(read.schema)
      objects.push(...read.objects)
    }

    const rename = Object.fromEntries(o.schemas.map((s) => [s.source, s.target]))
    const plan = buildCopyPlan({
      schemas,
      objects,
      rename,
      definers: o.definers,
      existing: o.existing,
      structureOnly: !withData,
      collations: lowerKeys(o.collations),
      targetKinds: writer && o.existing === 'recreate' ? await targetKinds(writer, o.schemas.map((s) => s.target)) : undefined
    })
    if (o.schemas.some((s) => s.source !== s.target)) report(job, { log: t('tools.copy.renameNote') })
    for (const w of plan.warnings) report(job, { log: warningText(w) })

    // progress: plan steps, then the tables and views mysqldump announces
    const announced = withData ? objects.filter((x) => x.kind === 'table' || x.kind === 'view').length : 0
    const units = plan.structure.length + plan.finish.length + announced
    let done = 0
    const progress = (message?: string): void => report(job, { progress: units ? Math.min(done / units, 1) : 0, message })
    // mysqldump --verbose announces each table on stderr
    const onLine =
      (schema: string) =>
      (line: string): boolean => {
        const table = /^-- Retrieving table structure for table (.+)\.\.\.$/.exec(line)?.[1]
        if (table) {
          progress(t('tools.copy.copyingData', { object: `${schema}.${table}` }))
          done++
        }
        return !line.startsWith('-- ')
      }
    const args = dump ? [...dumpArgs(dump, reader, { content: 'data', triggers: false, singleTransaction: true }), '--'] : []

    if (writer) {
      const execute = async (steps: PlanStep[]): Promise<void> => {
        for (const step of steps) {
          checkCancelled(job)
          if (step.object) progress(t('tools.copy.creating', { object: step.object }))
          const r = await writer!.query(step.sql)
          if (r.error) throw new Error(t('tools.copy.stepFailed', { object: step.object || step.sql, error: r.error.message }))
          done++
        }
      }
      try {
        await execute(plan.structure)
        if (dump) {
          const client = await requireTool('client', writer)
          report(job, { log: t('tools.job.using', { path: client.path, flavor: client.flavor, version: client.version }) })
          await withOptionFile(reader, dump, (from) =>
            withOptionFile(writer!, client, async (to) => {
              for (const s of o.schemas) {
                const message = t('tools.copy.copyingData', { object: s.source })
                report(job, { message, log: message })
                await runPiped(job, withDefaults(dump, from, [...args, s.source], { onLine: onLine(s.source) }), withDefaults(client, to, [`--database=${s.target}`]))
              }
            })
          )
        }
        await execute(plan.finish)
      } catch (err) {
        if (job.cancelled) throw err
        throw new Error(t('tools.copy.targetIncomplete', { error: (err as Error).message }))
      }
      return t('tools.copy.done', { count: o.schemas.length, target: writer.config.name })
    }

    // the script file, removed if the copy does not complete
    let current = ''
    try {
      await mkdir(dirname(path), { recursive: true })
      current = path
      await writeFile(path, `-- DBKnife Copy Database ${new Date().toISOString()}\n\n${script(plan.structure)}`)
      done += plan.structure.length
      progress()
      if (dump) {
        await withOptionFile(reader, dump, async (cnf) => {
          for (const s of o.schemas) {
            const message = t('tools.copy.copyingData', { object: s.source })
            report(job, { message, log: message })
            await appendFile(path, `USE ${quoteIdentifier(s.target)};\n\n`)
            await runWith(job, dump, cnf, [...args, s.source], { output: path, onLine: onLine(s.source) })
          }
        })
      }
      await appendFile(path, script(plan.finish))
      current = ''
      return t('tools.copy.done', { count: o.schemas.length, target: path })
    } catch (err) {
      if (current) {
        await rm(current, { force: true })
        report(job, { log: t('tools.dump.removedIncomplete', { file: current }) })
      }
      throw err
    }
  } finally {
    reader.close()
    if (writer && writer !== reader) writer.close()
  }
}
