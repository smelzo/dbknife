// Applies the PostgreSQL table editor's DDL to the docker test server (scratch
// schema te_scratch of the "postgres" database) and reads the table back with
// the editor's own loader: the model read back must be the edited one.
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { TableDef } from '@shared/sql/create-table'
import { alterTableSql, createTableSql } from '@shared/sql/table-ddl-postgres'
import { loadPostgresTable } from '../src/renderer/src/components/editors/table/load-postgres'

const schema = 'te_scratch'
let db: pg.Client

const query = async (sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> => (await db.query(sql, params)).rows
const load = (table: string): Promise<TableDef> => loadPostgresTable(query, schema, table)

/** Count of the expression index plain_expr, which the model does not represent, on `table`: an ALTER must leave it in place. */
const exprIndexes = async (table: string): Promise<number> =>
  ((await query(`SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 AND indexname = 'plain_expr'`, [schema, table])) as { n: number }[])[0].n

/** The model without the bookkeeping of the editor (original names), indexes in the loader's order. */
const shape = (t: TableDef): unknown => {
  const plain = JSON.parse(JSON.stringify(t, (k, v) => (k === 'oldName' ? undefined : v))) as TableDef
  plain.indexes.sort((a, b) => Number(b.kind === 'PRIMARY') - Number(a.kind === 'PRIMARY') || (a.name < b.name ? -1 : 1))
  return plain
}

/** Applies `edit` to the loaded `plain` table through ALTER; returns [expected, actual, statements]. */
async function alter(edit: (t: TableDef) => void): Promise<[unknown, unknown, string[]]> {
  await db.query(`DROP TABLE IF EXISTS ${schema}.plain, ${schema}.plain2, ${schema}.renamed`)
  await db.query(`CREATE TABLE ${schema}.plain (
    id serial PRIMARY KEY,
    name varchar(100) NOT NULL,
    code text UNIQUE,
    qty text DEFAULT '1',
    parent_id integer,
    note text,
    created timestamp DEFAULT now()
  )`)
  await db.query(`CREATE INDEX plain_name ON ${schema}.plain (name)`)
  await db.query(`CREATE INDEX plain_expr ON ${schema}.plain (lower(name))`)
  await db.query(`INSERT INTO ${schema}.plain (name, code, qty) VALUES ('a', 'x', '5')`)
  const from = await load('plain')
  const to = structuredClone(from)
  edit(to)
  const statements = alterTableSql(schema, from, to)
  await db.query('BEGIN')
  try {
    for (const sql of statements) await db.query(sql)
    await db.query('COMMIT')
  } catch (e) {
    await db.query('ROLLBACK')
    throw new Error(`${(e as Error).message}\n${statements.join(';\n')}`)
  }
  return [shape(to), shape(await load(to.name)), statements]
}

describe('postgres table editor', () => {
  beforeAll(async () => {
    db = new pg.Client({ host: '127.0.0.1', port: 33063, user: 'postgres', password: 'test', database: 'postgres' })
    await db.connect()
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`)
    await db.query(`CREATE TABLE ${schema}.parent (id integer PRIMARY KEY, code text UNIQUE)`)
  })
  afterAll(async () => {
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
    await db.end()
  })

  it('creates a table from a model and reads the same model back', async () => {
    const t: TableDef = {
      name: 'created',
      columns: [
        { name: 'id', type: 'bigint', nullable: false, autoIncrement: true },
        { name: 'name', type: 'character varying(40)', nullable: false, default: "'x'::character varying", collation: 'C', comment: "it's the name" },
        { name: 'qty', type: 'numeric(10,2)', default: '0' },
        { name: 'twice', type: 'numeric', generated: { expression: '(qty * (2)::numeric)', storage: 'STORED' as const } },
        { name: 'parent_id', type: 'integer' }
      ].map((c) => ({ unsigned: false, zerofill: false, binary: false, charset: '', collation: '', nullable: true, default: '', autoIncrement: false, generated: null, comment: '', extra: '', ...c })),
      indexes: [
        { name: 'created_pkey', kind: 'PRIMARY', constraint: true, columns: [{ name: 'id', length: null, desc: false }], using: '', comment: '', extra: '' },
        { name: 'created_name_key', kind: 'UNIQUE', constraint: true, columns: [{ name: 'name', length: null, desc: false }], using: '', comment: '', extra: '' },
        { name: 'created_qty', kind: 'INDEX', constraint: false, columns: [{ name: 'qty', length: null, desc: true }, { name: 'name', length: null, desc: false }], using: '', comment: 'by qty', extra: '' },
        { name: 'created_hash', kind: 'INDEX', constraint: false, columns: [{ name: 'parent_id', length: null, desc: false }], using: 'hash', comment: '', extra: '' }
      ],
      foreignKeys: [{ name: 'created_parent', columns: ['parent_id'], refSchema: '', refTable: 'parent', refColumns: ['id'], onDelete: 'CASCADE', onUpdate: '' }],
      otherDefinitions: ['CONSTRAINT "created_qty_check" CHECK (qty >= 0::numeric)'],
      options: { engine: '', charset: '', collation: '', rowFormat: '', autoIncrement: '', comment: 'a table', other: '', partition: '' }
    }
    for (const sql of createTableSql(schema, t)) await db.query(sql)
    expect(shape(await load('created'))).toEqual(shape(t))
  })

  it('renames, retypes, adds and drops columns, and turns a serial column into an identity', async () => {
    const [expected, actual] = await alter((t) => {
      const col = (n: string) => t.columns.find((c) => c.name === n)!
      Object.assign(col('id'), { autoIncrement: true, default: '' })
      col('name').name = 'full_name'
      t.indexes.find((i) => i.name === 'plain_name')!.columns[0].name = 'full_name'
      Object.assign(col('qty'), { type: 'integer', default: '2', nullable: false })
      col('note').comment = 'free text'
      t.columns = t.columns.filter((c) => c.name !== 'created')
      t.columns.push({ ...structuredClone(col('note')), name: 'extra', oldName: undefined, type: 'jsonb', default: "'{}'::jsonb", comment: '' })
    })
    expect(actual).toEqual(expected)
    // the index on lower(name) follows the renamed column
    expect(await exprIndexes('plain')).toBe(1)
  })

  it('drops, adds, changes and renames indexes, constraints and foreign keys, and renames the table', async () => {
    const [expected, actual] = await alter((t) => {
      t.indexes = t.indexes.filter((i) => i.name !== 'plain_code_key')
      Object.assign(t.indexes.find((i) => i.name === 'plain_name')!, { name: 'plain_by_name', comment: 'renamed' })
      t.indexes.push({ name: 'plain_qty', kind: 'UNIQUE', constraint: false, columns: [{ name: 'qty', length: null, desc: true }], using: '', comment: '', extra: '' })
      t.indexes.push({ name: 'plain_code_uq', kind: 'UNIQUE', constraint: true, columns: [{ name: 'code', length: null, desc: false }], using: '', comment: '', extra: '' })
      t.foreignKeys.push({ name: 'plain_parent', columns: ['parent_id'], refSchema: '', refTable: 'parent', refColumns: ['id'], onDelete: 'SET NULL', onUpdate: 'CASCADE' })
      t.options.comment = "it's renamed"
      t.name = 'renamed'
    })
    expect(actual).toEqual(expected)
    expect(await exprIndexes('renamed')).toBe(1)
  })

  it('changes nothing for an unchanged model', async () => {
    const [, , statements] = await alter(() => undefined)
    expect(statements).toEqual([])
  })
})
