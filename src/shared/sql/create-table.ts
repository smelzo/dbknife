// Parser of the CREATE TABLE statement printed by SHOW CREATE TABLE (MySQL 8 and
// MariaDB dialects) into an editable table model. Clauses the model does not
// represent are kept verbatim so they survive a round trip.

import { t } from '../i18n'
import { tokenize, unquoteIdentifier, type Token } from './lexer'
import { isExecutableComment } from './splitter'

export interface ColumnDef {
  name: string
  /** Name of the column on the server; undefined for columns not created yet. */
  oldName?: string
  /** Data type with its parameters, e.g. `VARCHAR(40)`, `ENUM('a','b')`. */
  type: string
  unsigned: boolean
  zerofill: boolean
  /** BINARY attribute (the server turns it into a `_bin` collation). */
  binary: boolean
  /** Explicit CHARACTER SET, '' for the table default. */
  charset: string
  /** Explicit COLLATE, '' for the default. */
  collation: string
  nullable: boolean
  /** DEFAULT value as SQL text, optionally followed by `ON UPDATE ...`; '' for none. */
  default: string
  /** SQL Server: name of the column's default constraint on the server. */
  defaultName?: string
  autoIncrement: boolean
  generated: { expression: string; storage: 'VIRTUAL' | 'STORED' } | null
  comment: string
  /** Attributes kept verbatim (INVISIBLE, SRID, CHECK, ...). */
  extra: string
}

export type IndexKind = 'PRIMARY' | 'UNIQUE' | 'INDEX' | 'FULLTEXT' | 'SPATIAL'

export interface IndexColumn {
  name: string
  length: number | null
  desc: boolean
}

export interface IndexDef {
  name: string
  oldName?: string
  kind: IndexKind
  /** PostgreSQL, SQLite: the index belongs to a PRIMARY KEY or UNIQUE constraint of the table. */
  constraint?: boolean
  columns: IndexColumn[]
  /** USING BTREE / HASH, '' when not specified. */
  using: string
  comment: string
  /** Index options kept verbatim (KEY_BLOCK_SIZE, WITH PARSER, INVISIBLE, ...). */
  extra: string
}

export interface ForeignKeyDef {
  name: string
  oldName?: string
  columns: string[]
  /** '' when the referenced table is in the same schema. */
  refSchema: string
  refTable: string
  refColumns: string[]
  /** Referential actions, '' when not specified. */
  onDelete: string
  onUpdate: string
}

export interface TableOptions {
  engine: string
  charset: string
  collation: string
  rowFormat: string
  autoIncrement: string
  comment: string
  /** Other table options kept verbatim (PACK_KEYS, STATS_PERSISTENT, ...). */
  other: string
  /** PARTITION BY clause kept verbatim. */
  partition: string
}

export interface TableDef {
  name: string
  columns: ColumnDef[]
  indexes: IndexDef[]
  foreignKeys: ForeignKeyDef[]
  /** Table elements kept verbatim (CHECK constraints, functional indexes, ...). */
  otherDefinitions: string[]
  options: TableOptions
  /**
   * SQLite: CREATE INDEX statements the model does not represent and the
   * table's CREATE TRIGGER statements, recreated after rebuilding the table.
   */
  dependents?: string[]
}

/** Unescapes a single-quoted string literal as printed by the server. */
function unquoteString(text: string): string {
  const q = text[0]
  const map: Record<string, string> = { '0': '\0', b: '\b', n: '\n', r: '\r', t: '\t', Z: '\x1a' }
  return text
    .slice(1, -1)
    .replace(new RegExp(`\\\\(.)|${q}${q}`, 'gs'), (m, c: string | undefined) => (c === undefined ? q : (map[c] ?? c)))
}

/** Source text of a token run, keeping the original spacing between tokens. */
export function sourceOf(sql: string, tokens: Token[]): string {
  let out = ''
  tokens.forEach((t, i) => {
    if (i > 0 && t.start > tokens[i - 1].end) out += ' '
    out += sql.slice(t.start, t.end)
  })
  return out
}

/** Cursor over the significant tokens of a statement (executable comments included). */
export class Cursor {
  pos = 0
  constructor(
    readonly sql: string,
    readonly tokens: Token[]
  ) {}

  get done(): boolean {
    return this.pos >= this.tokens.length
  }

  peek(offset = 0): Token | undefined {
    return this.tokens[this.pos + offset]
  }

