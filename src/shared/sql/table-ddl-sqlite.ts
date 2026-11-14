// SQL generation of the SQLite table editor. ALTER TABLE in SQLite renames
// tables and columns and adds columns at the end; any other change rebuilds
// the table as https://sqlite.org/lang_altertable.html#otheralter describes:
// create the new table, copy the rows, drop the old one, rename the new one,
// then recreate its indexes and triggers.

import type { ColumnDef, ForeignKeyDef, IndexDef, TableDef } from './create-table'
import { sqliteDialect } from './dialect'
import { sqliteRules, tokenize, unquoteIdentifier } from './lexer'

const { quoteIdentifier: q, qualified } = sqliteDialect

/** Literals SQLite takes as DEFAULT without parentheses; anything else is an expression. */
const defaultLiteral = /^('(?:[^']|'')*'|[-+]?(\d+(\.\d*)?|\.\d+)(e[-+]?\d+)?|0x[0-9a-f]+|x'[0-9a-f]*'|null|true|false|current_(time|date|timestamp))$/is

const collation = (name: string): string => (/^\w+$/.test(name) ? name : q(name))
const keyColumns = (i: IndexDef): string => i.columns.map((c) => q(c.name) + (c.desc ? ' DESC' : '')).join(', ')

/** Index kept in CREATE TABLE (primary key, UNIQUE constraint) rather than a CREATE INDEX of its own. */
const inTable = (i: IndexDef): boolean => i.kind === 'PRIMARY' || !!i.constraint

/** The primary key written on its column: SQLite's AUTOINCREMENT is allowed there only. */
function inlinePrimary(t: TableDef): IndexDef | undefined {
  const pk = t.indexes.find((i) => i.kind === 'PRIMARY')
  return pk?.columns.length === 1 && t.columns.find((c) => c.name === pk.columns[0].name)?.autoIncrement ? pk : undefined
}

function columnDefinition(c: ColumnDef, primary?: IndexDef): string {
  const parts = [q(c.name)]
  if (c.type) parts.push(c.type)
  if (primary) parts.push(`PRIMARY KEY${primary.columns[0].desc ? ' DESC' : ''} AUTOINCREMENT`)
  if (!c.nullable) parts.push('NOT NULL')
  if (c.default && !c.generated) parts.push(`DEFAULT ${defaultLiteral.test(c.default.trim()) || c.default.trim().startsWith('(') ? c.default : `(${c.default})`}`)
  if (c.collation) parts.push(`COLLATE ${collation(c.collation)}`)
  if (c.generated) parts.push(`GENERATED ALWAYS AS (${c.generated.expression}) ${c.generated.storage}`)
  if (c.extra) parts.push(c.extra)
  return parts.join(' ')
}

function foreignKeyDefinition(fk: ForeignKeyDef): string {
  let sql = fk.name ? `CONSTRAINT ${q(fk.name)} ` : ''
  // SQLite looks the parent table up in the child's own database: no schema here
  // without columns the key references the parent's primary key
  const refColumns = fk.refColumns.length ? ` (${fk.refColumns.map(q).join(', ')})` : ''
  sql += `FOREIGN KEY (${fk.columns.map(q).join(', ')}) REFERENCES ${q(fk.refTable)}${refColumns}`
  if (fk.onDelete) sql += ` ON DELETE ${fk.onDelete}`
  if (fk.onUpdate) sql += ` ON UPDATE ${fk.onUpdate}`
  return sql
}

function tableElements(t: TableDef): string[] {
  const inline = inlinePrimary(t)
  const elements = t.columns.map((c) => columnDefinition(c, inline && c.name === inline.columns[0].name ? inline : undefined))
  for (const i of t.indexes.filter(inTable)) {
    if (i === inline) continue
    const name = i.name && !(i.kind === 'PRIMARY' && i.name === 'PRIMARY') ? `CONSTRAINT ${q(i.name)} ` : ''
    elements.push(`${name}${i.kind === 'PRIMARY' ? 'PRIMARY KEY' : 'UNIQUE'} (${keyColumns(i)})`)
  }
  elements.push(...t.foreignKeys.map(foreignKeyDefinition), ...t.otherDefinitions)
  return elements
}

