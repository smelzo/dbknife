// Copy Database (MySQL/MariaDB): turns the SHOW CREATE … text of the source
// objects into the ordered statements that rebuild them on the target, with
// schemas renamed, DEFINER and collations handled. Rewriting works on lexer
// tokens, so strings and comments are never mistaken for names. The job
// (copy-mysql.ts) copies the data between `structure` and `finish`.

import { significantTokens, tokenize, unquoteIdentifier, type Token } from './lexer'
import { qualified, quoteIdentifier, quoteString } from './quote'

export type CopyKind = 'table' | 'sequence' | 'view' | 'procedure' | 'function' | 'trigger' | 'event'

/** TABLE_TYPE of information_schema.TABLES → the kind copied or aligned; other types are left out. */
export const tableTypeKinds: Record<string, CopyKind | undefined> = { 'BASE TABLE': 'table', VIEW: 'view', SEQUENCE: 'sequence' }

export interface SourceObject {
  kind: CopyKind
  schema: string
  name: string
  /** SHOW CREATE … text, as read with `USE schema` (see copy-mysql.ts). */
  ddl: string
  sqlMode?: string
  timeZone?: string // events
  collationConnection?: string // views, routines, triggers, events
  databaseCollation?: string // routines, triggers, events
}

export interface PlanInput {
  /** Source schema → its SHOW CREATE DATABASE text. */
  schemas: { name: string; ddl: string; collation: string }[]
  objects: SourceObject[]
  /** Source schema → target schema (every source schema is a key). */
  rename: Record<string, string>
  definers: 'keep' | 'remove'
  existing: 'stop' | 'recreate'
  structureOnly: boolean
  /** Source collation → target collation (lowercase keys). */
  collations: Record<string, string>
  /** Kinds already in the target, `schema.name` → 'table' | 'view' | …; absent for a file target. */
  targetKinds?: Record<string, CopyKind>
}

export interface PlanStep {
  sql: string
  /** Body with `;` inside: a script file wraps it in DELIMITER ;; */
  compound: boolean
  /** `schema.name` for the log and the error message; empty for session statements. */
  object: string
}

export type PlanWarning =
  | { code: 'qualifiedReference'; object: string } // routine/trigger/event body naming a renamed schema
  | { code: 'externalSchema'; object: string; schema: string } // view using a schema outside the copy
  | { code: 'viewCycle'; objects: string[] }

export interface CopyPlan {
  /** Up to the views included; the data goes after these. */
  structure: PlanStep[]
  /** Triggers, events, final reset. */
  finish: PlanStep[]
  warnings: PlanWarning[]
}

const objectKeywords = new Set(['VIEW', 'PROCEDURE', 'FUNCTION', 'TRIGGER', 'EVENT'])
const compoundKinds = new Set<CopyKind>(['procedure', 'function', 'trigger', 'event'])
const relationKinds = new Set<CopyKind>(['table', 'sequence', 'view'])
const systemSchemas = new Set(['mysql', 'information_schema', 'performance_schema', 'sys'])

const isName = (t: Token | undefined): boolean => t?.type === 'word' || t?.type === 'quoted'
const isSymbol = (t: Token | undefined, s: string): boolean => t?.type === 'symbol' && t.text === s
const isWord = (t: Token | undefined, w: string): boolean => t?.type === 'word' && t.text.toUpperCase() === w
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

interface Edit {
  start: number
  end: number
  text: string
}

function applyEdits(src: string, edits: Edit[]): string {
  let out = ''
  let pos = 0
  for (const e of [...edits].sort((a, b) => a.start - b.start)) {
    out += src.slice(pos, e.start) + e.text
    pos = e.end
  }
  return out + src.slice(pos)
}

interface RewriteOptions {
  rename: Record<string, string>
  collations: Record<string, string>
  definers: 'keep' | 'remove'
  /** Drop the AUTO_INCREMENT=n table option (not the column attribute). */
  autoIncrement: boolean
}

/** Index of the last token of the account `user@host` starting at `i`. */
function accountEnd(sig: Token[], i: number): number {
  const at = sig[i + 1]
  if (at?.type !== 'word' || !at.text.startsWith('@')) return i // user@host as one word, or CURRENT_USER
  return at.text === '@' ? i + 2 : i + 1
}

