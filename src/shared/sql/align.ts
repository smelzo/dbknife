// Alignment (MySQL/MariaDB): compares the structure of two tables, decides the
// action for each object and builds the statements the job (main) runs to read
// and write rows. Pure logic: the main reads information_schema and SHOW CREATE.
// In doubt a comparison says "different": a false "different" costs a
// recreation, a false "same" leaves the target misaligned without saying it.

import type { AlignAction, AlignKind, AlignNote, AlignOptions, AlignStatus } from '../types'
import { normalizedDefinition } from './copy-plan'
import { significantTokens } from './lexer'
import { quoteIdentifier, toHex } from './quote'

export type Flavor = 'mysql' | 'mariadb'

/** One row of information_schema.COLUMNS. */
export interface ColumnShape {
  name: string // COLUMN_NAME
  position: number // ORDINAL_POSITION
  type: string // COLUMN_TYPE
  nullable: string // IS_NULLABLE: YES | NO
  default: string | null // COLUMN_DEFAULT
  extra: string // EXTRA
  collation: string | null // COLLATION_NAME
  generation: string | null // GENERATION_EXPRESSION: '' (MySQL) or NULL (MariaDB) when not generated
  comment: string // COLUMN_COMMENT
  srsId?: number | null // SRS_ID, MySQL only
}

/** One row of information_schema.STATISTICS (one per column of an index). */
export interface IndexPart {
  name: string // INDEX_NAME
  nonUnique: number | string // NON_UNIQUE
  seq: number // SEQ_IN_INDEX
  column: string | null // COLUMN_NAME, NULL for a functional part
  subPart: number | null // SUB_PART
  type: string // INDEX_TYPE
  collation: string | null // COLLATION: A | D
  expression?: string | null // EXPRESSION, MySQL only
  comment: string // INDEX_COMMENT
  visible: boolean // IS_VISIBLE = 'YES' (MySQL), IGNORED = 'NO' (MariaDB)
}

export interface ForeignKeyShape {
  name: string
  columns: string[]
  refSchema: string
  refTable: string
  refColumns: string[]
  updateRule: string
  deleteRule: string
}

export interface CheckShape {
  name: string
  clause: string // CHECK_CLAUSE
  enforced: boolean // TABLE_CONSTRAINTS.ENFORCED (MySQL); always true on MariaDB
}

/** information_schema.TABLES. */
export interface TableOptions {
  engine: string | null // ENGINE
  collation: string | null // TABLE_COLLATION
  createOptions: string // CREATE_OPTIONS
  comment: string // TABLE_COMMENT
}

export interface TableShape {
  columns: ColumnShape[]
  indexes: IndexPart[]
  foreignKeys: ForeignKeyShape[]
  checks: CheckShape[]
  table: TableOptions
  flavor: Flavor
  /** SHOW CREATE TABLE text. */
  createTable: string
}

// --- normalization between flavors ---

/** A column computed by the server; DEFAULT_GENERATED (MySQL) is only a default expression. */
export const isGenerated = (extra: string): boolean => /\b(VIRTUAL|STORED|PERSISTENT) GENERATED\b/i.test(extra)

export const hasOnUpdate = (extra: string): boolean => /\bon update\b/i.test(extra)

/**
 * Tokens of an information_schema expression, comparable between MySQL and MariaDB: MySQL escapes,
 * `_charset` introducers and one pair of parentheses around the whole expression removed, words
 * lowercased, CURRENT_TIMESTAMP / CURRENT_TIMESTAMP() / NOW() of the same precision written alike.
 * Strings and quoted identifiers stay as they are.
 */