function createTable(schema: string, name: string, t: TableDef): string {
  return `CREATE TABLE ${qualified(schema, name)} (\n  ${tableElements(t).join(',\n  ')}\n)${t.options.other ? ` ${t.options.other}` : ''}`
}

function createIndexSql(schema: string, table: string, i: IndexDef): string {
  return `CREATE ${i.kind === 'UNIQUE' ? 'UNIQUE ' : ''}INDEX ${qualified(schema, i.name)} ON ${q(table)} (${keyColumns(i)})`
}

export function createTableSql(schema: string, t: TableDef): string[] {
  return [createTable(schema, t.name, t), ...t.indexes.filter((i) => !inTable(i)).map((i) => createIndexSql(schema, t.name, i)), ...(t.dependents ?? [])]
}

/**
 * Replaces identifiers in a stored CREATE INDEX / CREATE TRIGGER statement
 * (renamed columns and table) and puts the object in `schema`, whose name
 * sqlite_master does not keep. Statements are matched by token, so a trigger
 * naming another table's column of the same name is renamed too: the script
 * is reviewed before it runs.
 */
function rewriteDependent(sql: string, schema: string, renames: Map<string, string>): string {
  const tokens = tokenize(sql, sqliteRules)
  let objectName = -1
  if (schema !== 'main') {
    // the object name follows CREATE [UNIQUE|TEMP] INDEX|TRIGGER [IF NOT EXISTS]
    const significant = tokens.map((t, n) => ({ t, n })).filter(({ t }) => t.type !== 'space' && t.type !== 'comment')
    const kind = significant.findIndex(({ t }) => /^(INDEX|TRIGGER)$/i.test(t.text))
    let at = kind + 1
    if (significant[at]?.t.text.toUpperCase() === 'IF') at += 3
    if (significant[at + 1]?.t.text !== '.') objectName = significant[at]?.n ?? -1
  }
  return tokens
    .map((t, n) => {
      const renamed = (t.type === 'word' || t.type === 'quoted') && renames.get(unquoteIdentifier(t.text).toLowerCase())
      const text = renamed ? q(renamed) : t.text
      return n === objectName ? `${q(schema)}.${text}` : text
    })
    .join('')
}

