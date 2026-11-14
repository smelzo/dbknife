import type { ColumnDef, ForeignKeyDef, IndexDef, TableDef } from '@shared/sql/create-table'
import { mssqlDialect } from '@shared/sql/dialect'
import { significantTokens, tsqlRules } from '@shared/sql/lexer'
// from @shared, not @/i18n: the vitest integration tests load this module without the renderer's window.api
import { t } from '@shared/i18n'
import type { Query } from '../../../workspace/catalog/catalog'
import { MssqlCatalog } from '../../../workspace/catalog/mssql'
import { newColumn } from './model'

// The SQL Server table editor's model, read through the catalog. Indexes it
// cannot represent (columnstore, XML, spatial) stay out of it and the editor
// leaves them as they are; CHECK constraints are kept as text.

/**
 * A default or computed column definition without the parentheses SQL Server
 * puts around it: ((0)) is 0 written as DEFAULT (0), and (getdate()) is getdate().
 */
function unwrap(definition: string): string {
  const tokens = significantTokens(definition, tsqlRules)
  let depth = 0
  for (const [n, tok] of tokens.entries()) {
    if (tok.text === '(') depth++
    else if (tok.text === ')') depth--
    // the first parenthesis closes before the end: it does not enclose the whole definition
    if (depth === 0 && n < tokens.length - 1) return definition
  }
  return tokens[0]?.text === '(' ? definition.slice(tokens[0].end, tokens[tokens.length - 1].start).trim() : definition
}

/** Reads a table into the model; throws when it does not exist. */
export async function loadMssqlTable(query: Query, schema: string, table: string): Promise<TableDef> {
  const read = await new MssqlCatalog(query).table(schema, table)
  if (!read) throw new Error(t('tableEditor.load.notFound', { schema, table }))
  const columns: ColumnDef[] = read.columns.map((c) => ({
    // a computed column has no declared type
    ...newColumn(c.meta.name, c.computed ? '' : c.meta.type),
    oldName: c.meta.name,
    nullable: c.meta.nullable,
    default: c.meta.default === null ? '' : unwrap(c.meta.default),
    ...(c.defaultName === null ? {} : { defaultName: c.defaultName }),
    autoIncrement: !!c.identity,
    generated: c.computed ? { expression: unwrap(c.computed), storage: c.persisted ? 'STORED' : 'VIRTUAL' } : null,
    // a computed column takes the collation of its expression
    collation: c.computed ? '' : c.collation,
    comment: c.meta.comment,
    // seed and increment, shown as kept attributes
    extra: c.identity
  }))
  const indexes: IndexDef[] = read.indexes
    .filter((i) => i.type === 'CLUSTERED' || i.type === 'NONCLUSTERED')
    .map((i) => ({
      name: i.name,
      oldName: i.name,
      kind: i.primary ? 'PRIMARY' : i.unique ? 'UNIQUE' : 'INDEX',
      constraint: i.constraint,
      columns: i.columns.map((name) => ({ name, length: null, desc: i.descending.includes(name) })),
      // a primary key is clustered by default, other indexes nonclustered
      using: (i.primary ? i.type === 'CLUSTERED' : i.type === 'NONCLUSTERED') ? '' : i.type,
      comment: '',
      extra: [i.included.length ? `INCLUDE (${i.included.map(mssqlDialect.quoteIdentifier).join(', ')})` : '', i.filter ? `WHERE ${i.filter}` : '']
        .filter(Boolean)
        .join(' ')
    }))
  const foreignKeys: ForeignKeyDef[] = read.foreignKeys.map((f) => ({
    name: f.name,
    oldName: f.name,
    columns: f.columns,
    refSchema: f.refSchema === schema ? '' : f.refSchema,
    refTable: f.refTable,
    refColumns: f.refColumns,
    onDelete: f.onDelete,
    onUpdate: f.onUpdate
  }))
  return {
    name: table,
    columns,
    indexes,
    foreignKeys,
    otherDefinitions: read.checks.map((k) => `CONSTRAINT ${mssqlDialect.quoteIdentifier(k.name)} CHECK ${k.definition}`),
    options: { engine: '', charset: '', collation: '', rowFormat: '', autoIncrement: '', comment: read.comment, other: '', partition: '' }
  }
}