export function exprTokens(text: string, flavor: Flavor): string[] {
  const src = flavor === 'mysql' ? text.replace(/\\(['\\])/g, '$1') : text
  const sig = significantTokens(src)
  const out: string[] = []
  for (let i = 0; i < sig.length; i++) {
    const t = sig[i]
    // MySQL adds the introducer on its own; MariaDB only keeps one that was written
    if (flavor === 'mysql' && t.type === 'word' && /^_[a-z0-9]+$/i.test(t.text) && sig[i + 1]?.type === 'string') continue
    if (t.type !== 'word') {
      out.push(t.text)
      continue
    }
    const word = t.text.toLowerCase()
    const open = sig[i + 1]?.type === 'symbol' && sig[i + 1].text === '('
    if (word === 'current_timestamp' || (word === 'now' && open)) {
      let precision = '0'
      if (open && sig[i + 2]?.text === ')') i += 2
      else if (open && sig[i + 2]?.type === 'number' && sig[i + 3]?.text === ')') {
        precision = String(Number(sig[i + 2].text))
        i += 3
      } else if (open) {
        out.push(word) // an argument that is not a precision: left as it is
        continue
      }
      out.push(`current_timestamp(${precision})`)
      continue
    }
    out.push(word)
  }
  return stripOuterParens(out)
}

/** Without the parentheses around the whole expression, once: `(a) + (b)` keeps them. */
function stripOuterParens(tokens: string[]): string[] {
  if (tokens[0] !== '(' || tokens[tokens.length - 1] !== ')') return tokens
  let depth = 0
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '(') depth++
    else if (tokens[i] === ')' && --depth === 0) return i === tokens.length - 1 ? tokens.slice(1, -1) : tokens
  }
  return tokens
}

const sameTokens = (a: string[], b: string[]): boolean => a.length === b.length && a.every((t, i) => t === b[i])

/** COLUMN_TYPE without the display width of integers (MariaDB writes int(11), MySQL 8 int), except tinyint(1) and zerofill. */
function columnType(type: string): string {
  const m = /^(tinyint|smallint|mediumint|int|bigint)\(\d+\)(.*)$/i.exec(type)
  if (!m || /zerofill/i.test(m[2]) || /^tinyint\(1\)/i.test(type)) return type
  return m[1] + m[2]
}

type ColumnDefault = { kind: 'null' } | { kind: 'literal'; value: string } | { kind: 'expr'; tokens: string[] }

function columnDefault(c: ColumnShape, flavor: Flavor): ColumnDefault {
  const v = c.default
  if (flavor === 'mysql') {
    if (v === null) return { kind: 'null' }
    if (/\bDEFAULT_GENERATED\b/i.test(c.extra)) return { kind: 'expr', tokens: exprTokens(v, flavor) }
    return { kind: 'literal', value: v }
  }
  if (v === null || v === 'NULL') return { kind: 'null' }
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v)) return { kind: 'literal', value: v }
  const quoted = mariadbString(v)
  return quoted !== undefined ? { kind: 'literal', value: quoted } : { kind: 'expr', tokens: exprTokens(v, flavor) }
}

/** MySQL string escapes: \% and \_ keep their backslash, any other \x not listed is x. */
const stringEscapes: Record<string, string> = { '0': '\0', b: '\b', n: '\n', r: '\r', t: '\t', Z: '\x1a', '%': '\\%', _: '\\_' }

/** Value of a MariaDB default written as one quoted string, with '' and the backslash escapes resolved; undefined when it is not one. */
function mariadbString(v: string): string | undefined {
  const sig = significantTokens(v)
  if (sig.length !== 1 || sig[0].type !== 'string' || !v.startsWith("'") || sig[0].text !== v) return undefined
  return v.slice(1, -1).replace(/''|\\([\s\S])/g, (_, c: string | undefined) => (c === undefined ? "'" : (stringEscapes[c] ?? c)))
}

const sameDefault = (a: ColumnDefault, b: ColumnDefault): boolean =>
  a.kind === 'null'
    ? b.kind === 'null'
    : a.kind === 'literal'
      ? b.kind === 'literal' && a.value === b.value
      : b.kind === 'expr' && sameTokens(a.tokens, b.tokens)

