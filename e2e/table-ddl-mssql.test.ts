// Applies the SQL Server table editor's DDL to the SQL Server test host (scratch schema
// te_scratch of the dbm_test_ed database, created by the test) and reads the table back with
// the editor's own loader: the model read back must be the edited one. Skipped without
// DBM_MSSQL_HOST:
//   DBM_MSSQL_HOST=<host> pnpm exec vitest run -c e2e/vitest.config.ts e2e/table-ddl-mssql.test.ts
import { Connection, Request, TYPES } from 'tedious'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ColumnDef, TableDef } from '@shared/sql/create-table'
import { alterTableSql, createTableSql } from '@shared/sql/table-ddl-mssql'
import { loadMssqlTable } from '../src/renderer/src/components/editors/table/load-mssql'

const host = process.env.DBM_MSSQL_HOST
const database = 'dbm_test_ed'
const schema = 'te_scratch'
let db: Connection

function connect(dbName: string): Promise<Connection> {
  const c = new Connection({
    server: host!,
    authentication: { type: 'default', options: { userName: 'dbm_test', password: 'test' } },
    options: { port: 1433, database: dbName, encrypt: true, trustServerCertificate: true, connectTimeout: 10000 }
  })
  return new Promise((ok, ko) => c.connect((e) => (e ? ko(e) : ok(c))))
}

/** Requests of the connection, one at a time (the catalog sends several at once). */
let queue: Promise<unknown> = Promise.resolve()

/** Rows of `sql`: a batch, or with parameters @p1... a parameterized query (sp_executesql), as the app's driver runs them. */
function query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
  const next = queue.then(() => request(sql, params))
  queue = next.catch(() => undefined)
  return next
}

function request(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
  return new Promise((ok, ko) => {
    const rows: Record<string, unknown>[] = []
    const r = new Request(sql, (e) => (e ? ko(new Error(`${(e as AggregateError).errors?.map((x) => x.message).join('\n') ?? e.message}\n${sql}`)) : ok(rows)))
    r.on('row', (cols) => rows.push(Object.fromEntries(cols.map((c: { metadata: { colName: string }; value: unknown }) => [c.metadata.colName, c.value]))))
    if (params?.length) {
      params.forEach((v, i) => r.addParameter(`p${i + 1}`, TYPES.NVarChar, String(v)))
      db.execSql(r)
    } else db.execSqlBatch(r)
  })
}

const load = (table: string): Promise<TableDef> => loadMssqlTable(query, schema, table)

const column = (c: Partial<ColumnDef> & Pick<ColumnDef, 'name' | 'type'>): ColumnDef => ({
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
  extra: '',
  ...c
})

/** The model without the bookkeeping of the editor (original names), indexes in the loader's order. */
const shape = (t: TableDef): unknown => {
  const plain = JSON.parse(JSON.stringify(t, (k, v) => (k === 'oldName' || k === 'defaultName' ? undefined : v))) as TableDef
  plain.indexes.sort((a, b) => Number(b.kind === 'PRIMARY') - Number(a.kind === 'PRIMARY') || (a.name < b.name ? -1 : 1))
  plain.foreignKeys.sort((a, b) => (a.name < b.name ? -1 : 1))
  return plain
}

/** Runs the statements in one transaction, rolled back when one fails. */
async function run(statements: string[]): Promise<void> {
  await query('BEGIN TRANSACTION')
  try {
    for (const sql of statements) await query(sql)
    await query('COMMIT')
  } catch (e) {
    await query('IF @@TRANCOUNT > 0 ROLLBACK')
    throw new Error(`${(e as Error).message}\n--- script:\n${statements.join('\n')}`)
  }
}