/** ALTER TABLE ... ADD COLUMN takes the column (https://sqlite.org/lang_altertable.html#altertabaddcol). */
function addable(t: TableDef, c: ColumnDef): boolean {
  const keyed = t.indexes.some((i) => inTable(i) && i.columns.some((k) => k.name === c.name)) || t.foreignKeys.some((f) => f.columns.includes(c.name))
  const d = c.default.trim()
  return (
    !keyed &&
    c.generated?.storage !== 'STORED' &&
    (c.nullable || (!!d && !/^null$/i.test(d))) &&
    !/^(\(|current_(time|date|timestamp)$)/i.test(d)
  )
}

/** `t` with its columns renamed (and the renames followed in its keys). */
function withRenames(t: TableDef, renames: Map<string, string>, name: string): TableDef {
  const r = (c: string): string => renames.get(c.toLowerCase()) ?? c
  return {
    ...t,
    name,
    columns: t.columns.map((c) => ({ ...c, name: r(c.name) })),
    indexes: t.indexes.map((i) => ({ ...i, columns: i.columns.map((c) => ({ ...c, name: r(c.name) })) })),
    foreignKeys: t.foreignKeys.map((f) => ({ ...f, columns: f.columns.map(r) }))
  }
}

/** Temporary name of the rebuilt table. */
const rebuildName = (table: string): string => `_dbm_new_${table}`

/**
 * Statements turning table `from` into `to` (items of `to` refer to the
 * originals through `oldName`). The rebuild runs in a transaction with the
 * foreign key checks off, as dropping the old table would otherwise delete
 * the child rows of ON DELETE CASCADE keys. Returns [] when nothing changed.
 */
export function alterTableSql(schema: string, from: TableDef, to: TableDef): string[] {
  const fromNames = new Set(from.columns.map((c) => c.name))
  const matched = to.columns.filter((c) => c.oldName !== undefined && fromNames.has(c.oldName))
  const columnRenames = matched.filter((c) => c.oldName !== c.name).map((c) => [c.oldName!, c.name] as const)
  const renames = new Map(columnRenames.map(([a, b]) => [a.toLowerCase(), b]))
  const renamed = withRenames(from, renames, to.name)

  const table = qualified(schema, to.name)
  const renameStatements = [
    ...(from.name !== to.name ? [`ALTER TABLE ${qualified(schema, from.name)} RENAME TO ${q(to.name)}`] : []),
    ...columnRenames.map(([a, b]) => `ALTER TABLE ${table} RENAME COLUMN ${q(a)} TO ${q(b)}`)
  ]

  // columns added after the last existing one, which ALTER TABLE can add
  const lastMatched = to.columns.indexOf(matched[matched.length - 1])
  const added = to.columns.slice(lastMatched + 1)
  const inPlace =
    to.columns.slice(0, lastMatched + 1).every((c) => matched.includes(c)) &&
    added.every((c) => c.oldName === undefined && addable(to, c)) &&
    createTable('', to.name, { ...to, columns: to.columns.slice(0, lastMatched + 1) }) === createTable('', to.name, renamed)

  const plain = (t: TableDef): IndexDef[] => t.indexes.filter((i) => !inTable(i))
  if (inPlace) {
    const fromIndexes = new Map(plain(renamed).map((i) => [i.name, i]))
    const kept = new Set<string>()
    const create: string[] = []
    for (const i of plain(to)) {
      const old = i.oldName !== undefined ? fromIndexes.get(i.oldName) : undefined
      if (old && createIndexSql(schema, to.name, { ...old, name: i.name }) === createIndexSql(schema, to.name, i) && old.name === i.name) kept.add(old.name)
      else create.push(createIndexSql(schema, to.name, i))
    }
    const drop = plain(from)
      .filter((i) => !kept.has(i.name))
      .map((i) => `DROP INDEX ${qualified(schema, i.name)}`)
    return [...drop, ...renameStatements, ...added.map((c) => `ALTER TABLE ${table} ADD COLUMN ${columnDefinition(c)}`), ...create]
  }

  const temp = qualified(schema, rebuildName(to.name))
  const copied = to.columns.filter((c) => matched.includes(c) && !c.generated).map((c) => q(c.name))
  const dependentRenames = new Map(renames)
  if (from.name !== to.name) dependentRenames.set(from.name.toLowerCase(), to.name)
  return [
    'PRAGMA foreign_keys = OFF',
    'BEGIN',
    ...renameStatements,
    // the renames above rewrote references in views and other tables; the rename below must not
    'PRAGMA legacy_alter_table = ON',
    createTable(schema, rebuildName(to.name), to),
    ...(copied.length ? [`INSERT INTO ${temp} (${copied.join(', ')})\n  SELECT ${copied.join(', ')} FROM ${table}`] : []),
    `DROP TABLE ${table}`,
    `ALTER TABLE ${temp} RENAME TO ${q(to.name)}`,
    ...plain(to).map((i) => createIndexSql(schema, to.name, i)),
    ...(to.dependents ?? []).map((sql) => rewriteDependent(sql, schema, dependentRenames)),
    'COMMIT',
    'PRAGMA legacy_alter_table = OFF',
    'PRAGMA foreign_keys = ON'
  ]
}

/** Statements restoring the connection when a rebuild script fails half way (after its transaction is rolled back). */
export const rebuildCleanup = ['PRAGMA legacy_alter_table = OFF', 'PRAGMA foreign_keys = ON']