/** GENERATION_EXPRESSION as tokens, null for a column that is not generated. */
const generation = (c: ColumnShape, flavor: Flavor): string[] | null => (c.generation ? exprTokens(c.generation, flavor) : null)

/** EXTRA without DEFAULT_GENERATED, its ON UPDATE written alike. */
const extraTokens = (c: ColumnShape, flavor: Flavor): string[] => exprTokens(c.extra.replace(/\bDEFAULT_GENERATED\b/gi, ''), flavor)

// --- table comparison ---

type Value = string | number | null | undefined

/** Equal values; null and undefined only equal each other. */
const same = (a: Value, b: Value): boolean => (a ?? null) === (b ?? null) || (a != null && b != null && String(a) === String(b))
const shown = (v: Value): string => (v == null ? 'NULL' : String(v))

const byName = <T extends { name: string }>(items: T[]): Map<string, T> => new Map(items.map((x) => [x.name, x]))

function indexMap(parts: IndexPart[]): Map<string, IndexPart[]> {
  const map = new Map<string, IndexPart[]>()
  for (const p of parts) map.set(p.name, [...(map.get(p.name) ?? []), p])
  for (const list of map.values()) list.sort((a, b) => a.seq - b.seq)
  return map
}

/** Notes from the information_schema fields; `cross`: different flavors, fields normalized. */
function fieldNotes(source: TableShape, target: TableShape, rename: Record<string, string>, cross: boolean): AlignNote[] {
  const notes: AlignNote[] = []
  const sf = source.flavor
  const tf = target.flavor

  // columns
  const tCols = byName(target.columns)
  const sCols = byName(source.columns)
  for (const c of source.columns) if (!tCols.has(c.name)) notes.push({ code: 'columnOnlyIn', params: { column: c.name, side: 'source' } })
  for (const c of target.columns) if (!sCols.has(c.name)) notes.push({ code: 'columnOnlyIn', params: { column: c.name, side: 'target' } })
  // MariaDB has no SRID on a column: a MySQL one cannot be said equal
  if (cross) {
    for (const side of [source, target]) {
      if (side.flavor === 'mysql') for (const c of side.columns) if (c.srsId != null) notes.push({ code: 'spatialSrid', params: { column: c.name } })
    }
  }
  // order among the columns of both sides: a column only on one side does not move the others
  const order = (cols: ColumnShape[], other: Map<string, ColumnShape>): string[] =>
    [...cols].sort((a, b) => a.position - b.position).filter((c) => other.has(c.name)).map((c) => c.name)
  const sOrder = order(source.columns, tCols)
  const tOrder = order(target.columns, sCols)
  for (const s of source.columns) {
    const t = tCols.get(s.name)
    if (!t) continue
    const differs = (property: string, a: Value, b: Value): void => {
      notes.push({ code: 'columnDiffers', params: { column: s.name, property, source: shown(a), target: shown(b) } })
    }
    if (sOrder.indexOf(s.name) !== tOrder.indexOf(s.name)) differs('ORDINAL_POSITION', s.position, t.position)
    if (cross ? columnType(s.type) !== columnType(t.type) : s.type !== t.type) differs('COLUMN_TYPE', s.type, t.type)
    if (s.nullable !== t.nullable) differs('IS_NULLABLE', s.nullable, t.nullable)
    if (cross ? !sameDefault(columnDefault(s, sf), columnDefault(t, tf)) : !same(s.default, t.default)) differs('COLUMN_DEFAULT', s.default, t.default)
    if (cross ? !sameTokens(extraTokens(s, sf), extraTokens(t, tf)) : s.extra !== t.extra) differs('EXTRA', s.extra, t.extra)
    if (!same(s.collation, t.collation)) differs('COLLATION_NAME', s.collation, t.collation)
    const sg = cross ? generation(s, sf) : s.generation
    const tg = cross ? generation(t, tf) : t.generation
    const genSame = cross ? (sg === null ? tg === null : tg !== null && sameTokens(sg as string[], tg as string[])) : same(s.generation, t.generation)
    if (!genSame) differs('GENERATION_EXPRESSION', s.generation, t.generation)
    if (s.comment !== t.comment) differs('COLUMN_COMMENT', s.comment, t.comment)
    if (!cross && !same(s.srsId, t.srsId)) differs('SRS_ID', s.srsId, t.srsId)
  }

  // indexes
  const sIdx = indexMap(source.indexes)
  const tIdx = indexMap(target.indexes)
  for (const name of new Set([...sIdx.keys(), ...tIdx.keys()])) {
    const a = sIdx.get(name)
    const b = tIdx.get(name)
    if (cross && [a, b].some((parts, i) => [sf, tf][i] === 'mysql' && parts?.some((p) => p.expression != null))) {
      notes.push({ code: 'functionalIndex', params: { index: name } })
      continue
    }
    const samePart = (p: IndexPart, q: IndexPart): boolean =>
      same(p.column, q.column) && same(p.subPart, q.subPart) && same(p.collation, q.collation) && same(p.expression, q.expression) &&
      p.comment === q.comment && p.visible === q.visible
    const equal =
      !!a &&
      !!b &&
      a.length === b.length &&
      same(a[0].nonUnique, b[0].nonUnique) &&
      a[0].type === b[0].type &&
      a.every((p, i) => samePart(p, b[i]))
    if (!equal) notes.push({ code: 'indexDiffers', params: { index: name } })
  }

  // foreign keys: one to the source schema must point to the target schema
  const sFk = byName(source.foreignKeys)
  const tFk = byName(target.foreignKeys)
  const list = (xs: string[]): string => xs.join('\u0000')
  for (const name of new Set([...sFk.keys(), ...tFk.keys()])) {
    const a = sFk.get(name)
    const b = tFk.get(name)
    const equal =
      !!a &&
      !!b &&
      list(a.columns) === list(b.columns) &&
      (rename[a.refSchema] ?? a.refSchema) === b.refSchema &&
      a.refTable === b.refTable &&
      list(a.refColumns) === list(b.refColumns) &&
      a.updateRule === b.updateRule &&
      a.deleteRule === b.deleteRule
    if (!equal) notes.push({ code: 'foreignKeyDiffers', params: { name } })
  }

  // checks
  const sChk = byName(source.checks)
  const tChk = byName(target.checks)
  for (const name of new Set([...sChk.keys(), ...tChk.keys()])) {
    const a = sChk.get(name)
    const b = tChk.get(name)
    const equal =
      !!a && !!b && a.enforced === b.enforced && (cross ? sameTokens(exprTokens(a.clause, sf), exprTokens(b.clause, tf)) : a.clause === b.clause)
    if (!equal) notes.push({ code: 'checkDiffers', params: { name } })
  }

  // table options
  const options: [string, Value, Value][] = [
    ['ENGINE', source.table.engine, target.table.engine],
    ['TABLE_COLLATION', source.table.collation, target.table.collation],
    ['CREATE_OPTIONS', source.table.createOptions, target.table.createOptions],
    ['TABLE_COMMENT', source.table.comment, target.table.comment]
  ]
  for (const [property, a, b] of options) if (!same(a, b)) notes.push({ code: 'tableOptionDiffers', params: { property } })
  // partitions are not described by these fields
  if (cross && [source, target].some((s) => /\bpartitioned\b/i.test(s.table.createOptions))) notes.push({ code: 'partitioned' })
  return notes
}