  /** True when the next tokens are the given words (case-insensitive) or symbols. */
  is(...words: string[]): boolean {
    return words.every((w, i) => this.peek(i)?.text.toUpperCase() === w)
  }

  accept(...words: string[]): boolean {
    if (!this.is(...words)) return false
    this.pos += words.length
    return true
  }

  expect(...words: string[]): void {
    if (this.accept(...words)) return
    const expected = words.join(' ')
    const near = this.peek()?.text
    throw new Error(near === undefined ? t('sql.parse.expectedAtEnd', { expected }) : t('sql.parse.expectedNear', { expected, near }))
  }

  next(): Token {
    const tok = this.tokens[this.pos++]
    if (!tok) throw new Error(t('sql.parse.unexpectedEnd'))
    return tok
  }

  /** Consumes one token, or a whole parenthesized group when at `(`. Returns the consumed tokens. */
  unit(): Token[] {
    const start = this.pos
    if (this.next().text === '(') {
      let depth = 1
      while (depth > 0) {
        const t = this.next().text
        if (t === '(') depth++
        else if (t === ')') depth--
      }
    }
    return this.tokens.slice(start, this.pos)
  }

  identifier(): string {
    const tok = this.next()
    if (tok.type !== 'quoted' && tok.type !== 'word') throw new Error(t('sql.parse.expectedIdentifier', { near: tok.text }))
    return unquoteIdentifier(tok.text)
  }

  string(): string {
    const tok = this.next()
    if (tok.type !== 'string') throw new Error(t('sql.parse.expectedString', { near: tok.text }))
    return unquoteString(tok.text)
  }

  /** Text inside the parenthesized group at the cursor. */
  group(): string {
    const tokens = this.unit()
    if (tokens[0].text !== '(') throw new Error(t('sql.parse.expectedNear', { expected: '(', near: tokens[0].text }))
    return this.sql.slice(tokens[0].end, tokens[tokens.length - 1].start).trim()
  }

  /** Splits the parenthesized group at the cursor into comma-separated cursors. */
  list(): Cursor[] {
    const tokens = this.unit()
    if (tokens[0].text !== '(') throw new Error(t('sql.parse.expectedNear', { expected: '(', near: tokens[0].text }))
    const items: Cursor[] = []
    let depth = 0
    let current: Token[] = []
    for (const t of tokens.slice(1, -1)) {
      if (t.text === '(') depth++
      else if (t.text === ')') depth--
      if (t.text === ',' && depth === 0) {
        items.push(new Cursor(this.sql, current))
        current = []
      } else current.push(t)
    }
    if (current.length) items.push(new Cursor(this.sql, current))
    return items
  }

  rest(): string {
    const text = sourceOf(this.sql, this.tokens.slice(this.pos))
    this.pos = this.tokens.length
    return text
  }
}

// Words that end a DEFAULT / ON UPDATE expression at nesting level 0.
const attributeWords = new Set([
  'NOT',
  'NULL',
  'ON',
  'AUTO_INCREMENT',
  'COMMENT',
  'COLLATE',
  'CHARACTER',
  'CHARSET',
  'INVISIBLE',
  'VISIBLE',
  'CHECK',
  'GENERATED',
  'AS',
  'SRID',
  'COLUMN_FORMAT',
  'STORAGE',
  'PRIMARY',
  'UNIQUE',
  'KEY',
  'REFERENCES',
  'CONSTRAINT',
  'ENGINE_ATTRIBUTE',
  'SECONDARY_ENGINE_ATTRIBUTE',
  'COMPRESSED',
  'VIRTUAL',
  'STORED',
  'PERSISTENT'
])

function expression(c: Cursor): string {
  const tokens = c.unit()
  while (!c.done) {
    const t = c.peek()!
    if ((t.type === 'word' && attributeWords.has(t.text.toUpperCase())) || t.type === 'comment') break
    tokens.push(...c.unit())
  }
  return sourceOf(c.sql, tokens)
}

