// SQL generation for the table editor: CREATE TABLE for new tables and the
// minimal ALTER TABLE statements turning one table model into another.

import { qualified, quoteIdentifier, quoteString } from './quote'
import type { ColumnDef, ForeignKeyDef, IndexDef, TableDef, TableOptions } from './create-table'

type Rename = (column: string) => string
const same: Rename = (c) => c

export function columnDefinition(c: ColumnDef): string {
  const parts = [quoteIdentifier(c.name), c.type]
  if (c.unsigned) parts.push('UNSIGNED')
  if (c.zerofill) parts.push('ZEROFILL')
  if (c.binary) parts.push('BINARY')
  if (c.charset) parts.push(`CHARACTER SET ${c.charset}`)
  if (c.collation) parts.push(`COLLATE ${c.collation}`)
  if (c.generated) parts.push(`GENERATED ALWAYS AS (${c.generated.expression}) ${c.generated.storage}`)
  // MariaDB rejects an explicit NULL on generated columns
  if (!c.nullable) parts.push('NOT NULL')
  else if (!c.generated) parts.push('NULL')
  if (c.default && !c.generated) parts.push(/^ON\s+UPDATE\b/i.test(c.default) ? c.default : `DEFAULT ${c.default}`)
  if (c.autoIncrement) parts.push('AUTO_INCREMENT')
  if (c.comment) parts.push(`COMMENT ${quoteString(c.comment)}`)
  if (c.extra) parts.push(c.extra)
  return parts.join(' ')
}

const indexKeywords: Record<IndexDef['kind'], string> = {
  PRIMARY: 'PRIMARY KEY',
  UNIQUE: 'UNIQUE INDEX',
  INDEX: 'INDEX',
  FULLTEXT: 'FULLTEXT INDEX',
  SPATIAL: 'SPATIAL INDEX'
}

/** Index element as used in CREATE TABLE and after ALTER TABLE ... ADD. */
export function indexDefinition(i: IndexDef, rename = same): string {
  const columns = i.columns
    .map((c) => quoteIdentifier(rename(c.name)) + (c.length ? `(${c.length})` : '') + (c.desc ? ' DESC' : ''))
    .join(', ')
  let sql = i.kind === 'PRIMARY' ? `PRIMARY KEY (${columns})` : `${indexKeywords[i.kind]} ${quoteIdentifier(i.name)} (${columns})`
  if (i.using) sql += ` USING ${i.using}`
  if (i.comment) sql += ` COMMENT ${quoteString(i.comment)}`
  if (i.extra) sql += ` ${i.extra}`
  return sql
}

export function foreignKeyDefinition(fk: ForeignKeyDef, rename = same): string {
  let sql = fk.name ? `CONSTRAINT ${quoteIdentifier(fk.name)} ` : ''
  sql += `FOREIGN KEY (${fk.columns.map((c) => quoteIdentifier(rename(c))).join(', ')})`
  sql += ` REFERENCES ${qualified(fk.refSchema || undefined, fk.refTable)} (${fk.refColumns.map(quoteIdentifier).join(', ')})`
  if (fk.onDelete) sql += ` ON DELETE ${fk.onDelete}`
  if (fk.onUpdate) sql += ` ON UPDATE ${fk.onUpdate}`
  return sql
}

function tableOptions(o: TableOptions): string[] {
  const out: string[] = []
  if (o.engine) out.push(`ENGINE = ${o.engine}`)
  if (o.autoIncrement) out.push(`AUTO_INCREMENT = ${o.autoIncrement}`)
  if (o.charset) out.push(`DEFAULT CHARACTER SET = ${o.charset}`)
  if (o.collation) out.push(`COLLATE = ${o.collation}`)
  if (o.rowFormat) out.push(`ROW_FORMAT = ${o.rowFormat}`)
  if (o.comment) out.push(`COMMENT = ${quoteString(o.comment)}`)
  if (o.other) out.push(o.other)
  return out
}

export function createTableSql(schema: string, t: TableDef): string {
  const elements = [
    ...t.columns.map(columnDefinition),
    ...t.indexes.map((i) => indexDefinition(i)),
    ...t.foreignKeys.map((f) => foreignKeyDefinition(f)),
    ...t.otherDefinitions
  ]
  let sql = `CREATE TABLE ${qualified(schema, t.name)} (\n  ${elements.join(',\n  ')}\n)`
  const options = tableOptions(t.options)
  if (options.length) sql += ' ' + options.join(' ')
  if (t.options.partition) sql += '\n' + t.options.partition
  return sql
}

/** Indexes (into `values`) of one longest strictly increasing subsequence. */
function longestIncreasing(values: number[]): Set<number> {
  const length = values.map(() => 1)
  const previous = values.map(() => -1)
  let best = -1
  values.forEach((v, i) => {
    for (let j = 0; j < i; j++) {
      if (values[j] < v && length[j] + 1 > length[i]) {
        length[i] = length[j] + 1
        previous[i] = j
      }
    }
    if (best < 0 || length[i] > length[best]) best = i
  })
  const out = new Set<number>()
  for (let i = best; i >= 0; i = previous[i]) out.add(i)
  return out
}

