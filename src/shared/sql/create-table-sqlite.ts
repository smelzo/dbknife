// Parser of SQLite's CREATE TABLE and CREATE INDEX statements, as kept in
// sqlite_master, into the table editor model. Constraints the model does not
// represent (CHECK, deferrable foreign keys, collated key columns) are kept
// verbatim so that rebuilding the table preserves them.

import { Cursor, sourceOf, type ColumnDef, type ForeignKeyDef, type IndexColumn, type IndexDef, type TableDef } from './create-table'
import { t } from '../i18n'
import { sqliteRules, tokenize, unquoteIdentifier, type Token } from './lexer'

const tokensOf = (sql: string): Token[] => tokenize(sql, sqliteRules).filter((t) => t.type !== 'space' && t.type !== 'comment')

/** Words ending the type name of a column: the start of its constraints. */
const constraintWords = new Set(['CONSTRAINT', 'PRIMARY', 'NOT', 'NULL', 'UNIQUE', 'CHECK', 'DEFAULT', 'COLLATE', 'REFERENCES', 'GENERATED', 'AS'])
const tableConstraintWords = /^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)$/i
const referentialActions = ['SET NULL', 'SET DEFAULT', 'CASCADE', 'RESTRICT', 'NO ACTION']

/** An identifier; SQLite also takes a string literal where it expects a name. */
function name(c: Cursor): string {
  const tok = c.next()
  if (tok.type === 'string') return tok.text.slice(1, -1).replace(/''/g, "'")
  if (tok.type !== 'word' && tok.type !== 'quoted') throw new Error(t('sql.parse.expectedName', { near: tok.text }))
  return unquoteIdentifier(tok.text)
}

/** ON CONFLICT clauses change how constraint violations resolve: the model has no place for them. */
function noConflictClause(c: Cursor): void {
  if (c.is('ON', 'CONFLICT')) throw new Error(t('sql.parse.onConflict'))
}

/** DEFAULT value: a literal, a signed number or a parenthesized expression, as written. */
function defaultValue(c: Cursor): string {
  const tok = c.peek()
  if (!tok) throw new Error(t('sql.parse.expectedDefault'))
  if (tok.text === '(') return sourceOf(c.sql, c.unit())
  if (tok.text === '-' || tok.text === '+') return sourceOf(c.sql, [c.next(), c.next()])
  c.next()
  // X'0A' is a word followed by a string
  const blob = c.peek()
  if (/^x$/i.test(tok.text) && blob?.type === 'string' && blob.start === tok.end) return c.sql.slice(tok.start, c.next().end)
  return tok.text
}

function referentialAction(c: Cursor): string {
  const action = referentialActions.find((a) => c.accept(...a.split(' ')))
  if (!action) throw new Error(t('sql.parse.unknownAction', { near: String(c.peek()?.text) }))
  return action
}

/**
 * REFERENCES clause after the keyword. `modelled` is false when it has
 * parts the model cannot represent (MATCH, DEFERRABLE).
 */
function references(c: Cursor, columns: string[], constraintName: string): { fk: ForeignKeyDef; modelled: boolean } {
  const fk: ForeignKeyDef = {
    name: constraintName,
    oldName: constraintName,
    columns,
    refSchema: '',
    refTable: name(c),
    refColumns: [],
    onDelete: '',
    onUpdate: ''
  }
  if (c.peek()?.text === '(') fk.refColumns = c.list().map(name)
  let modelled = true
  while (!c.done) {
    if (c.accept('ON', 'DELETE')) fk.onDelete = referentialAction(c)
    else if (c.accept('ON', 'UPDATE')) fk.onUpdate = referentialAction(c)
    else if (c.accept('MATCH')) {
      name(c)
      modelled = false
    } else if (c.accept('NOT', 'DEFERRABLE') || c.accept('DEFERRABLE')) {
      if (c.accept('INITIALLY')) c.next()
      modelled = false
    } else break
  }
  return { fk, modelled }
}

/** Key columns of an index or constraint; null when one is an expression or has a collation. */
function indexColumns(c: Cursor): IndexColumn[] | null {
  const columns: IndexColumn[] = []
  for (const part of c.list()) {
    const t = part.peek()
    if (!t || (t.type !== 'word' && t.type !== 'quoted')) return null
    const column: IndexColumn = { name: name(part), length: null, desc: false }
    if (part.accept('DESC')) column.desc = true
    else part.accept('ASC')
    if (!part.done) return null
    columns.push(column)
  }
  return columns
}

interface Parsed {
  table: TableDef
  primary?: IndexDef
}