/** Applies `edit` to the loaded `plain` table through the generated DDL; returns [expected, actual, statements]. */
async function alter(edit: (t: TableDef) => void): Promise<[unknown, unknown, string[]]> {
  await query(`DROP TABLE IF EXISTS ${schema}.plain; DROP TABLE IF EXISTS ${schema}.renamed`)
  await query(`CREATE TABLE ${schema}.plain (
    id int IDENTITY(1,1) CONSTRAINT pk_plain PRIMARY KEY,
    name nvarchar(100) NOT NULL,
    code nvarchar(20) NULL CONSTRAINT uq_plain_code UNIQUE,
    qty nvarchar(10) NULL CONSTRAINT df_plain_qty DEFAULT N'1',
    parent_id int NULL,
    note nvarchar(max) NULL,
    created datetime2(3) NOT NULL DEFAULT SYSDATETIME()
  )`)
  await query(`CREATE INDEX plain_name ON ${schema}.plain (name) INCLUDE (code)`)
  await query(`CREATE INDEX plain_parent ON ${schema}.plain (parent_id DESC) WHERE parent_id IS NOT NULL`)
  await query(`INSERT INTO ${schema}.plain (name, code, qty) VALUES (N'a', N'x', N'5')`)
  const from = await load('plain')
  const to = structuredClone(from)
  edit(to)
  const statements = alterTableSql(schema, from, to)
  await run(statements)
  return [shape(to), shape(await load(to.name)), statements]
}