/** The token with its collation mapped, keeping its quoting; undefined when it is not a mapped collation. */
function mappedCollation(t: Token, collations: Record<string, string>): string | undefined {
  if (t.type !== 'word' && t.type !== 'quoted' && t.type !== 'string') return undefined
  const name = t.type === 'string' ? t.text.slice(1, -1) : unquoteIdentifier(t.text)
  const to = collations[name.toLowerCase()]
  if (to === undefined) return undefined
  return t.type === 'string' ? quoteString(to) : t.type === 'quoted' ? quoteIdentifier(to) : to
}

/** Rewrites one DDL text; `renamed` tells whether a schema qualifier changed. */
function rewrite(ddl: string, o: RewriteOptions): { sql: string; renamed: boolean } {
  const sig = significantTokens(ddl)
  const edits: Edit[] = []
  let renamed = false
  let header = true // DEFINER only counts before the object keyword
  for (let i = 0; i < sig.length; i++) {
    const t = sig[i]
    const from = i > 0 ? sig[i - 1].end : t.start // removals take the space before them
    if (header && o.definers === 'remove' && isWord(t, 'DEFINER') && isSymbol(sig[i + 1], '=')) {
      const end = accountEnd(sig, i + 2)
      edits.push({ start: from, end: sig[end].end, text: '' })
      i = end
    } else if (o.autoIncrement && isWord(t, 'AUTO_INCREMENT') && isSymbol(sig[i + 1], '=') && sig[i + 2]?.type === 'number') {
      edits.push({ start: from, end: sig[i + 2].end, text: '' })
      i += 2
    } else if (isName(t) && isSymbol(sig[i + 1], '.') && !isSymbol(sig[i - 1], '.')) {
      const name = unquoteIdentifier(t.text)
      const to = o.rename[name]
      if (to !== undefined && to !== name) {
        edits.push({ start: t.start, end: t.end, text: quoteIdentifier(to) })
        renamed = true
      }
    } else {
      if (t.type === 'word' && objectKeywords.has(t.text.toUpperCase())) header = false
      const collation = mappedCollation(t, o.collations)
      if (collation !== undefined) edits.push({ start: t.start, end: t.end, text: collation })
    }
  }
  // executable comments, such as the /*!40100 … COLLATE … */ of SHOW CREATE DATABASE
  for (const t of tokenize(ddl)) {
    const head = t.type === 'comment' ? /^\/\*!\d*/.exec(t.text)?.[0] : undefined
    if (!head || !t.text.endsWith('*/')) continue
    const inner = rewrite(t.text.slice(head.length, -2), o)
    edits.push({ start: t.start, end: t.end, text: head + inner.sql + '*/' })
    renamed ||= inner.renamed
  }
  return { sql: applyEdits(ddl, edits), renamed }
}

/** The object's DDL as the target would hold it (schemas renamed, DEFINER handled, AUTO_INCREMENT=n dropped), for comparisons. */
export function normalizedDefinition(o: SourceObject, rename: Record<string, string>, definers: 'keep' | 'remove'): string {
  return rewrite(o.ddl, { rename, collations: {}, definers, autoIncrement: o.kind === 'table' }).sql
}

/** SHOW CREATE DATABASE text for the target name, with IF NOT EXISTS when asked. */
function createDatabase(ddl: string, target: string, ifNotExists: boolean, o: RewriteOptions): string {
  const sql = rewrite(ddl, o).sql
  const sig = significantTokens(sql)
  const i = sig.findIndex((t) => isWord(t, 'DATABASE') || isWord(t, 'SCHEMA'))
  return applyEdits(sql, [
    { start: sig[i].end, end: sig[i].end, text: ifNotExists ? ' IF NOT EXISTS' : '' },
    { start: sig[i + 1].start, end: sig[i + 1].end, text: quoteIdentifier(target) }
  ])
}

/** Tokens of the query of a CREATE VIEW: after the first top-level AS following VIEW. */
function viewQuery(ddl: string): Token[] {
  const sig = significantTokens(ddl)
  let depth = 0
  for (let i = sig.findIndex((t) => isWord(t, 'VIEW')) + 1; i > 0 && i < sig.length; i++) {
    if (isSymbol(sig[i], '(')) depth++
    else if (isSymbol(sig[i], ')')) depth--
    else if (depth === 0 && isWord(sig[i], 'AS')) return sig.slice(i + 1)
  }
  return []
}

