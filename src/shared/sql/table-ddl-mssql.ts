// SQL generation of the SQL Server table editor: CREATE TABLE with its indexes
// and comments (MS_Description extended properties), and the statements turning
// one table model into another. Renames go through sp_rename. Defaults are named
// constraints: they are dropped before their column changes type and added again.
// ALTER COLUMN fails on a column used by an index or a foreign key, which are
// dropped and created again around it. IDENTITY cannot be added to or removed
// from an existing column, and columns cannot be reordered.

import { t } from '../i18n'
import type { ColumnDef, ForeignKeyDef, IndexDef, TableDef } from './create-table'
import { mssqlDialect } from './dialect'

const { quoteIdentifier: q, qualified, quoteString } = mssqlDialect

type Rename = (column: string) => string
const same: Rename = (c) => c

/** Name of a new primary key in the model: SQL Server then names it PK__<table>__<hex>. */
const unnamedPrimary = 'PRIMARY'

/** IDENTITY(seed,increment) of the column (kept in `extra` when read from the server), by default (1,1). */
const identity = (c: ColumnDef): string => (/^IDENTITY\s*\(/i.test(c.extra) ? c.extra : 'IDENTITY(1,1)')

/** Default constraint of the column: the one on the server, or DF_<table>_<column> for a new one. */
const defaultName = (table: string, c: ColumnDef): string => c.defaultName ?? `DF_${table}_${c.name}`

function columnDefinition(table: string, c: ColumnDef): string {
  if (c.generated) {
    const persisted = c.generated.storage === 'STORED' ? ` PERSISTED${c.nullable ? '' : ' NOT NULL'}` : ''
    return `${q(c.name)} AS (${c.generated.expression})${persisted}`
  }
  const parts = [q(c.name), c.type]
  if (c.collation) parts.push(`COLLATE ${c.collation}`)
  if (c.autoIncrement) parts.push(identity(c))
  parts.push(c.nullable ? 'NULL' : 'NOT NULL')
  if (c.default && !c.autoIncrement) parts.push(`CONSTRAINT ${q(defaultName(table, c))} DEFAULT ${c.default}`)
  return parts.join(' ')
}

const keyColumns = (i: IndexDef, rename = same): string => i.columns.map((c) => q(rename(c.name)) + (c.desc ? ' DESC' : '')).join(', ')

/** PRIMARY KEY and UNIQUE constraints are table constraints, the other indexes CREATE INDEX statements. */
const isConstraint = (i: IndexDef): boolean => i.kind === 'PRIMARY' || !!i.constraint

/** CLUSTERED / NONCLUSTERED, when not the default of the index. */
const clustering = (i: IndexDef): string => (i.using ? `${i.using} ` : '')

function constraintDefinition(i: IndexDef): string {
  const unnamed = i.kind === 'PRIMARY' ? i.name === unnamedPrimary : !i.name
  return `${unnamed ? '' : `CONSTRAINT ${q(i.name)} `}${i.kind === 'PRIMARY' ? 'PRIMARY KEY' : 'UNIQUE'} ${clustering(i)}(${keyColumns(i)})`
}

function createIndex(table: string, i: IndexDef): string {
  const options = i.extra ? ` ${i.extra}` : ''
  return `CREATE ${i.kind === 'UNIQUE' ? 'UNIQUE ' : ''}${clustering(i)}INDEX ${q(i.name)} ON ${table} (${keyColumns(i)})${options}`
}

function foreignKeyDefinition(fk: ForeignKeyDef, schema: string, rename = same): string {
  let sql = fk.name ? `CONSTRAINT ${q(fk.name)} ` : ''
  sql += `FOREIGN KEY (${fk.columns.map((c) => q(rename(c))).join(', ')})`
  sql += ` REFERENCES ${qualified(fk.refSchema || schema, fk.refTable)} (${fk.refColumns.map(q).join(', ')})`
  if (fk.onDelete) sql += ` ON DELETE ${fk.onDelete}`
  if (fk.onUpdate) sql += ` ON UPDATE ${fk.onUpdate}`
  return sql
}

/** The statement setting, changing or removing the MS_Description of a table or column; none when unchanged. */
function comment(schema: string, table: string, before: string, after: string, column?: string): string[] {
  if (before === after) return []
  const action = !before ? 'add' : !after ? 'drop' : 'update'
  const value = action === 'drop' ? '' : `, ${quoteString(after)}`
  const target = `N'SCHEMA', ${quoteString(schema)}, N'TABLE', ${quoteString(table)}` + (column === undefined ? '' : `, N'COLUMN', ${quoteString(column)}`)
  return [`EXEC sys.sp_${action}extendedproperty N'MS_Description'${value}, ${target}`]
}

/** EXEC sp_rename of `object` (its name as a string, e.g. [s].[t].[c]) to `name`. */
const rename = (object: string, name: string, type?: 'COLUMN' | 'INDEX'): string =>
  `EXEC sp_rename ${quoteString(object)}, ${quoteString(name)}${type ? `, N'${type}'` : ''}`

/** CREATE TABLE followed by the table's other indexes and its comments. */
export function createTableSql(schema: string, t: TableDef): string[] {
  const table = qualified(schema, t.name)
  const elements = [
    ...t.columns.map((c) => columnDefinition(t.name, c)),
    ...t.indexes.filter(isConstraint).map(constraintDefinition),
    ...t.foreignKeys.map((f) => foreignKeyDefinition(f, schema)),
    ...t.otherDefinitions
  ]
  return [
    `CREATE TABLE ${table} (\n  ${elements.join(',\n  ')}\n)`,
    ...t.indexes.filter((i) => !isConstraint(i)).map((i) => createIndex(table, i)),
    ...comment(schema, t.name, '', t.options.comment),
    ...t.columns.flatMap((c) => comment(schema, t.name, '', c.comment, c.name))
  ]
}

/**
 * Statements that turn table `from` (as read from the server) into `to`;
 * items of `to` are matched to the originals through their `oldName`. A
 * column made computed, or whose computation changes, is dropped and added
 * again. Throws when a change cannot be made (IDENTITY on an existing
 * column). Returns [] when nothing changed.
 */
export function alterTableSql(schema: string, from: TableDef, to: TableDef): string[] {
  const table = qualified(schema, from.name)
  const alter = `ALTER TABLE ${table}`
  const renamed = new Map(to.columns.filter((c) => c.oldName !== undefined && c.oldName !== c.name).map((c) => [c.oldName!, c.name]))
  const renameColumn: Rename = (c) => renamed.get(c) ?? c

  const fromColumns = new Map(from.columns.map((c) => [c.name, c]))
  /** Columns of `to` with their original, for those already on the server. */
  const pairs = to.columns.flatMap((c) => (c.oldName !== undefined && fromColumns.has(c.oldName) ? [[fromColumns.get(c.oldName)!, c] as const] : []))
  const recreated = pairs.filter(([a, b]) => (a.generated || b.generated) && columnDefinition('', a) !== columnDefinition('', { ...b, name: a.name }))
  const inPlace = pairs.filter((p) => !recreated.includes(p))
  const kept = new Set(inPlace.map(([, b]) => b))
  for (const [a, b] of inPlace) {
    if (a.autoIncrement !== b.autoIncrement) throw new Error(t('tableEditor.mssql.identityChange', { column: b.name }))
  }
  const typeChanged = (a: ColumnDef, b: ColumnDef): boolean => a.type !== b.type || a.collation !== b.collation
  const altered = inPlace.filter(([a, b]) => !a.generated && (typeChanged(a, b) || a.nullable !== b.nullable))
  /** Original names of the columns that ALTER COLUMN changes or that are dropped and added: their indexes and keys are made again. */
  const alteredNames = new Set([...altered, ...recreated].map(([a]) => a.name))

  // foreign keys and indexes that change, go away or stand on an altered column
  const before: string[] = []
  const keptForeignKeys = new Set<ForeignKeyDef>()
  for (const f of from.foreignKeys) {
    const target = to.foreignKeys.find((o) => o.oldName === f.name)
    if (target && !f.columns.some((c) => alteredNames.has(c)) && foreignKeyDefinition(f, schema, renameColumn) === foreignKeyDefinition(target, schema)) {
      keptForeignKeys.add(target)
      continue
    }
    before.push(`${alter} DROP CONSTRAINT ${q(f.name)}`)
  }
  const indexShape = (i: IndexDef, r = same): string => `${isConstraint(i)}:${i.kind}:${i.using}:${keyColumns(i, r)}:${i.extra}`
  // included columns and filters are in the options, where the server writes column names in brackets
  const usesAltered = (i: IndexDef): boolean => [...alteredNames].some((c) => i.columns.some((k) => k.name === c) || i.extra.includes(q(c)))
  const keptIndexes = new Set<IndexDef>()
  const indexRenames: string[] = []
  for (const i of from.indexes) {
    const target = to.indexes.find((o) => o.oldName === i.name)
    if (target && !usesAltered(i) && indexShape(i, renameColumn) === indexShape(target)) {
      keptIndexes.add(target)
      if (target.name !== i.name && !(target.kind === 'PRIMARY' && target.name === unnamedPrimary)) {
        indexRenames.push(rename(`${table}.${q(i.name)}`, target.name, 'INDEX'))
      }
      continue
    }
    before.push(isConstraint(i) ? `${alter} DROP CONSTRAINT ${q(i.name)}` : `DROP INDEX ${q(i.name)} ON ${table}`)
  }

  // defaults go before their column changes type or goes away, and come back after
  const dropped = [...from.columns.filter((c) => !pairs.some(([a]) => a === c)), ...recreated.map(([a]) => a)]
  const defaultChanges = inPlace.filter(([a, b]) => !a.generated && (a.default !== b.default || (typeChanged(a, b) && !!a.default)))
  const dropDefaults = [...dropped, ...defaultChanges.map(([a]) => a)]
    .filter((c) => c.default && !c.generated)
    .map((c) => `${alter} DROP CONSTRAINT ${q(defaultName(from.name, c))}`)
  const addDefaults = defaultChanges
    .filter(([, b]) => b.default)
    .map(([a, b]) => `${alter} ADD CONSTRAINT ${q(defaultName(from.name, { ...b, defaultName: a.defaultName }))} DEFAULT ${b.default} FOR ${q(b.name)}`)

  const dropColumns = dropped.map((c) => q(c.name))
  const columnRenames = inPlace.filter(([a, b]) => a.name !== b.name).map(([a, b]) => rename(`${table}.${q(a.name)}`, b.name, 'COLUMN'))
  const alterColumns = altered.map(([, b]) => `${alter} ALTER COLUMN ${q(b.name)} ${b.type}${b.collation ? ` COLLATE ${b.collation}` : ''} ${b.nullable ? 'NULL' : 'NOT NULL'}`)
  const addColumns = to.columns.filter((c) => !kept.has(c)).map((c) => columnDefinition(from.name, c))

  const constraints = to.indexes.filter((i) => !keptIndexes.has(i) && isConstraint(i)).map((i) => `${alter} ADD ${constraintDefinition(i)}`)
  const indexes = to.indexes.filter((i) => !keptIndexes.has(i) && !isConstraint(i)).map((i) => createIndex(table, i))
  const foreignKeys = to.foreignKeys.filter((f) => !keptForeignKeys.has(f)).map((f) => `${alter} ADD ${foreignKeyDefinition(f, schema)}`)

  const comments = [
    ...comment(schema, from.name, from.options.comment, to.options.comment),
    ...to.columns.flatMap((c) => {
      const old = kept.has(c) ? pairs.find(([, b]) => b === c)![0] : undefined
      return comment(schema, from.name, old?.comment ?? '', c.comment, c.name)
    })
  ]
  return [
    ...before,
    ...dropDefaults,
    ...(dropColumns.length ? [`${alter} DROP COLUMN ${dropColumns.join(', ')}`] : []),
    ...columnRenames,
    ...alterColumns,
    ...(addColumns.length ? [`${alter} ADD ${addColumns.join(',\n  ')}`] : []),
    ...addDefaults,
    ...indexRenames,
    ...constraints,
    ...indexes,
    ...foreignKeys,
    ...comments,
    ...(from.name !== to.name ? [rename(table, to.name)] : [])
  ]
}
