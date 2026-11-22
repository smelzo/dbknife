import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { t } from '@shared/i18n'
import {
  alignAction,
  chunkByBytes,
  compareTables,
  deleteSql,
  hasOnUpdate,
  insertSql,
  isGenerated,
  keysetParams,
  keysetWhere,
  matchQuery,
  rowBytes,
  rowChanges,
  sampleValue,
  tableKey,
  updateSql,
  type CheckShape,
  type ColumnShape,
  type Flavor,
  type ForeignKeyShape,
  type IndexPart,
  type KeyColumn,
  type TableOptions,
  type TableShape
} from '@shared/sql/align'
import { buildCopyPlan, normalizedDefinition, tableTypeKinds, type CopyKind, type PlanStep, type SourceObject } from '@shared/sql/copy-plan'
import { qualified, quoteIdentifier } from '@shared/sql/quote'
import type { AlignKind, AlignNote, AlignObjectDiff, AlignPreview, AlignRequest, Row } from '@shared/types'
import { valueText } from '@shared/value-text'
import { forkSession } from '../db/create-session'
import type { MysqlSession } from '../db/drivers/mysql'
import type { DbSession } from '../db/session'
import { dataDir } from '../store'
import { collations, readObject, script, select, targetKinds, warningText } from './copy-mysql'
import { checkCancelled, report, type Job } from './jobs'

// Alignment (MySQL/MariaDB): makes the chosen objects of an existing target
// schema equal to those of a source schema. The job reads the source in a
// consistent snapshot and writes the target on sessions of its own, pinned to
// their connections; rows are synchronized by key in one transaction, tables of
// a different structure are recreated after a backup copy, and a failure puts
// back what was recreated or dropped. Rules and phases:
// .claude/docs/piano-allineamento.md, "Regole dell'allineamento" and Task 3.

/** The job stopped before any change because recreations or drops were not confirmed (not a run of the alignment). */
export class NeedsConfirmation extends Error {
  /** ToolProgress.errorCode of the job: the renderer asks for the confirmation. */
  readonly code = 'needsConfirmation'
}

/** SHOW CREATE TABLE leaves options out with these modes (MariaDB), so two different tables could read alike. */
const hidingModes = new Set(['NO_TABLE_OPTIONS', 'NO_KEY_OPTIONS', 'NO_FIELD_OPTIONS'])
/** Rows read per block, and the keys looked up per block. */
const blockRows = 500
const maxSamples = 20
const relations = new Set<AlignKind>(['table', 'view', 'sequence'])
const caseInsensitiveKinds = new Set<AlignKind>(['procedure', 'function', 'event'])
const numericType = /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|year)\b/i
const numericText = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/

interface Column extends ColumnShape {
  charset: string | null
}

interface TableInfo {
  columns: Column[]
  indexes: IndexPart[]
  foreignKeys: ForeignKeyShape[]
  checks: CheckShape[]
  table: TableOptions
}

/** An object of a schema; `table` is a trigger's table. */
interface Listed {
  kind: AlignKind
  name: string
  table?: string
}

/** One end of the alignment: the job's session and what was read of its schema. */
interface Side {
  session: MysqlSession
  schema: string
  flavor: Flavor
  /** @@max_allowed_packet; statements stay under half of it. */
  maxPacket: number
  objects: Listed[]
  tables: Map<string, TableInfo>
  /** Initial session sql_mode, without the modes hiding table options. */
  sqlMode: string
}

interface Item {
  /** The source's kind and name, or the target's for an object only there. */
  kind: AlignKind
  name: string
  source?: Listed
  target?: Listed
  diff: AlignObjectDiff
  sourceObject?: SourceObject
  targetObject?: SourceObject
  /** Tables: key columns (null: no usable key) and the columns read and written (not generated), in source order. */
  key: string[] | null
  columns: string[]
}

interface Context {
  job: Job
  r: AlignRequest
  reader: Side
  writer: Side
  lowerCaseNames: number
  rename: Record<string, string>
  warnings: AlignNote[]
  /** Every session the job opened, closed at its end. */
  sessions: DbSession[]
  /** The KILL QUERY sent by the cancelers, awaited before a recovery. */
  kills: Promise<unknown>[]
}

interface RowCounts {
  insert: number
  update: number
  delete: number
}

const str = (v: unknown): string | null => (v == null ? null : valueText(v))
const num = (v: unknown): number | null => (v == null ? null : Number(v))

/** Runs a statement on the auxiliary connection; the error keeps the server's errno. Returns the first row (the OK packet of DML). */
async function exec(session: DbSession, sql: string, params?: unknown[]): Promise<Row> {
  const r = await session.query(sql, params)
  if (r.error) throw Object.assign(new Error(r.error.message), { errno: r.error.errno })
  return r.rows[0] ?? {}
}

const errno = (err: unknown): number | undefined => (err as { errno?: number }).errno

/** c0, c1, … aliases, so no real column name clashes with the others. */
const aliased = (cols: string[], prefix = ''): string => cols.map((c, n) => `${prefix}${quoteIdentifier(c)} AS c${n}`).join(', ')
const values = (row: Row, count: number): unknown[] => Array.from({ length: count }, (_, n) => row[`c${n}`])

/**
 * A key value as a parameter. mysql2 sends strings quoted, and a string compared with a numeric column (in the
 * derived table of matchQuery, in keyset conditions) is compared as a double: BIGINT values near 2^64 would
 * match their neighbours. Numbers read as text go as numeric literals instead.
 */
const keyParam = (numeric: boolean, v: unknown): unknown => (numeric && typeof v === 'string' && numericText.test(v) ? { toSqlString: () => v } : v)

/** Name comparisons on the target: `fold` an object's name, `label` a `schema.name`, `same` for two names. */
function sideNames(lowerCaseNames: number): { fold: (kind: AlignKind, name: string) => string; label: (text: string) => string; same: (a: string, b: string) => boolean } {
  const fold = (kind: AlignKind, name: string): string =>
    caseInsensitiveKinds.has(kind) || (lowerCaseNames !== 0 && (relations.has(kind) || kind === 'trigger')) ? name.toLowerCase() : name
  const label = (text: string): string => (lowerCaseNames === 0 ? text : text.toLowerCase())
  return { fold, label, same: (a, b) => label(a) === label(b) }
}

/** Key pairing the objects of the two sides: tables, views and sequences share their names. */
const pairKey = (ctx: Context, kind: AlignKind, name: string): string =>
  `${relations.has(kind) ? 'relation' : kind}\u0000${sideNames(ctx.lowerCaseNames).fold(kind, name)}`
/** Key of an object reference of the request. */
const refKey = (ctx: Context, kind: AlignKind, name: string): string => `${kind}\u0000${sideNames(ctx.lowerCaseNames).fold(kind, name)}`

// --- start -----------------------------------------------------------------

async function openPinned(session: DbSession): Promise<MysqlSession> {
  try {
    return (await forkSession(session, {}, { pinned: true })) as MysqlSession
  } catch (err) {
    throw new Error(t('tools.align.openFailed', { connection: session.config.name, error: (err as Error).message }), { cause: err })
  }
}

/** Takes the modes hiding table options out of the session's sql_mode; returns the mode left. */
async function visibleOptionsMode(session: DbSession): Promise<string> {
  const [row] = await select(session, 'SELECT @@SESSION.sql_mode AS m')
  const mode = str(row.m) ?? ''
  const kept = mode
    .split(',')
    .filter((m) => m && !hidingModes.has(m.toUpperCase()))
    .join(',')
  if (kept !== mode) await exec(session, 'SET SESSION sql_mode = ?', [kept])
  return kept
}

async function side(session: MysqlSession, schema: string): Promise<Side> {
  const [row] = await select(session, 'SELECT @@max_allowed_packet AS p')
  return {
    session,
    schema,
    flavor: session.info.isMariaDB ? 'mariadb' : 'mysql',
    maxPacket: Number(row.p),
    objects: [],
    tables: new Map(),
    sqlMode: await visibleOptionsMode(session)
  }
}