/** Dotted name sequences `a(.b)*`, with whether a `(` follows (a function call). */
function nameChains(sig: Token[]): { parts: string[]; call: boolean }[] {
  const chains: { parts: string[]; call: boolean }[] = []
  for (let i = 0; i < sig.length; i++) {
    if (!isName(sig[i])) continue
    const parts = [unquoteIdentifier(sig[i].text)]
    while (isSymbol(sig[i + 1], '.') && isName(sig[i + 2])) {
      parts.push(unquoteIdentifier(sig[i + 2].text))
      i += 2
    }
    chains.push({ parts, call: isSymbol(sig[i + 1], '(') })
  }
  return chains
}

/**
 * Candidate tables and views a view uses. A deliberate over-approximation:
 * `a.b` may be schema.table or table.column, so both readings are returned.
 */
export function viewReferences(ddl: string, schema: string): { schema: string; name: string }[] {
  const refs: { schema: string; name: string }[] = []
  for (const { parts, call } of nameChains(viewQuery(ddl))) {
    if (call) continue
    if (parts.length === 1) refs.push({ schema, name: parts[0] })
    else if (parts.length === 2) refs.push({ schema: parts[0], name: parts[1] }, { schema, name: parts[0] })
    else refs.push({ schema: parts[0], name: parts[1] })
  }
  return refs
}

/**
 * Schemas a view names. A qualifier is a schema unless the same name also
 * stands alone (a table or alias) or follows a dot (a table qualifying its columns).
 */
function viewSchemas(ddl: string): string[] {
  const chains = nameChains(viewQuery(ddl))
  const others = new Set(chains.flatMap((c) => (c.parts.length === 1 ? c.parts : c.parts.slice(1))))
  const qualifiers = chains.filter((c) => c.parts.length > 1).map((c) => c.parts[0])
  return [...new Set(qualifiers)].filter((q) => !others.has(q))
}

/** Views in dependency order (by level, by `schema.name` within a level); the ones left in a cycle apart. */
function viewOrder(views: SourceObject[]): { order: SourceObject[]; cycle: SourceObject[] } {
  const byKey = new Map(views.map((v) => [`${v.schema}.${v.name}`, v]))
  const deps = new Map(
    views.map((v) => [
      v,
      viewReferences(v.ddl, v.schema)
        .map((r) => byKey.get(`${r.schema}.${r.name}`))
        .filter((d): d is SourceObject => d !== undefined && d !== v)
    ])
  )
  const done = new Set<SourceObject>()
  let rest = [...views].sort((a, b) => byText(`${a.schema}.${a.name}`, `${b.schema}.${b.name}`))
  for (;;) {
    const level = rest.filter((v) => deps.get(v)!.every((d) => done.has(d)))
    if (level.length === 0) return { order: [...done], cycle: rest }
    for (const v of level) done.add(v)
    rest = rest.filter((v) => !done.has(v))
  }
}

/** NO_AUTO_CREATE_USER acts on GRANT only and MySQL 8.0 rejects it (MariaDB's default sql_mode has it). */
const withoutNoAutoCreateUser = (mode: string): string =>
  mode
    .split(',')
    .filter((m) => m.toUpperCase() !== 'NO_AUTO_CREATE_USER')
    .join(',')

/** Steps with the session state they leave, so USE and SET are emitted only when they change. */
class StepList {
  readonly steps: PlanStep[] = []
  private readonly env: { schema?: string; sqlMode?: string; collation?: string; timeZone?: string } = {}

  add(sql: string, object = '', compound = false): void {
    this.steps.push({ sql, compound, object })
  }

  enter(schema: string, o: { sqlMode?: string; collation?: string; timeZone?: string } = {}): void {
    if (this.env.schema !== schema) this.add(`USE ${quoteIdentifier(schema)}`)
    this.env.schema = schema
    this.set('sqlMode', 'sql_mode', o.sqlMode && withoutNoAutoCreateUser(o.sqlMode))
    this.set('collation', 'collation_connection', o.collation)
    this.set('timeZone', 'time_zone', o.timeZone)
  }

  private set(key: 'sqlMode' | 'collation' | 'timeZone', variable: string, value: string | undefined): void {
    if (value === undefined || this.env[key] === value) return
    this.add(`SET ${variable} = ${quoteString(value)}`)
    this.env[key] = value
  }
}