/**
 * Structure differences of two tables of the same name; empty = same structure. With the same flavor the
 * SHOW CREATE TABLE texts decide (they hold everything); between MySQL and MariaDB the normalized fields.
 * `rename`: source schema → target schema.
 */
export function compareTables(source: TableShape, target: TableShape, rename: Record<string, string>): AlignNote[] {
  if (source.flavor !== target.flavor) return fieldNotes(source, target, rename, true)
  const definition = (s: TableShape, r: Record<string, string>): string =>
    normalizedDefinition({ kind: 'table', schema: '', name: '', ddl: s.createTable }, r, 'keep')
  if (definition(source, rename) === definition(target, {})) return []
  const notes = fieldNotes(source, target, rename, false)
  return notes.length ? notes : [{ code: 'definitionDiffers' }]
}

// --- actions ---

/**
 * Action for one object with the request's options (table "Azione per oggetto" of the plan). `status` here is the
 * presence (sourceOnly, targetOnly, or same/different for an object on both sides, decided by `structureDiffers`).
 */
export function alignAction(
  input: { status: AlignStatus; kind: AlignKind; structureDiffers: boolean; hasKey: boolean; inDrop: boolean },
  options: AlignOptions
): { action: AlignAction; notes: AlignNote[] } {
  const result = (action: AlignAction, code?: string): { action: AlignAction; notes: AlignNote[] } => ({ action, notes: code ? [{ code }] : [] })
  const { structure, data } = options
  const table = input.kind === 'table'
  if (input.status === 'sourceOnly') return result(structure ? 'create' : 'skip')
  if (input.status === 'targetOnly') return result(!input.inDrop ? 'none' : structure ? 'drop' : 'skip')
  if (input.structureDiffers) {
    if (!table) return result(structure ? 'recreate' : 'skip')
    if (structure && data) return result('recreate')
    return structure ? result('skip', 'wouldLoseRows') : result('skip', 'structureDiffers')
  }
  if (table && data) return result(input.hasKey ? 'syncRows' : 'replaceRows')
  return result('none')
}