function parseColumn(c: Cursor, out: Parsed): ColumnDef {
  const col: ColumnDef = {
    name: name(c),
    type: '',
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
  col.oldName = col.name
  const type: Token[] = []
  while (!c.done && (c.peek()!.type === 'word' || c.peek()!.type === 'quoted') && !constraintWords.has(c.peek()!.text.toUpperCase())) {
    type.push(c.next())
  }
  if (type.length && c.peek()?.text === '(') type.push(...c.unit())
  col.type = sourceOf(c.sql, type)
  const extra: string[] = []
  while (!c.done) {
    const start = c.pos
    const constraintName = c.accept('CONSTRAINT') ? name(c) : ''
    if (c.accept('PRIMARY', 'KEY')) {
      const desc = c.accept('DESC')
      if (!desc) c.accept('ASC')
      noConflictClause(c)
      col.autoIncrement = c.accept('AUTOINCREMENT')
      if (out.primary) throw new Error(t('sql.parse.primaryKeys', { table: out.table.name }))
      out.primary = { name: constraintName || 'PRIMARY', kind: 'PRIMARY', columns: [{ name: col.name, length: null, desc }], using: '', comment: '', extra: '', constraint: true }
      out.primary.oldName = out.primary.name
    } else if (c.accept('NOT', 'NULL')) {
      noConflictClause(c)
      col.nullable = false
    } else if (c.accept('NULL')) {
      noConflictClause(c)
    } else if (c.accept('UNIQUE')) {
      noConflictClause(c)
      out.table.indexes.push({
        name: constraintName,
        oldName: constraintName,
        kind: 'UNIQUE',
        columns: [{ name: col.name, length: null, desc: false }],
        using: '',
        comment: '',
        extra: '',
        constraint: true
      })
    } else if (c.accept('DEFAULT')) col.default = defaultValue(c)
    else if (c.accept('COLLATE')) col.collation = name(c)
    else if (c.accept('REFERENCES')) {
      const { fk, modelled } = references(c, [col.name], constraintName)
      if (modelled) out.table.foreignKeys.push(fk)
      else extra.push(sourceOf(c.sql, c.tokens.slice(start, c.pos)))
    } else if (c.is('GENERATED', 'ALWAYS', 'AS') || c.is('AS', '(')) {
      c.accept('GENERATED', 'ALWAYS')
      c.expect('AS')
      const expression = c.group()
      const stored = c.accept('STORED')
      if (!stored) c.accept('VIRTUAL')
      col.generated = { expression, storage: stored ? 'STORED' : 'VIRTUAL' }
    } else if (c.accept('CHECK')) {
      c.unit()
      extra.push(sourceOf(c.sql, c.tokens.slice(start, c.pos)))
    } else extra.push(sourceOf(c.sql, [...c.tokens.slice(start, c.pos), ...c.unit()]))
  }
  col.extra = extra.join(' ')
  return col
}

/** A table constraint, or false when it has to be kept verbatim. */
function parseTableConstraint(c: Cursor, out: Parsed): boolean {
  const constraintName = c.accept('CONSTRAINT') ? name(c) : ''
  if (c.is('PRIMARY', 'KEY') || c.is('UNIQUE')) {
    const primary = c.accept('PRIMARY', 'KEY')
    if (!primary) c.accept('UNIQUE')
    const columns = indexColumns(c)
    if (!columns || !c.done) return false
    const index: IndexDef = {
      name: primary ? constraintName || 'PRIMARY' : constraintName,
      kind: primary ? 'PRIMARY' : 'UNIQUE',
      columns,
      using: '',
      comment: '',
      extra: '',
      constraint: true
    }
    index.oldName = index.name
    if (primary) {
      if (out.primary) throw new Error(t('sql.parse.primaryKeys', { table: out.table.name }))
      out.primary = index
    } else out.table.indexes.push(index)
    return true
  }
  if (c.accept('FOREIGN', 'KEY')) {
    const columns = c.list().map(name)
    c.expect('REFERENCES')
    const { fk, modelled } = references(c, columns, constraintName)
    if (!modelled || !c.done) return false
    out.table.foreignKeys.push(fk)
    return true
  }
  return false
}

/** Parses a CREATE TABLE statement of sqlite_master. Throws when the statement is not understood. */
export function parseSqliteCreateTable(sql: string): TableDef {
  const c = new Cursor(sql, tokensOf(sql))
  c.expect('CREATE')
  if (!c.accept('TEMP')) c.accept('TEMPORARY')
  c.expect('TABLE')
  c.accept('IF', 'NOT', 'EXISTS')
  let tableName = name(c)
  if (c.accept('.')) tableName = name(c)
  const out: Parsed = {
    table: {
      name: tableName,
      columns: [],
      indexes: [],
      foreignKeys: [],
      otherDefinitions: [],
      options: { engine: '', charset: '', collation: '', rowFormat: '', autoIncrement: '', comment: '', other: '', partition: '' }
    }
  }
  for (const item of c.list()) {
    const first = item.peek()!
    const isConstraint = first.type === 'word' && tableConstraintWords.test(first.text)
    if (!isConstraint) {
      out.table.columns.push(parseColumn(item, out))
      continue
    }
    if (!parseTableConstraint(new Cursor(sql, item.tokens), out)) out.table.otherDefinitions.push(item.rest())
  }
  if (!out.table.columns.length) throw new Error(t('sql.parse.noColumns'))
  if (out.primary) out.table.indexes.unshift(out.primary)
  // WITHOUT ROWID, STRICT
  out.table.options.other = c.rest()
  return out.table
}

/**
 * Parses a CREATE INDEX statement into an index of the model; null when the
 * index is partial or has key columns the model does not represent.
 */
export function parseSqliteCreateIndex(sql: string): IndexDef | null {
  const c = new Cursor(sql, tokensOf(sql))
  c.expect('CREATE')
  const unique = c.accept('UNIQUE')
  c.expect('INDEX')
  c.accept('IF', 'NOT', 'EXISTS')
  let indexName = name(c)
  if (c.accept('.')) indexName = name(c)
  c.expect('ON')
  name(c)
  const columns = indexColumns(c)
  if (!columns || !c.done) return null
  return { name: indexName, oldName: indexName, kind: unique ? 'UNIQUE' : 'INDEX', columns, using: '', comment: '', extra: '' }
}