describe.skipIf(!host)('mssql table editor', () => {
  beforeAll(async () => {
    const master = await connect('master')
    db = master
    await query(`IF DB_ID('${database}') IS NULL CREATE DATABASE ${database}`)
    master.close()
    db = await connect(database)
    await query(`IF SCHEMA_ID('${schema}') IS NOT NULL BEGIN
      DROP TABLE IF EXISTS ${schema}.created; DROP TABLE IF EXISTS ${schema}.plain; DROP TABLE IF EXISTS ${schema}.renamed; DROP TABLE IF EXISTS ${schema}.parent
      DROP SCHEMA ${schema} END`)
    await query(`CREATE SCHEMA ${schema}`)
    await query(`CREATE TABLE ${schema}.parent (id int PRIMARY KEY, code nvarchar(20) UNIQUE)`)
  })
  afterAll(async () => {
    await query(`DROP TABLE IF EXISTS ${schema}.created; DROP TABLE IF EXISTS ${schema}.plain; DROP TABLE IF EXISTS ${schema}.renamed; DROP TABLE IF EXISTS ${schema}.parent`)
    await query(`DROP SCHEMA ${schema}`)
    db.close()
  })

  it('creates a table from a model and reads the same model back', async () => {
    await query(`DROP TABLE IF EXISTS ${schema}.created`)
    const t: TableDef = {
      name: 'created',
      columns: [
        column({ name: 'id', type: 'bigint', nullable: false, autoIncrement: true, extra: 'IDENTITY(10,5)' }),
        column({ name: 'name', type: 'nvarchar(40)', nullable: false, default: "N'x'", collation: 'Latin1_General_BIN2', comment: "it's the name" }),
        column({ name: 'qty', type: 'decimal(10,2)', default: '(0)' }),
        column({ name: 'twice', type: '', generated: { expression: '[qty]*(2)', storage: 'STORED' } }),
        column({ name: 'label', type: '', generated: { expression: "[name]+N'!'", storage: 'VIRTUAL' }, nullable: false }),
        column({ name: 'parent_id', type: 'int' })
      ],
      indexes: [
        { name: 'pk_created', kind: 'PRIMARY', constraint: true, columns: [{ name: 'id', length: null, desc: false }], using: 'NONCLUSTERED', comment: '', extra: '' },
        { name: 'created_name_key', kind: 'UNIQUE', constraint: true, columns: [{ name: 'name', length: null, desc: false }], using: '', comment: '', extra: '' },
        { name: 'created_qty', kind: 'INDEX', constraint: false, columns: [{ name: 'qty', length: null, desc: true }, { name: 'name', length: null, desc: false }], using: 'CLUSTERED', comment: '', extra: '' },
        { name: 'created_parent', kind: 'UNIQUE', constraint: false, columns: [{ name: 'parent_id', length: null, desc: false }], using: '', comment: '', extra: 'INCLUDE ([twice]) WHERE ([parent_id] IS NOT NULL)' }
      ],
      foreignKeys: [{ name: 'created_parent_fk', columns: ['parent_id'], refSchema: '', refTable: 'parent', refColumns: ['id'], onDelete: 'CASCADE', onUpdate: '' }],
      otherDefinitions: ['CONSTRAINT [created_qty_check] CHECK ([qty]>=(0))'],
      options: { engine: '', charset: '', collation: '', rowFormat: '', autoIncrement: '', comment: 'a table', other: '', partition: '' }
    }
    await run(createTableSql(schema, t))
    expect(shape(await load('created'))).toEqual(shape(t))
  })

  it('renames and retypes columns, with their defaults and indexes, and adds and drops columns', async () => {
    const [expected, actual] = await alter((t) => {
      const col = (n: string) => t.columns.find((c) => c.name === n)!
      // renamed column under an index; the index follows
      col('name').name = 'full_name'
      t.indexes.find((i) => i.name === 'plain_name')!.columns[0].name = 'full_name'
      // type change of a column with a default constraint and a changed default
      Object.assign(col('qty'), { type: 'int', default: '(2)', nullable: false })
      // type change of a column under a filtered index
      Object.assign(col('parent_id'), { type: 'bigint' })
      // type change of a column included in an index and in a UNIQUE constraint
      Object.assign(col('code'), { type: 'nchar(20)' })
      col('note').comment = 'free text'
      // a column with a (system-named) default constraint goes away
      t.columns = t.columns.filter((c) => c.name !== 'created')
      t.columns.push(column({ name: 'extra', type: 'nvarchar(10)', nullable: false, default: "N'none'", comment: 'added' }))
      // the server derives the nullability of a computed column that is not persisted (id * 2 can overflow)
      t.columns.push(column({ name: 'twice', type: '', generated: { expression: '[id]*(2)', storage: 'VIRTUAL' }, nullable: true }))
    })
    expect(actual).toEqual(expected)
  })

  it('drops, adds, changes and renames indexes, constraints and foreign keys, changes comments and renames the table', async () => {
    await query(`UPDATE ${schema}.plain SET note = N'n'`)
    const [expected, actual, statements] = await alter((t) => {
      t.indexes = t.indexes.filter((i) => i.name !== 'uq_plain_code')
      t.indexes.find((i) => i.name === 'plain_name')!.name = 'plain_by_name'
      t.indexes.find((i) => i.name === 'pk_plain')!.name = 'pk_renamed'
      t.indexes.push({ name: 'plain_qty', kind: 'UNIQUE', constraint: false, columns: [{ name: 'qty', length: null, desc: true }], using: '', comment: '', extra: '' })
      t.indexes.push({ name: 'uq_code', kind: 'UNIQUE', constraint: true, columns: [{ name: 'code', length: null, desc: false }], using: '', comment: '', extra: '' })
      t.foreignKeys.push({ name: 'plain_parent_fk', columns: ['parent_id'], refSchema: '', refTable: 'parent', refColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' })
      t.options.comment = "it's renamed"
      t.name = 'renamed'
    })
    expect(actual).toEqual(expected)
    expect(statements.filter((s) => s.startsWith('EXEC sp_rename')).length).toBe(3)
  })

  it('changes and removes comments, makes a column computed and changes nothing for an unchanged model', async () => {
    const [, , unchanged] = await alter(() => undefined)
    expect(unchanged).toEqual([])
    await run([`EXEC sys.sp_addextendedproperty N'MS_Description', N'old', N'SCHEMA', N'${schema}', N'TABLE', N'plain', N'COLUMN', N'note'`])
    const from = await load('plain')
    expect(from.columns.find((c) => c.name === 'note')!.comment).toBe('old')
    const to = structuredClone(from)
    to.columns.find((c) => c.name === 'note')!.comment = 'new'
    to.options.comment = 'table'
    Object.assign(to.columns.find((c) => c.name === 'qty')!, { type: '', default: '', generated: { expression: '[id]+(1)', storage: 'STORED' } })
    await run(alterTableSql(schema, from, to))
    expect(shape(await load('plain'))).toEqual(
      shape({ ...to, columns: [...to.columns.filter((c) => c.name !== 'qty'), to.columns.find((c) => c.name === 'qty')!] })
    )
    const again = structuredClone(to)
    again.columns.find((c) => c.name === 'note')!.comment = ''
    await run(alterTableSql(schema, await load('plain'), again))
    expect((await load('plain')).columns.find((c) => c.name === 'note')!.comment).toBe('')
  })
})