// --- keys, queries and statements ---

/** The PRIMARY key, else the first UNIQUE index (by name) on NOT NULL columns without prefixes or expressions. */
export function tableKey(columns: ColumnShape[], indexes: IndexPart[]): string[] | null {
  const map = indexMap(indexes)
  const primary = map.get('PRIMARY')
  if (primary) return primary.every((p) => p.column != null) ? primary.map((p) => p.column!) : null
  const notNull = new Set(columns.filter((c) => c.nullable === 'NO').map((c) => c.name))
  const names = [...map.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  for (const name of names) {
    const parts = map.get(name)!
    if (String(parts[0].nonUnique) !== '0') continue
    if (parts.every((p) => p.column != null && notNull.has(p.column) && p.subPart == null && p.expression == null)) return parts.map((p) => p.column!)
  }
  return null
}

/** Rows after the last read key, in key order: `(a > ? OR (a = ? AND b > ?))`; MariaDB does not use the index with (a, b) > (?, ?). */
export function keysetWhere(key: string[]): string {
  const at = (i: number): string => {
    const c = quoteIdentifier(key[i])
    return i === key.length - 1 ? `${c} > ?` : `(${c} > ? OR (${c} = ? AND ${at(i + 1)}))`
  }
  return at(0)
}

/** Parameters of keysetWhere for the last key read: [a, a, b, b, c]. */
export function keysetParams(last: unknown[]): unknown[] {
  return last.flatMap((v, i) => (i === last.length - 1 ? [v] : [v, v]))
}

/** A key column for matchQuery; `charset` + `collation` (COLLATION_NAME and its character set) convert the value read from the other server, which has the connection's collation. */
export interface KeyColumn {
  name: string
  charset?: string
  collation?: string
}

/**
 * Rows of `table` (qualified) matching `count` keys read from the other side, joined by the server, which knows
 * which keys are equal for the column's collation. Columns come back as c0, c1, … and the key's position as i.
 * Parameters: for each key, [i, ...key values].
 */
export function matchQuery(table: string, key: KeyColumn[], columns: string[], count: number): string {
  if (count < 1) throw new Error('matchQuery needs at least one key')
  const selected = ['k.i AS i', ...columns.map((c, n) => `t.${quoteIdentifier(c)} AS c${n}`)].join(', ')
  const holders = '?, '.repeat(key.length) + '?'
  const first = `SELECT ? AS i, ${key.map((_, n) => `? AS k${n}`).join(', ')}`
  const keys = [first, ...Array.from({ length: count - 1 }, () => `SELECT ${holders}`)].join(' UNION ALL ')
  const on = key
    .map((k, n) => {
      const value = k.charset && k.collation ? `CONVERT(k.k${n} USING ${quoteIdentifier(k.charset)}) COLLATE ${quoteIdentifier(k.collation)}` : `k.k${n}`
      return `t.${quoteIdentifier(k.name)} = ${value}`
    })
    .join(' AND ')
  return `SELECT ${selected} FROM (${keys}) AS k JOIN ${table} AS t ON ${on}`
}

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i])