export function buildCopyPlan(input: PlanInput): CopyPlan {
  const warnings: PlanWarning[] = []
  const recreate = input.existing === 'recreate'
  const target = (schema: string): string => input.rename[schema] ?? schema
  const collation = (c: string): string => input.collations[c.toLowerCase()] ?? c
  const schemaCollation = new Map(input.schemas.map((s) => [s.name, collation(s.collation)]))
  const options = (kind: CopyKind): RewriteOptions => ({
    rename: input.rename,
    collations: input.collations,
    definers: input.definers,
    autoIncrement: input.structureOnly && kind === 'table'
  })
  const label = (o: SourceObject): string => `${target(o.schema)}.${o.name}`
  const inSchemas = (...kinds: CopyKind[]): SourceObject[] =>
    input.schemas.flatMap((s) => input.objects.filter((o) => o.schema === s.name && kinds.includes(o.kind)))
  /** Kind of the relation of the same name in the target; for a file, the object's own. */
  const existingRelation = (o: SourceObject): CopyKind | undefined => {
    if (!input.targetKinds) return o.kind
    const kind = input.targetKinds[label(o)]
    return kind && relationKinds.has(kind) ? kind : undefined
  }

  const create = (steps: StepList, o: SourceObject, drop: CopyKind | undefined): void => {
    const schema = target(o.schema)
    const object = label(o)
    steps.enter(schema, { sqlMode: o.sqlMode, collation: o.collationConnection && collation(o.collationConnection), timeZone: o.timeZone })
    if (drop) steps.add(`DROP ${drop.toUpperCase()} IF EXISTS ${qualified(schema, o.name)}`, object)
    // variables and parameters without COLLATE take the database collation at creation time
    const own = schemaCollation.get(o.schema)
    const original = o.databaseCollation && collation(o.databaseCollation)
    const alter = !!original && !!own && original.toLowerCase() !== own.toLowerCase()
    if (alter) steps.add(`ALTER DATABASE ${quoteIdentifier(schema)} COLLATE ${original}`, object)
    const { sql, renamed } = rewrite(o.ddl, options(o.kind))
    steps.add(sql, object, compoundKinds.has(o.kind))
    if (alter) steps.add(`ALTER DATABASE ${quoteIdentifier(schema)} COLLATE ${own}`, object)
    if (renamed && compoundKinds.has(o.kind)) warnings.push({ code: 'qualifiedReference', object: `${o.schema}.${o.name}` })
  }

  const structure = new StepList()
  structure.add('SET @dbm_old_sql_mode = @@sql_mode, @dbm_old_collation = @@collation_connection, @dbm_old_time_zone = @@time_zone')
  structure.add('SET NAMES utf8mb4')
  structure.add('SET FOREIGN_KEY_CHECKS = 0')
  structure.add('SET UNIQUE_CHECKS = 0')
  for (const s of input.schemas) {
    structure.add(createDatabase(s.ddl, target(s.name), recreate, options('table')), target(s.name))
    structure.enter(target(s.name))
  }
  for (const s of input.schemas) {
    const tables = input.objects.filter((o) => o.schema === s.name && (o.kind === 'table' || o.kind === 'sequence'))
    for (const t of tables.sort((a, b) => byText(a.name, b.name))) create(structure, t, recreate ? existingRelation(t) : undefined)
  }
  for (const r of inSchemas('function', 'procedure')) create(structure, r, recreate ? r.kind : undefined)

  const { order, cycle } = viewOrder(inSchemas('view'))
  if (cycle.length) warnings.push({ code: 'viewCycle', objects: cycle.map((v) => `${v.schema}.${v.name}`) })
  for (const v of [...order, ...cycle]) {
    for (const schema of viewSchemas(v.ddl)) {
      if (!Object.hasOwn(input.rename, schema) && !systemSchemas.has(schema.toLowerCase())) {
        warnings.push({ code: 'externalSchema', object: `${v.schema}.${v.name}`, schema })
      }
    }
    create(structure, v, recreate ? (existingRelation(v) ?? 'view') : undefined)
  }

  // a fresh state: the data copy in between may have changed the session
  const finish = new StepList()
  for (const o of [...inSchemas('trigger'), ...inSchemas('event')]) create(finish, o, recreate ? o.kind : undefined)
  finish.add('SET FOREIGN_KEY_CHECKS = 1')
  finish.add('SET UNIQUE_CHECKS = 1')
  finish.add('SET sql_mode = @dbm_old_sql_mode, collation_connection = @dbm_old_collation, time_zone = @dbm_old_time_zone')

  return { structure: structure.steps, finish: finish.steps, warnings }
}