function parseColumn(c: Cursor): ColumnDef {
  const name = c.identifier()
  const typeWord = c.next()
  if (typeWord.type !== 'word') throw new Error(t('sql.parse.unknownType', { column: name, type: typeWord.text }))
  let type = typeWord.text.toUpperCase()
  if (c.peek()?.text === '(') type += sourceOf(c.sql, c.unit())
  const col: ColumnDef = {
    name,
    oldName: name,
    type,
    unsigned: false,
    zerofill: false,
    binary: false,
    charset: '',
    collation: '',
    nullable: true,
    default: '',
    autoIncrement: false,
    generated: null,
    comment: '',
    extra: ''
  }
  let defaultValue = ''
  let onUpdate = ''
  const extra: Token[] = []
  while (!c.done) {
    if (c.accept('UNSIGNED')) col.unsigned = true
    else if (c.accept('SIGNED')) col.unsigned = false
    else if (c.accept('ZEROFILL')) col.zerofill = true
    else if (c.accept('BINARY')) col.binary = true
    else if (c.accept('CHARACTER', 'SET') || c.accept('CHARSET')) col.charset = c.identifier()
    else if (c.accept('COLLATE')) col.collation = c.identifier()
    else if (c.accept('NOT', 'NULL')) col.nullable = false
    else if (c.accept('NULL')) col.nullable = true
    else if (c.accept('DEFAULT')) defaultValue = expression(c)
    else if (c.accept('ON', 'UPDATE')) onUpdate = expression(c)
    else if (c.accept('AUTO_INCREMENT')) col.autoIncrement = true
    else if (c.accept('COMMENT')) col.comment = c.string()
    else if (c.is('GENERATED', 'ALWAYS', 'AS') || c.is('AS', '(')) {
      c.accept('GENERATED', 'ALWAYS')
      c.expect('AS')
      const expr = c.group()
      const stored = c.accept('STORED') || c.accept('PERSISTENT')
      if (!stored) c.accept('VIRTUAL')
      col.generated = { expression: expr, storage: stored ? 'STORED' : 'VIRTUAL' }
    } else extra.push(...c.unit())
  }
  col.default = [defaultValue, onUpdate && `ON UPDATE ${onUpdate}`].filter(Boolean).join(' ')
  col.extra = sourceOf(c.sql, extra)
  return col
}

const indexKinds: [string[], IndexKind][] = [
  [['PRIMARY', 'KEY'], 'PRIMARY'],
  [['UNIQUE'], 'UNIQUE'],
  [['FULLTEXT'], 'FULLTEXT'],
  [['SPATIAL'], 'SPATIAL'],
  [['KEY'], 'INDEX'],
  [['INDEX'], 'INDEX']
]

/** Parses an index element; null when it has parts the model cannot represent (functional key parts). */
function parseIndex(c: Cursor): IndexDef | null {
  const match = indexKinds.find(([words]) => c.is(...words))
  if (!match) return null
  const [words, kind] = match
  c.accept(...words)
  if (kind !== 'PRIMARY' && kind !== 'INDEX' && !c.accept('KEY')) c.accept('INDEX')
  const index: IndexDef = { name: 'PRIMARY', kind, columns: [], using: '', comment: '', extra: '' }
  if (kind !== 'PRIMARY' && c.peek()?.text !== '(' && !c.is('USING')) index.name = c.identifier()
  index.oldName = index.name
  if (c.accept('USING')) index.using = c.next().text.toUpperCase()
  for (const part of c.list()) {
    if (part.peek()?.text === '(') return null
    const column: IndexColumn = { name: part.identifier(), length: null, desc: false }
    if (part.peek()?.text === '(') column.length = Number(part.group())
    if (part.accept('DESC')) column.desc = true
    else part.accept('ASC')
    if (!part.done) return null
    index.columns.push(column)
  }
  const extra: Token[] = []
  while (!c.done) {
    if (c.accept('USING')) index.using = c.next().text.toUpperCase()
    else if (c.accept('COMMENT')) index.comment = c.string()
    else extra.push(...c.unit())
  }
  index.extra = sourceOf(c.sql, extra)
  return index
}

const referentialActions = ['RESTRICT', 'CASCADE', 'SET NULL', 'NO ACTION', 'SET DEFAULT']

function referentialAction(c: Cursor): string {
  const action = referentialActions.find((a) => c.accept(...a.split(' ')))
  if (!action) throw new Error(t('sql.parse.unknownAction', { near: String(c.peek()?.text) }))
  return action
}