/** Lock name of the alignments of a target schema; GET_LOCK takes at most 64 characters. */
function lockName(schema: string, lowerCaseNames: number): string {
  const name = `dbm_align:${lowerCaseNames === 0 ? schema : schema.toLowerCase()}`
  return name.length <= 64 ? name : `dbm_align:${createHash('sha256').update(name).digest('hex').slice(0, 54)}`
}

/** Steps 2-7 of "Avvio": the job's sessions, cancellation, schemas, identity, snapshot and (apply) the target lock. */
async function start(job: Job, source: DbSession, target: DbSession, r: AlignRequest, apply: boolean, sessions: DbSession[]): Promise<Context> {
  const readerSession = await openPinned(source)
  sessions.push(readerSession)
  const writerSession = await openPinned(target)
  sessions.push(writerSession)

  const kills: Promise<unknown>[] = []
  for (const s of [readerSession, writerSession]) {
    const id = await s.auxThreadId()
    job.cancelers.add(() => kills.push(s.execute(`KILL QUERY ${id}`)))
  }

  for (const [s, schema] of [
    [readerSession, r.source.schema],
    [writerSession, r.target.schema]
  ] as const) {
    const rows = await select(s, 'SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [schema])
    if (!rows.length) throw new Error(t('tools.align.noSchema', { schema, connection: s.config.name }))
  }

  const [lc] = await select(writerSession, 'SELECT @@lower_case_table_names AS lc')
  const lowerCaseNames = Number(lc.lc)
  // the same name on both sides: the same server sees the reader's lock
  if (sideNames(lowerCaseNames).same(r.source.schema, r.target.schema)) {
    const probe = `dbm_align_probe_${randomUUID()}`
    let used: unknown
    try {
      const [got] = await select(readerSession, 'SELECT GET_LOCK(?, 0) AS l', [probe])
      if (Number(got.l) !== 1) throw new Error('probe lock not taken')
      ;[{ u: used }] = await select(writerSession, 'SELECT IS_USED_LOCK(?) AS u', [probe])
      await select(readerSession, 'SELECT RELEASE_LOCK(?)', [probe])
    } catch {
      throw new Error(t('tools.align.identityUnknown', { schema: r.target.schema }))
    }
    if (used != null) throw new Error(t('tools.align.sameSchema', { schema: r.target.schema }))
  }

  const reader = await side(readerSession, r.source.schema)
  const writer = await side(writerSession, r.target.schema)
  // TIMESTAMP values read and written in UTC keep their instant whatever the servers' time zones
  await exec(readerSession, "SET time_zone = '+00:00'")
  await exec(readerSession, 'SET SESSION net_write_timeout = 600')
  await exec(readerSession, 'SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ')
  await exec(readerSession, 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  await exec(writerSession, "SET time_zone = '+00:00'")

  if (apply) {
    const [lock] = await select(writerSession, 'SELECT GET_LOCK(?, 0) AS l', [lockName(r.target.schema, lowerCaseNames)])
    if (Number(lock.l) !== 1) throw new Error(t('tools.align.busy', { schema: r.target.schema }))
  }
  return { job, r, reader, writer, lowerCaseNames, rename: { [r.source.schema]: r.target.schema }, warnings: [], sessions, kills }
}

// --- reading a schema --------------------------------------------------------

interface ForeignKey extends ForeignKeyShape {
  schema: string
  table: string
}

/** Foreign keys with their columns in order; `where` filters REFERENTIAL_CONSTRAINTS rc and KEY_COLUMN_USAGE k. */
async function foreignKeys(session: DbSession, where: string, params: unknown[]): Promise<ForeignKey[]> {
  const rows = await select(
    session,
    `SELECT rc.CONSTRAINT_SCHEMA AS s, rc.TABLE_NAME AS t, rc.CONSTRAINT_NAME AS name, rc.UPDATE_RULE AS updateRule, rc.DELETE_RULE AS deleteRule,
       k.COLUMN_NAME AS col, k.REFERENCED_TABLE_SCHEMA AS refSchema, k.REFERENCED_TABLE_NAME AS refTable, k.REFERENCED_COLUMN_NAME AS refCol
     FROM information_schema.REFERENTIAL_CONSTRAINTS rc
     JOIN information_schema.KEY_COLUMN_USAGE k
       ON k.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA AND k.TABLE_NAME = rc.TABLE_NAME AND k.CONSTRAINT_NAME = rc.CONSTRAINT_NAME
     WHERE ${where}
     ORDER BY rc.CONSTRAINT_SCHEMA, rc.TABLE_NAME, rc.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
    params
  )
  const keys = new Map<string, ForeignKey>()
  for (const r of rows) {
    const id = `${str(r.s)}\u0000${str(r.t)}\u0000${str(r.name)}`
    let fk = keys.get(id)
    if (!fk) {
      fk = {
        schema: str(r.s)!,
        table: str(r.t)!,
        name: str(r.name)!,
        columns: [],
        refSchema: str(r.refSchema)!,
        refTable: str(r.refTable)!,
        refColumns: [],
        updateRule: str(r.updateRule)!,
        deleteRule: str(r.deleteRule)!
      }
      keys.set(id, fk)
    }
    fk.columns.push(str(r.col)!)
    fk.refColumns.push(str(r.refCol)!)
  }
  return [...keys.values()]
}

/** The objects of the side's schema and the description of its tables (information_schema of the whole schema at once). */
async function readSide(s: Side): Promise<void> {
  const { session, schema, flavor } = s
  // SHOW CREATE … of readObject names the objects without their schema
  await exec(session, `USE ${quoteIdentifier(schema)}`)
  const tables = await select(
    session,
    'SELECT TABLE_NAME AS name, TABLE_TYPE AS type, ENGINE AS engine, TABLE_COLLATION AS collation, CREATE_OPTIONS AS options, TABLE_COMMENT AS comment FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
    [schema]
  )
  for (const r of tables) {
    const kind = tableTypeKinds[String(r.type)]
    if (!kind) continue
    const name = str(r.name)!
    s.objects.push({ kind, name })
    if (kind === 'table') {
      s.tables.set(name, {
        columns: [],
        indexes: [],
        foreignKeys: [],
        checks: [],
        table: { engine: str(r.engine), collation: str(r.collation), createOptions: str(r.options) ?? '', comment: str(r.comment) ?? '' }
      })
    }
  }
  const routines = await select(session, 'SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME', [schema])
  for (const r of routines) {
    // MariaDB's PACKAGE and PACKAGE BODY (Oracle mode) are left out, as Copy Database does
    if (r.type === 'PROCEDURE' || r.type === 'FUNCTION') s.objects.push({ kind: r.type === 'PROCEDURE' ? 'procedure' : 'function', name: str(r.name)! })
  }
  const triggers = await select(
    session,
    'SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS tbl FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY EVENT_OBJECT_TABLE, ACTION_ORDER',
    [schema]
  )
  for (const r of triggers) s.objects.push({ kind: 'trigger', name: str(r.name)!, table: str(r.tbl)! })
  const events = await select(session, 'SELECT EVENT_NAME AS name FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME', [schema])
  for (const r of events) s.objects.push({ kind: 'event', name: str(r.name)! })

  // SELECT *: SRS_ID and STATISTICS.EXPRESSION / IS_VISIBLE exist on MySQL only, IGNORED on MariaDB only
  for (const r of await select(session, 'SELECT * FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION', [schema])) {
    s.tables.get(str(r.TABLE_NAME)!)?.columns.push({
      name: str(r.COLUMN_NAME)!,
      position: Number(r.ORDINAL_POSITION),
      type: str(r.COLUMN_TYPE)!,
      nullable: str(r.IS_NULLABLE)!,
      default: str(r.COLUMN_DEFAULT),
      extra: str(r.EXTRA) ?? '',
      collation: str(r.COLLATION_NAME),
      generation: str(r.GENERATION_EXPRESSION),
      comment: str(r.COLUMN_COMMENT) ?? '',
      srsId: flavor === 'mysql' ? num(r.SRS_ID) : null,
      charset: str(r.CHARACTER_SET_NAME)
    })
  }
  for (const r of await select(session, 'SELECT * FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX', [schema])) {
    s.tables.get(str(r.TABLE_NAME)!)?.indexes.push({
      name: str(r.INDEX_NAME)!,
      nonUnique: Number(r.NON_UNIQUE),
      seq: Number(r.SEQ_IN_INDEX),
      column: str(r.COLUMN_NAME),
      subPart: num(r.SUB_PART),
      type: str(r.INDEX_TYPE) ?? '',
      collation: str(r.COLLATION),
      comment: str(r.INDEX_COMMENT) ?? '',
      visible: r.IS_VISIBLE !== undefined ? str(r.IS_VISIBLE) === 'YES' : str(r.IGNORED) !== 'YES',
      ...(flavor === 'mysql' ? { expression: str(r.EXPRESSION) } : {})
    })
  }
  for (const fk of await foreignKeys(session, 'rc.CONSTRAINT_SCHEMA = ?', [schema])) s.tables.get(fk.table)?.foreignKeys.push(fk)
  const checks =
    flavor === 'mysql'
      ? await select(
          session,
          `SELECT tc.TABLE_NAME AS t, cc.CONSTRAINT_NAME AS name, cc.CHECK_CLAUSE AS clause, tc.ENFORCED AS enforced
           FROM information_schema.CHECK_CONSTRAINTS cc JOIN information_schema.TABLE_CONSTRAINTS tc
             ON tc.CONSTRAINT_SCHEMA = cc.CONSTRAINT_SCHEMA AND tc.CONSTRAINT_NAME = cc.CONSTRAINT_NAME AND tc.CONSTRAINT_TYPE = 'CHECK'
           WHERE cc.CONSTRAINT_SCHEMA = ?`,
          [schema]
        )
      : await select(session, "SELECT TABLE_NAME AS t, CONSTRAINT_NAME AS name, CHECK_CLAUSE AS clause, 'YES' AS enforced FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ?", [schema])
  for (const r of checks) s.tables.get(str(r.t)!)?.checks.push({ name: str(r.name)!, clause: str(r.clause)!, enforced: str(r.enforced) !== 'NO' })
}

const shape = (s: Side, info: TableInfo, createTable: string): TableShape => ({ ...info, flavor: s.flavor, createTable })

/** sql_mode as a set, without NO_AUTO_CREATE_USER (acts on GRANT only, refused by MySQL 8). */
const modeSet = (mode: string | undefined): string | undefined =>
  mode
    ?.split(',')
    .filter((m) => m && m.toUpperCase() !== 'NO_AUTO_CREATE_USER')
    .map((m) => m.toUpperCase())
    .sort()
    .join(',')

/** Differences of the definition of an object other than a table, with the session context stored with it. */
function definitionNotes(ctx: Context, a: SourceObject, b: SourceObject): AlignNote[] {
  const notes: AlignNote[] = []
  const definers = ctx.r.options.definers
  if (normalizedDefinition(a, ctx.rename, definers) !== normalizedDefinition(b, {}, definers)) notes.push({ code: 'definitionDiffers' })
  const context: [string, string | undefined, string | undefined][] = [
    ['sql_mode', modeSet(a.sqlMode), modeSet(b.sqlMode)],
    ['DATABASE_COLLATION', a.databaseCollation?.toLowerCase(), b.databaseCollation?.toLowerCase()],
    ['COLLATION_CONNECTION', a.collationConnection?.toLowerCase(), b.collationConnection?.toLowerCase()],
    ['time_zone', a.timeZone, b.timeZone]
  ]
  for (const [property, x, y] of context) {
    if (x !== y) notes.push({ code: 'contextDiffers', params: { property, source: x ?? '', target: y ?? '' } })
  }
  return notes
}

// --- inspect -----------------------------------------------------------------

/** The table's key, unless one of its columns is generated (it could not be written). */
function usableKey(info: TableInfo): string[] | null {
  const key = tableKey(info.columns, info.indexes)
  const generated = new Set(info.columns.filter((c) => isGenerated(c.extra)).map((c) => c.name))
  return key && !key.some((k) => generated.has(k)) ? key : null
}

const writable = (info: TableInfo): string[] => info.columns.filter((c) => !isGenerated(c.extra)).map((c) => c.name)

async function count(s: Side, table: string): Promise<number> {
  const [row] = await select(s.session, `SELECT COUNT(*) AS n FROM ${qualified(s.schema, table)}`)
  return Number(row.n)
}

/**
 * Reads and compares the two schemas (rules of the plan): the objects selected with their action and status.
 * `rows`: walk the rows of the syncRows tables (Compare); Apply walks them while writing.
 */
async function inspect(ctx: Context, rows: boolean): Promise<Item[]> {
  const { job, r, reader, writer } = ctx
  report(job, { progress: -1, message: t('tools.align.reading', { schema: reader.schema }) })
  await readSide(reader)
  report(job, { progress: -1, message: t('tools.align.reading', { schema: writer.schema }) })
  await readSide(writer)
  const transactional = new Set(
    (await select(reader.session, "SELECT ENGINE AS e FROM information_schema.ENGINES WHERE TRANSACTIONS = 'YES'")).map((x) => String(x.e).toLowerCase())
  )

  // selection
  const wanted = r.objects && new Set(r.objects.map((o) => refKey(ctx, o.kind, o.name)))
  const items = new Map<string, Item>()
  for (const o of reader.objects) {
    if (wanted && !wanted.has(refKey(ctx, o.kind, o.name))) continue
    const item: Item = { kind: o.kind, name: o.name, source: o, key: null, columns: [], diff: { kind: o.kind, name: o.name, status: 'sourceOnly', action: 'none', notes: [] } }
    items.set(pairKey(ctx, o.kind, o.name), item)
  }
  for (const ref of r.objects ?? []) {
    if (!reader.objects.some((o) => refKey(ctx, o.kind, o.name) === refKey(ctx, ref.kind, ref.name))) ctx.warnings.push({ code: 'missing', params: { kind: ref.kind, name: ref.name } })
  }
  const sourceKeys = new Set(reader.objects.map((o) => pairKey(ctx, o.kind, o.name)))
  const targetOnly = (o: Listed): boolean => !sourceKeys.has(pairKey(ctx, o.kind, o.name))
  const drop = new Set<string>()
  for (const ref of r.drop) {
    const o = writer.objects.find((x) => refKey(ctx, x.kind, x.name) === refKey(ctx, ref.kind, ref.name))
    if (o && targetOnly(o)) drop.add(refKey(ctx, o.kind, o.name))
    else ctx.warnings.push({ code: 'notTargetOnly', params: { kind: ref.kind, name: ref.name } })
  }
  for (const o of writer.objects) {
    const key = pairKey(ctx, o.kind, o.name)
    const paired = items.get(key)
    if (paired) paired.target = o
    else if (targetOnly(o) && (!r.objects || drop.has(refKey(ctx, o.kind, o.name)))) {
      items.set(key, { kind: o.kind, name: o.name, target: o, key: null, columns: [], diff: { kind: o.kind, name: o.name, status: 'targetOnly', action: 'none', notes: [] } })
    }
  }

  const list = [...items.values()]
  for (const [i, item] of list.entries()) {
    checkCancelled(job)
    report(job, { progress: i / list.length, message: t('tools.align.comparing', { object: item.name }) })
    const { source, target, diff } = item
    let structureDiffers = false
    let hasKey = false
    const sourceInfo = source?.kind === 'table' ? reader.tables.get(source.name) : undefined
    const targetInfo = target?.kind === 'table' ? writer.tables.get(target.name) : undefined
    if (source && target) {
      if (source.kind !== target.kind) {
        diff.notes.push({ code: 'kindDiffers', params: { source: source.kind, target: target.kind } })
        structureDiffers = true
      } else {
        item.sourceObject = await readObject(reader.session, reader.schema, source.kind, source.name)
        item.targetObject = await readObject(writer.session, writer.schema, target.kind, target.name)
        diff.ddl = { source: item.sourceObject.ddl, target: item.targetObject.ddl }
        const notes =
          sourceInfo && targetInfo
            ? compareTables(shape(reader, sourceInfo, item.sourceObject.ddl), shape(writer, targetInfo, item.targetObject.ddl), ctx.rename)
            : definitionNotes(ctx, item.sourceObject, item.targetObject)
        diff.notes.push(...notes)
        structureDiffers = notes.length > 0
      }
      diff.status = structureDiffers ? 'different' : 'same'
    }
    if (sourceInfo) {
      item.key = usableKey(sourceInfo)
      item.columns = writable(sourceInfo)
      hasKey = item.key !== null
    } else if (targetInfo) item.columns = writable(targetInfo)

    const decided = alignAction(
      { status: diff.status, kind: item.kind, structureDiffers, hasKey, inDrop: !source && drop.has(refKey(ctx, item.kind, item.name)) },
      r.options
    )
    diff.action = decided.action
    diff.notes.push(...decided.notes)
    if (source && (diff.action === 'create' || diff.action === 'recreate') && !item.sourceObject) {
      item.sourceObject = await readObject(reader.session, reader.schema, source.kind, source.name)
      diff.ddl = { ...diff.ddl, source: item.sourceObject.ddl }
    }
    const readsRows = sourceInfo && (diff.action === 'syncRows' || diff.action === 'replaceRows' || ((diff.action === 'create' || diff.action === 'recreate') && r.options.data))
    if (readsRows && !transactional.has((sourceInfo.table.engine ?? '').toLowerCase())) diff.notes.push({ code: 'notTransactional', params: { engine: sourceInfo.table.engine ?? '' } })

    if (diff.action === 'replaceRows' || (diff.action === 'recreate' && sourceInfo)) {
      diff.rows = { insert: await count(reader, source!.name), update: 0, delete: targetInfo ? await count(writer, target!.name) : 0 }
    }
    // without a key the equality of the rows cannot be told
    if (diff.action === 'replaceRows') diff.status = 'different'
    if (diff.action === 'syncRows') {
      if (rows) {
        const { sample, ...counts } = await walkRows(ctx, item, false)
        diff.rows = counts
        diff.sample = sample
        if (counts.insert || counts.update || counts.delete) diff.status = 'different'
      } else diff.status = 'different' // Apply: not walked before writing, so in doubt
    }
  }
  return list
}

const preview = (ctx: Context, items: Item[]): AlignPreview => ({ objects: items.map((i) => i.diff), warnings: ctx.warnings })

// --- rows --------------------------------------------------------------------

/** Which key columns are numeric (their values go as numeric literals, see keyParam). */
const numericKey = (info: TableInfo, key: string[]): boolean[] => key.map((k) => numericType.test(info.columns.find((c) => c.name === k)?.type ?? ''))

function keyColumn(info: TableInfo, name: string): KeyColumn {
  const c = info.columns.find((x) => x.name === name)
  return c?.collation && c.charset ? { name, charset: c.charset, collation: c.collation } : { name }
}

/** Rows of `table` on `s` matching `keys` (joined by the server): position in `keys` → the values of `cols`. */
async function matchRows(ctx: Context, s: Side, table: string, info: TableInfo, key: string[], keys: unknown[][], cols: string[]): Promise<Map<number, unknown[]>> {
  const numeric = numericKey(info, key)
  const keyColumns = key.map((k) => keyColumn(info, k))
  const qualifiedTable = qualified(s.schema, table)
  const found = new Map<number, unknown[]>()
  const indexed = keys.map((k, i) => ({ i, k }))
  for (const x of indexed) if (rowBytes(x.k) > s.maxPacket) throw new Error(t('tools.align.rowTooLarge', { table, key: JSON.stringify(x.k) }))
  for (const chunk of chunkByBytes(indexed, (x) => rowBytes(x.k) + 24, s.maxPacket / 2)) {
    const params = chunk.flatMap((x) => [x.i, ...x.k.map((v, n) => keyParam(numeric[n], v))])
    for (const row of await select(s.session, matchQuery(qualifiedTable, keyColumns, cols, chunk.length), params)) found.set(Number(row.i), values(row, cols.length))
  }
  return found
}

/** Keyset blocks of `cols` of `table` on `s`, in key order; `onBlock` gets the rows as value arrays. */
async function keysetBlocks(s: Side, table: string, info: TableInfo, key: string[], cols: string[], onBlock: (rows: unknown[][]) => Promise<void>): Promise<void> {
  const numeric = numericKey(info, key)
  const at = key.map((k) => cols.indexOf(k))
  const order = key.map(quoteIdentifier).join(', ')
  let last: unknown[] | null = null
  for (;;) {
    const where: string = last ? ` WHERE ${keysetWhere(key)}` : ''
    const params: unknown[] = last ? keysetParams(last.map((v, n) => keyParam(numeric[n], v))) : []
    const rows: unknown[][] = (await select(s.session, `SELECT ${aliased(cols)} FROM ${qualified(s.schema, table)}${where} ORDER BY ${order} LIMIT ${blockRows}`, params)).map((r) => values(r, cols.length))
    if (!rows.length) return
    last = at.map((n) => rows[rows.length - 1][n])
    await onBlock(rows)
    if (rows.length < blockRows) return
  }
}

function budgetCheck(s: Side, table: string, row: unknown[], key: unknown[]): void {
  if (rowBytes(row) > s.maxPacket) throw new Error(t('tools.align.rowTooLarge', { table, key: JSON.stringify(key) }))
}

/**
 * The rows of a syncRows table: with deleteRows, the target keys missing in the source; then the source rows
 * missing in the target or different there. With `write` the changes are made as they are found, in the order
 * delete → update → insert (for each block); without, samples are collected for the preview.
 */
async function walkRows(ctx: Context, item: Item, write: boolean): Promise<RowCounts & { sample?: AlignObjectDiff['sample'] }> {
  const { job, r, reader, writer } = ctx
  const key = item.key!
  const cols = item.columns
  const sourceInfo = reader.tables.get(item.source!.name)!
  const targetInfo = writer.tables.get(item.target!.name)!
  const sourceTable = item.source!.name
  const targetTable = item.target!.name
  const target = qualified(writer.schema, targetTable)
  const at = key.map((k) => cols.indexOf(k))
  const numeric = numericKey(targetInfo, key)
  const onUpdate = targetInfo.columns.filter((c) => hasOnUpdate(c.extra) && cols.includes(c.name)).map((c) => c.name)
  const counts: RowCounts = { insert: 0, update: 0, delete: 0 }
  const sample: NonNullable<AlignObjectDiff['sample']> = { columns: cols, rows: [] }
  const room = (): number => (write ? 0 : maxSamples - sample.rows.length)
  const message = t('tools.align.rows', { object: item.name })

  if (r.options.deleteRows) {
    await keysetBlocks(writer, targetTable, targetInfo, key, key, async (keys) => {
      checkCancelled(job)
      report(job, { message })
      const found = await matchRows(ctx, reader, sourceTable, sourceInfo, key, keys, [])
      const gone = keys.filter((_, i) => !found.has(i))
      counts.delete += gone.length
      if (room() > 0 && gone.length) {
        const shown = gone.slice(0, room())
        const full = await matchRows(ctx, writer, targetTable, targetInfo, key, shown, cols)
        shown.forEach((_, i) => {
          const row = full.get(i)
          if (row) sample.rows.push({ kind: 'delete', target: row.map(sampleValue) })
        })
      }
      if (!write || !gone.length) return
      const param = (k: unknown[]): unknown => (key.length === 1 ? keyParam(numeric[0], k[0]) : k.map((v, n) => keyParam(numeric[n], v)))
      for (const chunk of chunkByBytes(gone, (k) => rowBytes(k) + 4, writer.maxPacket / 2)) await exec(writer.session, deleteSql(target, key), [chunk.map(param)])
    })
  }

  await keysetBlocks(reader, sourceTable, sourceInfo, key, cols, async (rows) => {
    checkCancelled(job)
    report(job, { message })
    const matched = await matchRows(ctx, writer, targetTable, targetInfo, key, rows.map((v) => at.map((n) => v[n])), cols)
    const inserts: unknown[][] = []
    const updates: { source: unknown[]; target: unknown[]; changed: number[] }[] = []
    rows.forEach((row, i) => {
      const existing = matched.get(i)
      if (!existing) inserts.push(row)
      else {
        const changed = rowChanges(row, existing)
        if (changed.length) updates.push({ source: row, target: existing, changed })
      }
    })
    counts.insert += inserts.length
    counts.update += updates.length
    for (const u of updates.slice(0, room())) sample.rows.push({ kind: 'update', source: u.source.map(sampleValue), target: u.target.map(sampleValue), changed: u.changed })
    for (const row of inserts.slice(0, room())) sample.rows.push({ kind: 'insert', source: row.map(sampleValue) })
    if (!write) return
    for (const u of updates) {
      // ON UPDATE columns take the source's value, or the server would set them to the current time
      const set = cols.filter((c, n) => u.changed.includes(n) || onUpdate.includes(c))
      const params = [...set.map((c) => u.source[cols.indexOf(c)]), ...at.map((n, k) => keyParam(numeric[k], u.target[n]))]
      budgetCheck(writer, targetTable, params, at.map((n) => u.source[n]))
      await exec(writer.session, updateSql(target, set, key), params)
    }
    await insertRows(ctx, target, targetTable, cols, inserts, at)
  })
  return write ? counts : { ...counts, sample }
}

/** INSERT of `rows` in blocks under half of the target's max_allowed_packet. */
async function insertRows(ctx: Context, target: string, table: string, cols: string[], rows: unknown[][], at: number[]): Promise<void> {
  const w = ctx.writer
  for (const row of rows) budgetCheck(w, table, row, at.map((n) => row[n]))
  for (const chunk of chunkByBytes(rows, rowBytes, w.maxPacket / 2)) await exec(w.session, insertSql(target, cols, chunk.length), chunk.flat())
}

/** Every row of the source table into the target table (a new or emptied one), streamed. */
async function copyRows(ctx: Context, sourceTable: string, targetTable: string, cols: string[]): Promise<number> {
  const { job, reader, writer } = ctx
  const target = qualified(writer.schema, targetTable)
  const message = t('tools.align.rows', { object: targetTable })
  let copied = 0
  await reader.session.queryStream(`SELECT ${aliased(cols)} FROM ${qualified(reader.schema, sourceTable)}`, [], async (rows) => {
    checkCancelled(job)
    report(job, { message })
    const block = rows.map((r) => values(r, cols.length))
    await insertRows(ctx, target, targetTable, cols, block, [])
    copied += block.length
  })
  return copied
}

// --- compare -----------------------------------------------------------------

/** Runs `work` on the job's sessions, closed at the end; the cancelers are removed when it returns or fails. */
async function withSessions<T>(job: Job, source: DbSession, target: DbSession, r: AlignRequest, apply: boolean, work: (ctx: Context) => Promise<T>): Promise<T> {
  if (!r.options.structure && !r.options.data) throw new Error(t('tools.align.nothingToDo'))
  const sessions: DbSession[] = []
  const cancelers = new Set(job.cancelers)
  try {
    return await work(await start(job, source, target, r, apply, sessions))
  } finally {
    for (const c of job.cancelers) if (!cancelers.has(c)) job.cancelers.delete(c)
    for (const s of sessions) s.close()
  }
}

export function alignCompare(job: Job, source: DbSession, target: DbSession, r: AlignRequest): Promise<string> {
  return withSessions(job, source, target, r, false, async (ctx) => {
    const items = await inspect(ctx, true)
    report(job, { preview: preview(ctx, items) })
    return t('tools.align.compared', { count: items.filter((i) => i.diff.status !== 'same').length })
  })
}

// --- apply -------------------------------------------------------------------

interface Backup {
  /** The table backed up and the copy. */
  table: string
  copy: string
  columns: string[]
}

/** What is lost by the job, saved before any change, and what has been touched so far. */
interface Inventory {
  /** Target objects to recreate or drop (tables only with a backup) and the triggers dropped while the job writes. */
  saved: SourceObject[]
  /** Triggers recreated at the end from their saved definition. */
  restore: SourceObject[]
  /** Target triggers and events whose replacement from the source is created after the COMMIT (phase 9). */
  late: SourceObject[]
  /** Objects the job creates (action create), dropped again by a recovery before the COMMIT. */
  created: { kind: AlignKind; name: string }[]
  backups: Backup[]
  file: string
  /** `schema.name` (folded) of the objects dropped or created so far. */
  touched: Set<string>
  /** The schema's collation was changed by an ALTER DATABASE not yet reverted. */
  collationAltered: boolean
  collation: string
  createDatabase: string
}

/** Where the writes are: the COMMIT, when it was sent and its outcome is not known, decides what a recovery does. */
interface ApplyState {
  inTransaction: boolean
  committing: boolean
  committed: boolean
  totals: { created: number; recreated: number; dropped: number; inserted: number; updated: number; deleted: number }
}

/** INSERT … SELECT between a table and its backup keep a 0 in an AUTO_INCREMENT column; not strict: the rows are the table's own. */
const copyMode = "SET SESSION sql_mode = 'NO_AUTO_VALUE_ON_ZERO'"

const isTableChange = (item: Item): boolean =>
  item.diff.action === 'drop' || (item.diff.action === 'recreate' && (item.kind === 'table' || item.target?.kind === 'table'))

/** Phase 3: what would fail halfway on the target is refused before any change. */
async function preflight(ctx: Context, items: Item[]): Promise<void> {
  const { reader, writer } = ctx
  const built = items.filter((i) => i.diff.action === 'create' || i.diff.action === 'recreate')
  const used = new Set<string>()
  for (const item of built) {
    const info = item.kind === 'table' ? reader.tables.get(item.source!.name) : undefined
    if (info) {
      if (info.table.collation) used.add(info.table.collation)
      for (const c of info.columns) if (c.collation) used.add(c.collation)
    }
    for (const c of [item.sourceObject?.collationConnection, item.sourceObject?.databaseCollation]) if (c) used.add(c)
  }
  const available = new Set((await collations(writer.session)).map((c) => c.name.toLowerCase()))
  const missing = [...used].filter((c) => !available.has(c.toLowerCase())).sort()
  if (missing.length) throw new Error(t('tools.align.missingCollation', { names: missing.join(', ') }))

  const engines = new Set(
    (await select(writer.session, "SELECT ENGINE AS e FROM information_schema.ENGINES WHERE SUPPORT IN ('YES', 'DEFAULT')")).map((x) => String(x.e).toLowerCase())
  )
  const lacking = [
    ...new Set(
      built
        .filter((i) => i.kind === 'table')
        .map((i) => reader.tables.get(i.source!.name)?.table.engine)
        .filter((e): e is string => !!e && !engines.has(e.toLowerCase()))
    )
  ]
  if (lacking.length) throw new Error(t('tools.align.missingEngine', { engines: lacking.join(', ') }))

  // tables of the target that go away: dropped, or replaced by a view or a sequence of the source
  const { same } = sideNames(ctx.lowerCaseNames)
  const gone = items
    .filter((i) => i.target?.kind === 'table' && (i.diff.action === 'drop' || (i.diff.action === 'recreate' && i.kind !== 'table')))
    .map((i) => i.target!.name)
  if (gone.length) {
    // a child that goes too takes its foreign keys with it
    const goes = (schema: string, table: string): boolean => same(schema, writer.schema) && gone.some((d) => same(d, table))
    for (const fk of await foreignKeys(writer.session, 'k.REFERENCED_TABLE_SCHEMA = ?', [writer.schema])) {
      if (goes(fk.refSchema, fk.refTable) && !goes(fk.schema, fk.table)) {
        throw new Error(t('tools.align.dropReferenced', { table: fk.refTable, by: `${fk.schema}.${fk.table}` }))
      }
    }
  }
}

/** Steps recreating `objects` of the target from their saved definitions, rows put back from the backups in between. */
function restoreSteps(ctx: Context, inv: Inventory, objects: SourceObject[], kinds?: Record<string, CopyKind>): PlanStep[] {
  if (!objects.length) return []
  const dst = ctx.writer.schema
  const plan = buildCopyPlan({
    schemas: [{ name: dst, ddl: inv.createDatabase, collation: inv.collation }],
    objects,
    rename: {},
    definers: 'keep',
    existing: 'recreate',
    structureOnly: false,
    collations: {},
    targetKinds: kinds
  })
  const tables = new Set(objects.filter((o) => o.kind === 'table').map((o) => o.name))
  const backups = inv.backups.filter((b) => tables.has(b.table))
  const rows = backups.flatMap((b): PlanStep[] => {
    const cols = b.columns.map(quoteIdentifier).join(', ')
    return [
      { sql: `INSERT INTO ${qualified(dst, b.table)} (${cols}) SELECT ${cols} FROM ${qualified(dst, b.copy)}`, compound: false, object: `${dst}.${b.table}` },
      { sql: `DROP TABLE ${qualified(dst, b.copy)}`, compound: false, object: `${dst}.${b.copy}` }
    ]
  })
  // the plan's finish puts the session's sql_mode back
  const mode: PlanStep[] = rows.length ? [{ sql: copyMode, compound: false, object: '' }] : []
  return [...plan.structure, ...mode, ...rows, ...plan.finish]
}

/** The recovery script of `objects`; the schema names of the header on one line. */
async function writeRecoveryFile(ctx: Context, inv: Inventory, objects: SourceObject[], kinds?: Record<string, CopyKind>): Promise<void> {
  const line = (text: string): string => text.replace(/[\r\n]+/g, ' ')
  const { r } = ctx
  const header =
    `-- DBKnife Alignment ${new Date().toISOString()}: ${line(r.source.schema)} → ${line(r.target.schema)}\n` +
    `-- Recreates the objects of ${line(r.target.schema)} that the alignment recreated or dropped, and their rows from the backup tables.\n\n`
  await writeFile(inv.file, header + script(restoreSteps(ctx, inv, objects, kinds)), { mode: 0o600 })
}

/** Phase 4: definitions of what is lost, the triggers to take away, the backups and the recovery file. */
async function takeInventory(ctx: Context, items: Item[], inv: Inventory): Promise<void> {
  const { job, r, writer } = ctx
  const { fold, same } = sideNames(ctx.lowerCaseNames)
  const changed = items.filter((i) => (i.diff.action === 'recreate' || i.diff.action === 'drop') && i.target)
  const byName = new Map<string, SourceObject>()
  for (const item of changed) {
    item.targetObject ??= await readObject(writer.session, writer.schema, item.target!.kind, item.target!.name)
    byName.set(`${item.target!.kind}\u0000${fold(item.target!.kind, item.target!.name)}`, item.targetObject)
  }
  inv.created = items.filter((i) => i.diff.action === 'create').map((i) => ({ kind: i.kind, name: i.source!.name }))
  // events are recreated from the source after the COMMIT
  inv.late = changed.filter((i) => i.diff.action === 'recreate' && i.kind === 'event' && i.target!.kind === 'event').map((i) => i.targetObject!)

  // triggers of the tables receiving DDL or rows, and the triggers recreated or dropped, in ACTION_ORDER
  const tables = items
    .filter((i) => i.target?.kind === 'table' && ['recreate', 'drop', 'syncRows', 'replaceRows'].includes(i.diff.action))
    .map((i) => i.target!.name)
  const droppedTables = items.filter((i) => i.diff.action === 'drop' && i.target?.kind === 'table').map((i) => i.target!.name)
  const triggerItem = (name: string): Item | undefined => items.find((i) => i.target?.kind === 'trigger' && same(i.target.name, name))
  const triggers = writer.objects.filter(
    (o) => o.kind === 'trigger' && (tables.some((tb) => same(tb, o.table!)) || ['recreate', 'drop'].includes(triggerItem(o.name)?.diff.action ?? ''))
  )
  const triggerObjects: SourceObject[] = []
  for (const o of triggers) {
    checkCancelled(job)
    const id = `trigger\u0000${fold('trigger', o.name)}`
    const saved = byName.get(id) ?? (await readObject(writer.session, writer.schema, 'trigger', o.name))
    byName.set(id, saved)
    triggerObjects.push(saved)
    const item = triggerItem(o.name)
    const dropped = item?.diff.action === 'drop'
    const goesWithTable = droppedTables.some((tb) => same(tb, o.table!))
    // the source has one of the same name among the objects created or recreated (after the COMMIT)
    const replaced = item?.source?.kind === 'trigger' && (item.diff.action === 'create' || item.diff.action === 'recreate')
    if (replaced) inv.late.push(saved)
    else if (!dropped && !goesWithTable) inv.restore.push(saved)
  }
  const tableBackedUp = (item: Item): boolean => r.options.backup && item.target?.kind === 'table'
  inv.saved = [
    ...changed.filter((i) => i.target!.kind !== 'trigger' && (i.target!.kind !== 'table' || tableBackedUp(i))).map((i) => i.targetObject!),
    ...triggerObjects
  ]

  const [db] = await select(writer.session, `SHOW CREATE DATABASE ${quoteIdentifier(writer.schema)}`)
  inv.createDatabase = String(db['Create Database'])
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  inv.file = join(dataDir('alignments', 'recovery'), `${stamp}-${r.alignmentId ?? 'adhoc'}.sql`)

  try {
    if (r.options.backup) {
      const tag = randomBytes(4).toString('hex')
      await exec(writer.session, copyMode)
      for (const item of changed.filter(tableBackedUp)) {
        checkCancelled(job)
        const table = item.target!.name
        const copy = `dbm_al_${tag}_${inv.backups.length + 1}`
        report(job, { message: t('tools.align.backup', { object: table }) })
        const columns = writable(writer.tables.get(table)!)
        await exec(writer.session, `CREATE TABLE ${qualified(writer.schema, copy)} LIKE ${qualified(writer.schema, table)}`)
        inv.backups.push({ table, copy, columns })
        const cols = columns.map(quoteIdentifier).join(', ')
        await exec(writer.session, `INSERT INTO ${qualified(writer.schema, copy)} (${cols}) SELECT ${cols} FROM ${qualified(writer.schema, table)}`)
      }
      await exec(writer.session, 'SET SESSION sql_mode = ?', [writer.sqlMode])
    }
    // with the kinds as they are now: the script drops a view or a table with the right statement
    await writeRecoveryFile(ctx, inv, inv.saved, await targetKinds(writer.session, [writer.schema]))
  } catch (err) {
    // no KILL from now on, and the ones sent have reached the server before the backups are dropped
    job.cancelers.clear()
    await Promise.allSettled(ctx.kills)
    const left = await dropBackups(ctx, inv, writer.session)
    await rm(inv.file, { force: true })
    if (!left.length) throw err
    const error = job.cancelled ? t('tools.cancelled') : (err as Error).message
    const message = t('tools.align.backupsLeft', { error, tables: left.join(', ') })
    if (job.cancelled) job.cancelledMessage = message
    throw new Error(message, { cause: err })
  }
}

/** Drops the backup tables; returns those left. */
async function dropBackups(ctx: Context, inv: Inventory, session: DbSession): Promise<string[]> {
  const left: string[] = []
  for (const b of inv.backups) {
    try {
      await exec(session, `DROP TABLE IF EXISTS ${qualified(ctx.writer.schema, b.copy)}`)
    } catch {
      left.push(b.copy)
    }
  }
  return left
}

/** Runs steps on the writer, recording the objects touched and the ALTER DATABASE … COLLATE not yet reverted. */
async function runSteps(ctx: Context, inv: Inventory, steps: PlanStep[]): Promise<void> {
  const { label } = sideNames(ctx.lowerCaseNames)
  for (const step of steps) {
    checkCancelled(ctx.job)
    if (step.object) {
      inv.touched.add(label(step.object))
      report(ctx.job, { message: t('tools.copy.creating', { object: step.object }) })
    }
    const alter = /^ALTER DATABASE .* COLLATE (\S+)$/.exec(step.sql)
    try {
      await exec(ctx.writer.session, step.sql)
    } catch (err) {
      throw new Error(t('tools.copy.stepFailed', { object: step.object || step.sql, error: (err as Error).message }), { cause: err })
    }
    if (alter) inv.collationAltered = alter[1].toLowerCase() !== inv.collation.toLowerCase()
  }
}

/** Phase 8: a FK of a table written or recreated (either end, any schema) with a child row and no parent. */
async function orphans(ctx: Context, written: string[]): Promise<string[]> {
  const { writer } = ctx
  const { same } = sideNames(ctx.lowerCaseNames)
  const touches = (schema: string, table: string): boolean => same(schema, writer.schema) && written.some((w) => same(w, table))
  const found: string[] = []
  for (const fk of await foreignKeys(writer.session, '(rc.CONSTRAINT_SCHEMA = ? OR k.REFERENCED_TABLE_SCHEMA = ?)', [writer.schema, writer.schema])) {
    if (!touches(fk.schema, fk.table) && !touches(fk.refSchema, fk.refTable)) continue
    checkCancelled(ctx.job)
    const notNull = fk.columns.map((c) => `c.${quoteIdentifier(c)} IS NOT NULL`).join(' AND ')
    const match = fk.columns.map((c, n) => `p.${quoteIdentifier(fk.refColumns[n])} = c.${quoteIdentifier(c)}`).join(' AND ')
    const rows = await select(
      writer.session,
      `SELECT 1 FROM ${qualified(fk.schema, fk.table)} c WHERE ${notNull} AND NOT EXISTS (SELECT 1 FROM ${qualified(fk.refSchema, fk.refTable)} p WHERE ${match}) LIMIT 1`
    )
    if (rows.length) found.push(`${fk.schema}.${fk.table}.${fk.name}`)
  }
  return found
}

const duplicateKey = (message: string): string => /for key '([^']+)'/.exec(message)?.[1] ?? message

/** Phases 5-8: triggers away, structure, rows in one transaction, orphans, COMMIT. */
async function writeTarget(ctx: Context, items: Item[], inv: Inventory, st: ApplyState): Promise<PlanStep[]> {
  const { job, r, reader, writer } = ctx
  const dst = writer.schema
  const { label } = sideNames(ctx.lowerCaseNames)
  const { totals } = st

  // 5. triggers away, so that the writes do not fire them
  for (const trg of inv.saved.filter((o) => o.kind === 'trigger')) {
    checkCancelled(job)
    inv.touched.add(label(`${dst}.${trg.name}`))
    await exec(writer.session, `DROP TRIGGER IF EXISTS ${qualified(dst, trg.name)}`)
  }

  // 6. structure
  let finish: PlanStep[] = []
  if (r.options.structure) {
    await exec(writer.session, 'SET FOREIGN_KEY_CHECKS = 0')
    for (const item of items.filter((i) => i.diff.action === 'drop')) {
      checkCancelled(job)
      const o = item.target!
      inv.touched.add(label(`${dst}.${o.name}`))
      report(job, { message: t('tools.align.dropping', { object: `${dst}.${o.name}` }) })
      await exec(writer.session, `DROP ${o.kind.toUpperCase()} IF EXISTS ${qualified(dst, o.name)}`)
      totals.dropped++
    }
    const built = items.filter((i) => i.diff.action === 'create' || i.diff.action === 'recreate')
    if (built.length) {
      const [db] = await select(reader.session, `SHOW CREATE DATABASE ${quoteIdentifier(reader.schema)}`)
      const plan = buildCopyPlan({
        schemas: [{ name: reader.schema, ddl: String(db['Create Database']), collation: inv.collation }],
        objects: built.map((i) => i.sourceObject!),
        rename: ctx.rename,
        definers: r.options.definers,
        existing: 'recreate',
        structureOnly: false,
        collations: {},
        targetKinds: await targetKinds(writer.session, [dst])
      })
      for (const w of plan.warnings) report(job, { log: warningText(w) })
      await runSteps(ctx, inv, plan.structure)
      finish = plan.finish
      for (const i of built) totals[i.diff.action === 'create' ? 'created' : 'recreated']++
    }
  }

  // 7. rows, in one transaction
  const rowItems = items.filter(
    (i) => i.diff.action === 'syncRows' || i.diff.action === 'replaceRows' || (r.options.data && i.kind === 'table' && (i.diff.action === 'create' || i.diff.action === 'recreate'))
  )
  if (!rowItems.length) return finish
  const written = rowItems.map((i) => (i.diff.action === 'create' || i.diff.action === 'recreate' ? i.source!.name : i.target!.name))
  await exec(writer.session, 'SET NAMES utf8mb4')
  // UNIQUE_CHECKS = 0 (set by the plan) may let InnoDB miss duplicates
  await exec(writer.session, 'SET UNIQUE_CHECKS = 1')
  await exec(writer.session, 'SET FOREIGN_KEY_CHECKS = 0')
  await exec(writer.session, 'SET sql_mode = ?', [[writer.sqlMode, 'NO_AUTO_VALUE_ON_ZERO'].filter(Boolean).join(',')])
  await exec(writer.session, "SET time_zone = '+00:00'")
  await exec(writer.session, 'START TRANSACTION')
  st.inTransaction = true
  for (const item of rowItems) {
    checkCancelled(job)
    await exec(writer.session, 'SAVEPOINT dbm_t')
    const action = item.diff.action
    if (action === 'syncRows') {
      try {
        const counts = await walkRows(ctx, item, true)
        totals.inserted += counts.insert
        totals.updated += counts.update
        totals.deleted += counts.delete
        continue
      } catch (err) {
        if (errno(err) !== 1062) throw err
        if (!r.options.deleteRows) throw new Error(t('tools.align.uniqueConflict', { table: item.target!.name, key: duplicateKey((err as Error).message) }), { cause: err })
        // values of UNIQUE keys exchanged between rows: the table is written again as a whole
        await exec(writer.session, 'ROLLBACK TO SAVEPOINT dbm_t')
        report(job, { log: t('tools.align.uniqueRewrite', { table: item.target!.name }) })
      }
    }
    let targetTable = item.target?.name ?? item.source!.name
    if (action === 'create' || action === 'recreate') targetTable = item.source!.name
    else {
      const deleted = await exec(writer.session, `DELETE FROM ${qualified(dst, targetTable)}`)
      totals.deleted += Number(deleted.affectedRows ?? 0)
    }
    totals.inserted += await copyRows(ctx, item.source!.name, targetTable, item.columns)
  }

  // 8. orphans, then COMMIT
  report(job, { message: t('tools.align.checkingOrphans') })
  const found = await orphans(ctx, written)
  if (found.length) throw new Error(t('tools.align.orphans', { constraints: found.join(', ') }))
  st.committing = true
  await exec(writer.session, 'COMMIT')
  st.committing = false
  st.inTransaction = false
  return finish
}

/** SELECT 1 on the session; a KILL QUERY that reached it while idle may interrupt the first statement, so twice. */
async function alive(session: DbSession): Promise<boolean> {
  for (let i = 0; i < 2; i++) {
    try {
      await exec(session, 'SELECT 1')
      return true
    } catch (err) {
      if (errno(err) !== 1317) return false
    }
  }
  return false
}

/**
 * Back to the target as it was, every step tried on its own; returns the errors. Before the COMMIT the objects
 * created are dropped and the recreated or dropped ones come back from their definitions (tables from their
 * backup). After it the rows are final: only the triggers taken away come back, with the triggers and events
 * whose replacement from the source is missing.
 */
async function recover(ctx: Context, inv: Inventory, session: DbSession, committed: boolean): Promise<{ errors: string[]; objects: SourceObject[] }> {
  const errors: string[] = []
  const { label, same } = sideNames(ctx.lowerCaseNames)
  const dst = ctx.writer.schema
  const touched = (name: string): boolean => inv.touched.has(label(`${dst}.${name}`))
  const run = async (sql: string, object: string): Promise<void> => {
    try {
      await exec(session, sql)
    } catch (err) {
      errors.push(`${object || sql}: ${(err as Error).message}`)
      report(ctx.job, { log: t('tools.align.restoreFailed', { object: object || sql, error: (err as Error).message }) })
    }
  }
  let objects: SourceObject[]
  if (committed) {
    const present = await select(
      session,
      'SELECT TRIGGER_NAME AS name, \'trigger\' AS kind FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? UNION ALL SELECT EVENT_NAME, \'event\' FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ?',
      [dst, dst]
    ).catch((err: Error) => {
      errors.push(err.message)
      return [] as Row[]
    })
    const missing = inv.late.filter((o) => !present.some((p) => p.kind === o.kind && same(String(p.name), o.name)))
    objects = [...inv.restore, ...missing]
  } else {
    await run('SET FOREIGN_KEY_CHECKS = 0', '')
    for (const o of inv.created.filter((c) => touched(c.name))) await run(`DROP ${o.kind.toUpperCase()} IF EXISTS ${qualified(dst, o.name)}`, `${dst}.${o.name}`)
    const backedUp = new Set(inv.backups.map((b) => b.table))
    objects = inv.saved.filter((o) => touched(o.name) && (o.kind !== 'table' || backedUp.has(o.name)))
  }
  let kinds: Record<string, CopyKind> | undefined
  try {
    kinds = await targetKinds(session, [dst])
  } catch (err) {
    errors.push((err as Error).message)
  }
  if (kinds) for (const step of restoreSteps(ctx, inv, objects, kinds)) await run(step.sql, step.object)
  if (inv.collationAltered) await run(`ALTER DATABASE ${quoteIdentifier(dst)} COLLATE ${inv.collation}`, dst)
  return { errors, objects }
}

/** A failure after the inventory: recovery on a live connection that cannot be interrupted, then the job's error. */
async function afterFailure(ctx: Context, target: DbSession, inv: Inventory, st: ApplyState, err: unknown): Promise<never> {
  const { job, writer } = ctx
  // no KILL from now on, and the ones sent have reached the server before the recovery starts
  job.cancelers.clear()
  await Promise.allSettled(ctx.kills)
  const error = job.cancelled ? t('tools.cancelled') : (err as Error).message
  const fail = (message: string): never => {
    if (job.cancelled) job.cancelledMessage = message
    throw new Error(message)
  }

  let session: DbSession | undefined = writer.session
  // also after a COMMIT that failed: the recovery's DDL would commit a transaction left open
  if (st.inTransaction) {
    try {
      await exec(session, 'ROLLBACK')
    } catch {
      // the connection may hold the transaction still: killed, the server rolls it back
      const id = await writer.session.auxThreadId()
      await writer.session.execute(`KILL ${id}`)
      writer.session.close()
      session = undefined
    }
  }
  if (session && !(await alive(session))) session = undefined
  // the COMMIT was sent and the connection is gone: the rows may be written or not, so nothing is put back
  if (st.committing && !session) fail(t('tools.align.commitUnknown', { error, file: inv.file }))

  report(job, { message: t('tools.align.recovering'), log: t('tools.align.recovering') })
  let errors: string[]
  let objects: SourceObject[] = []
  try {
    if (!session) {
      const fresh = await openPinned(target)
      ctx.sessions.push(fresh)
      // the lock of the target's alignments, released with the lost connection
      const [lock] = await select(fresh, 'SELECT GET_LOCK(?, 10) AS l', [lockName(writer.schema, ctx.lowerCaseNames)])
      if (Number(lock.l) !== 1) throw new Error(t('tools.align.busy', { schema: writer.schema }))
      session = fresh
    }
    ;({ errors, objects } = await recover(ctx, inv, session, st.committed))
  } catch (e) {
    errors = [(e as Error).message]
  }
  const left = session && !errors.length ? await dropBackups(ctx, inv, session) : inv.backups.map((b) => b.copy)
  if (st.committed) {
    if (!errors.length && !left.length) {
      await rm(inv.file, { force: true })
      fail(t('tools.align.failedAfterCommit', { error }))
    }
    // the script holds what is still missing, not the tables: their rows are committed
    await writeRecoveryFile(ctx, inv, objects).catch(() => undefined)
    fail(t('tools.align.recoveryNeededAfterCommit', { error, file: inv.file }))
  }
  if (errors.length || left.length) fail(t('tools.align.recoveryNeeded', { error, file: inv.file }))
  await rm(inv.file, { force: true })
  return fail(error)
}

export function alignApply(job: Job, source: DbSession, target: DbSession, r: AlignRequest): Promise<string> {
  return withSessions(job, source, target, r, true, async (ctx) => {
    const { writer } = ctx
    const dst = writer.schema
    // 1. inspect (rows of syncRows tables are walked while writing)
    const items = await inspect(ctx, false)
    report(job, { preview: preview(ctx, items) })

    // 2. confirmation of what deletes rows with an implicit commit
    const confirmed = new Set([
      ...(r.confirmed?.recreate ?? []).map((o) => `recreate\u0000${refKey(ctx, o.kind, o.name)}`),
      ...(r.confirmed?.drop ?? []).map((o) => `drop\u0000${refKey(ctx, o.kind, o.name)}`)
    ])
    if (items.some((i) => isTableChange(i) && !confirmed.has(`${i.diff.action}\u0000${refKey(ctx, i.kind, i.name)}`))) {
      throw new NeedsConfirmation(t('tools.align.needsConfirmation'))
    }

    // 3. preflight
    await preflight(ctx, items)

    const [info] = await select(writer.session, 'SELECT DEFAULT_COLLATION_NAME AS c FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [dst])
    const inv: Inventory = {
      saved: [],
      restore: [],
      late: [],
      created: [],
      backups: [],
      file: '',
      touched: new Set(),
      collationAltered: false,
      collation: String(info.c),
      createDatabase: ''
    }
    // 4. inventory and backups: a failure here drops the backups made and changes nothing else
    await takeInventory(ctx, items, inv)

    const st: ApplyState = { inTransaction: false, committing: false, committed: false, totals: { created: 0, recreated: 0, dropped: 0, inserted: 0, updated: 0, deleted: 0 } }
    try {
      const finish = await writeTarget(ctx, items, inv, st)
      st.committed = true
      // 9. triggers and events of the source, then the triggers taken away
      await runSteps(ctx, inv, finish)
      await runSteps(ctx, inv, restoreSteps(ctx, inv, inv.restore))
    } catch (err) {
      return afterFailure(ctx, target, inv, st, err)
    }
    const left = await dropBackups(ctx, inv, writer.session)
    if (left.length) return t('tools.align.doneBackupsLeft', { ...st.totals, tables: left.join(', '), file: inv.file })
    await rm(inv.file, { force: true })
    return t('tools.align.done', { ...st.totals })
  })
}