const dropIndex = (i: IndexDef): string => (i.kind === 'PRIMARY' ? 'DROP PRIMARY KEY' : `DROP INDEX ${quoteIdentifier(i.name)}`)

/**
 * Statements that turn table `from` (as parsed from the server) into `to`.
 * Items of `to` are matched to the originals through their `oldName`.
 * Foreign keys to drop go in a preceding statement, so that the indexes they
 * use can be changed by the main one. Returns [] when nothing changed.
 */
export function alterTableSql(schema: string, from: TableDef, to: TableDef): string[] {
  const renamed = new Map(to.columns.filter((c) => c.oldName !== undefined).map((c) => [c.oldName!, c.name]))
  const rename: Rename = (c) => renamed.get(c) ?? c

  const options: string[] = []
  const a = from.options
  const b = to.options
  if (a.engine !== b.engine && b.engine) options.push(`ENGINE = ${b.engine}`)
  if (a.charset !== b.charset && b.charset) options.push(`DEFAULT CHARACTER SET = ${b.charset}`)
  if (a.collation !== b.collation && b.collation) options.push(`COLLATE = ${b.collation}`)
  if (a.rowFormat !== b.rowFormat) options.push(`ROW_FORMAT = ${b.rowFormat || 'DEFAULT'}`)
  if (a.autoIncrement !== b.autoIncrement && b.autoIncrement) options.push(`AUTO_INCREMENT = ${b.autoIncrement}`)
  if (a.comment !== b.comment) options.push(`COMMENT = ${quoteString(b.comment)}`)

  // columns: positions are emitted only for the columns outside the longest run
  // that keeps its original order (CHANGE/ADD ... AFTER refer to the new names)
  const fromColumns = new Map(from.columns.map((c, i) => [c.name, { column: c, position: i }]))
  const matched = to.columns.filter((c) => c.oldName !== undefined && fromColumns.has(c.oldName))
  const staying = longestIncreasing(matched.map((c) => fromColumns.get(c.oldName!)!.position))
  const stays = new Set(matched.filter((_, i) => staying.has(i)))
  const dropColumns = from.columns
    .filter((c) => !matched.some((m) => m.oldName === c.name))
    .map((c) => `DROP COLUMN ${quoteIdentifier(c.name)}`)
  const columns: string[] = []
  to.columns.forEach((c, i) => {
    const position = i === 0 ? ' FIRST' : ` AFTER ${quoteIdentifier(to.columns[i - 1].name)}`
    const old = c.oldName !== undefined ? fromColumns.get(c.oldName)?.column : undefined
    const definition = columnDefinition(c)
    if (!old) columns.push(`ADD COLUMN ${definition}${position}`)
    else if (!stays.has(c)) columns.push(`CHANGE COLUMN ${quoteIdentifier(old.name)} ${definition}${position}`)
    else if (definition !== columnDefinition(old)) columns.push(`CHANGE COLUMN ${quoteIdentifier(old.name)} ${definition}`)
  })

  const dropIndexes: string[] = []
  const addIndexes: string[] = []
  const renameIndexes: string[] = []
  const fromIndexes = new Set(from.indexes.map((i) => i.name))
  for (const i of from.indexes) {
    const target = to.indexes.find((t) => t.oldName === i.name)
    if (!target) dropIndexes.push(dropIndex(i))
    else if (indexDefinition({ ...i, name: target.name }, rename) !== indexDefinition(target)) {
      dropIndexes.push(dropIndex(i))
      addIndexes.push(`ADD ${indexDefinition(target)}`)
    } else if (target.name !== i.name) renameIndexes.push(`RENAME INDEX ${quoteIdentifier(i.name)} TO ${quoteIdentifier(target.name)}`)
  }
  for (const i of to.indexes) if (i.oldName === undefined || !fromIndexes.has(i.oldName)) addIndexes.push(`ADD ${indexDefinition(i)}`)

  const dropForeignKeys: string[] = []
  const addForeignKeys: string[] = []
  const fromForeignKeys = new Set(from.foreignKeys.map((f) => f.name))
  for (const f of from.foreignKeys) {
    const target = to.foreignKeys.find((t) => t.oldName === f.name)
    if (target && foreignKeyDefinition(f, rename) === foreignKeyDefinition(target)) continue
    dropForeignKeys.push(`DROP FOREIGN KEY ${quoteIdentifier(f.name)}`)
    if (target) addForeignKeys.push(`ADD ${foreignKeyDefinition(target)}`)
  }
  for (const f of to.foreignKeys) {
    if (f.oldName === undefined || !fromForeignKeys.has(f.oldName)) addForeignKeys.push(`ADD ${foreignKeyDefinition(f)}`)
  }

  const clauses = [
    ...options,
    ...dropIndexes,
    ...dropColumns,
    ...columns,
    ...addIndexes,
    ...renameIndexes,
    ...addForeignKeys,
    ...(from.name !== to.name ? [`RENAME TO ${qualified(schema, to.name)}`] : [])
  ]
  const table = qualified(schema, from.name)
  const statements: string[] = []
  if (dropForeignKeys.length) statements.push(`ALTER TABLE ${table}\n  ${dropForeignKeys.join(',\n  ')}`)
  if (clauses.length) statements.push(`ALTER TABLE ${table}\n  ${clauses.join(',\n  ')}`)
  return statements
}