/** Indexes of the columns whose values differ; binary values by bytes, null equal only to null. */
export function rowChanges(source: unknown[], target: unknown[]): number[] {
  const changed: number[] = []
  source.forEach((a, i) => {
    const b = target[i]
    const equal =
      a === null || b === null
        ? a === b
        : a instanceof Uint8Array || b instanceof Uint8Array
          ? a instanceof Uint8Array && b instanceof Uint8Array && bytesEqual(a, b)
          : String(a) === String(b)
    if (!equal) changed.push(i)
  })
  return changed
}

const columnList = (cols: string[]): string => cols.map(quoteIdentifier).join(', ')
const keyEquals = (key: string[]): string => key.map((k) => `${quoteIdentifier(k)} = ?`).join(' AND ')

/** INSERT of `n` rows; parameters: the rows' values in order. */
export function insertSql(table: string, cols: string[], n: number): string {
  const row = `(${cols.map(() => '?').join(', ')})`
  return `INSERT INTO ${table} (${columnList(cols)}) VALUES ${Array.from({ length: n }, () => row).join(', ')}`
}

/** UPDATE of one row; parameters: the values of `cols`, then the key's. */
export function updateSql(table: string, cols: string[], key: string[]): string {
  return `UPDATE ${table} SET ${cols.map((c) => `${quoteIdentifier(c)} = ?`).join(', ')} WHERE ${keyEquals(key)}`
}

/** DELETE by key; one parameter: the values (one key column) or an array of tuples, expanded by mysql2. */
export function deleteSql(table: string, key: string[]): string {
  const lhs = key.length === 1 ? quoteIdentifier(key[0]) : `(${columnList(key)})`
  return `DELETE FROM ${table} WHERE ${lhs} IN (?)`
}

/** Blocks whose sizes add up to at most `budget`; an item larger than the budget goes alone. */
export function chunkByBytes<T>(items: T[], size: (item: T) => number, budget: number): T[][] {
  const chunks: T[][] = []
  let current: T[] = []
  let used = 0
  for (const item of items) {
    const s = size(item)
    if (current.length && used + s > budget) {
      chunks.push(current)
      current = []
      used = 0
    }
    current.push(item)
    used += s
  }
  if (current.length) chunks.push(current)
  return chunks
}

/** UTF-8 length of a string, without encoding it. */
function utf8Length(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4 // surrogate pair
      i++
    } else n += 3
  }
  return n
}

/** Estimated length in SQL: UTF-8 strings ×2 for escapes, binary ×2 in hexadecimal, 4 per value for quotes and separators. */
export function rowBytes(values: unknown[]): number {
  let n = 0
  for (const v of values) {
    if (typeof v === 'string') n += utf8Length(v) * 2
    else if (v instanceof Uint8Array) n += v.length * 2
    else n += String(v).length
    n += 4
  }
  return n
}

/** A value for the preview sample: binary as 0x… (first 32 bytes), long strings cut at 200 characters. */
export function sampleValue(v: unknown): string | null {
  if (v == null) return null
  if (v instanceof Uint8Array) return '0x' + toHex(v.subarray(0, 32)) + (v.length > 32 ? ` … (${v.length} B)` : '')
  const s = String(v)
  return s.length > 200 ? s.slice(0, 200) + '…' : s
}