/** Parses a foreign key element; null when it is not one. */
function parseForeignKey(c: Cursor): ForeignKeyDef | null {
  let name = ''
  if (c.accept('CONSTRAINT') && !c.is('FOREIGN')) name = c.identifier()
  if (!c.accept('FOREIGN', 'KEY')) return null
  if (c.peek()?.text !== '(') c.identifier()
  const fk: ForeignKeyDef = {
    name,
    oldName: name,
    columns: c.list().map((p) => p.identifier()),
    refSchema: '',
    refTable: '',
    refColumns: [],
    onDelete: '',
    onUpdate: ''
  }
  c.expect('REFERENCES')
  fk.refTable = c.identifier()
  if (c.accept('.')) {
    fk.refSchema = fk.refTable
    fk.refTable = c.identifier()
  }
  fk.refColumns = c.list().map((p) => p.identifier())
  while (!c.done) {
    if (c.accept('ON', 'DELETE')) fk.onDelete = referentialAction(c)
    else if (c.accept('ON', 'UPDATE')) fk.onUpdate = referentialAction(c)
    else return null
  }
  return fk
}

const isPartitionStart = (t: Token): boolean =>
  (t.type === 'word' && t.text.toUpperCase() === 'PARTITION') || (t.type === 'comment' && /^\/\*!\d*\s*PARTITION\b/i.test(t.text))

function parseOptions(c: Cursor, options: TableOptions): void {
  const other: string[] = []
  while (!c.done) {
    if (isPartitionStart(c.peek()!)) {
      options.partition = c.sql.slice(c.peek()!.start).trim()
      return
    }
    const start = c.pos
    c.accept('DEFAULT')
    let name = ''
    if (c.accept('CHARACTER', 'SET') || c.accept('CHARSET')) name = 'CHARSET'
    else if (/^(word|quoted)$/.test(c.peek()?.type ?? '') && c.peek(1)?.text === '=') name = unquoteIdentifier(c.next().text).toUpperCase()
    if (name && c.accept('=')) {
      const value = c.unit()
      const text = value.length === 1 ? value[0].text : ''
      const known: Record<string, keyof TableOptions> = {
        ENGINE: 'engine',
        CHARSET: 'charset',
        COLLATE: 'collation',
        ROW_FORMAT: 'rowFormat',
        AUTO_INCREMENT: 'autoIncrement'
      }
      if (name === 'COMMENT' && value[0].type === 'string') options.comment = unquoteString(text)
      else if (known[name] && text) options[known[name]] = unquoteIdentifier(text)
      else other.push(sourceOf(c.sql, c.tokens.slice(start, c.pos)))
    } else {
      // an option of another shape (executable comment, WITH SYSTEM VERSIONING, ...)
      c.pos = start
      other.push(sourceOf(c.sql, c.unit()))
    }
  }
  options.other = other.join(' ')
}

/** Parses the output of SHOW CREATE TABLE. Throws when the statement is not understood. */
export function parseCreateTable(sql: string): TableDef {
  const tokens = tokenize(sql).filter((t) => t.type !== 'space' && (t.type !== 'comment' || isExecutableComment(t.text)))
  const c = new Cursor(sql, tokens)
  c.expect('CREATE')
  c.accept('TEMPORARY')
  c.expect('TABLE')
  c.accept('IF', 'NOT', 'EXISTS')
  let name = c.identifier()
  if (c.accept('.')) name = c.identifier()
  const table: TableDef = {
    name,
    columns: [],
    indexes: [],
    foreignKeys: [],
    otherDefinitions: [],
    options: { engine: '', charset: '', collation: '', rowFormat: '', autoIncrement: '', comment: '', other: '', partition: '' }
  }
  for (const item of c.list()) {
    const first = item.peek()!
    if (first.type === 'quoted' || (first.type === 'word' && !/^(PRIMARY|UNIQUE|KEY|INDEX|FULLTEXT|SPATIAL|CONSTRAINT|FOREIGN|CHECK|PERIOD)$/i.test(first.text))) {
      table.columns.push(parseColumn(item))
      continue
    }
    const index = parseIndex(new Cursor(sql, item.tokens))
    const fk = index ? null : parseForeignKey(new Cursor(sql, item.tokens))
    if (index) table.indexes.push(index)
    else if (fk) table.foreignKeys.push(fk)
    else table.otherDefinitions.push(item.rest())
  }
  if (!table.columns.length) throw new Error(t('sql.parse.noColumns'))
  parseOptions(c, table.options)
  // MySQL 8 prints the inherited collation when it is not the charset's primary
  // one; writing it back would make it explicit (and change SHOW CREATE TABLE)
  for (const col of table.columns) if (!col.charset && col.collation === table.options.collation) col.collation = ''
  return table
}
