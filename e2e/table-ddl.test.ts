// Applies the table editor's generated DDL to the docker test servers (scratch
// schema te_scratch, see table-fixture.sql) and checks what the server reports back.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import mysql from 'mysql2/promise'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseCreateTable, type TableDef } from '@shared/sql/create-table'
import { alterTableSql, columnDefinition, createTableSql, foreignKeyDefinition, indexDefinition } from '@shared/sql/table-ddl'

const fixtures = join(__dirname, '../test/shared/sql/fixtures')
const schema = 'te_scratch'

/** Server view of a table model, independent of element order where the server reorders. */
const shape = (t: TableDef): unknown => ({
  name: t.name,
  columns: t.columns.map(columnDefinition),
  indexes: t.indexes.map((i) => indexDefinition(i)).sort(),
  foreignKeys: t.foreignKeys.map((f) => foreignKeyDefinition(f)).sort(),
  other: t.otherDefinitions,
  options: { ...t.options, autoIncrement: '' }
})

for (const [server, port] of [
  ['mysql', 33061],
  ['mariadb', 33062]
] as const) {
  describe(server, () => {
    let db: mysql.Connection
    const fixture = (table: string): string => readFileSync(join(fixtures, server, `${table}.sql`), 'utf8')
    const showCreate = async (table: string): Promise<string> => {
      const [rows] = await db.query<mysql.RowDataPacket[]>(`SHOW CREATE TABLE ${schema}.\`${table}\``)
      return rows[0]['Create Table']
    }
    /** Recreates `plain` from its fixture, applies `edit` through ALTER and returns [expected, actual]. */
    async function alter(edit: (t: TableDef) => void): Promise<[unknown, unknown, string[]]> {
      await db.query(`DROP TABLE IF EXISTS ${schema}.plain, ${schema}.plain2`)
      await db.query(createTableSql(schema, parseCreateTable(fixture('plain'))))
      const from = parseCreateTable(await showCreate('plain'))
      const to = structuredClone(from)
      edit(to)
      const statements = alterTableSql(schema, from, to)
      for (const sql of statements) await db.query(sql)
      return [shape(to), shape(parseCreateTable(await showCreate(to.name))), statements]
    }

    beforeAll(async () => {
      db = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: 'test', multipleStatements: true })
      await db.query(readFileSync(join(__dirname, 'table-fixture.sql'), 'utf8'))
    })
    afterAll(async () => {
      await db.query(`DROP DATABASE IF EXISTS ${schema}`)
      await db.end()
    })

    it('recreates every fixture table identically from the parsed model', async () => {
      // constraint names are unique per schema: replace each table
      await db.query('SET FOREIGN_KEY_CHECKS = 0')
      for (const file of readdirSync(join(fixtures, server))) {
        const name = file.replace(/\.sql$/, '')
        const original = fixture(name)
        await db.query(`DROP TABLE IF EXISTS ${schema}.\`${name}\``)
        await db.query(createTableSql(schema, parseCreateTable(original)))
        expect(await showCreate(name), name).toBe(original)
      }
      await db.query('SET FOREIGN_KEY_CHECKS = 1')
    })

    it('renames, reorders, retypes, adds and drops columns keeping the indexes on renamed columns', async () => {
      const [expected, actual] = await alter((t) => {
        const col = (n: string) => t.columns.find((c) => c.name === n)!
        col('name').name = 'full_name'
        t.indexes.find((i) => i.name === 'idx_name')!.columns[0].name = 'full_name'
        col('notes').type = 'MEDIUMTEXT'
        const email = col('email')
        t.columns.splice(t.columns.indexOf(email), 1)
        t.columns.splice(t.columns.indexOf(col('notes')) + 1, 0, email)
        t.columns = t.columns.filter((c) => c.name !== 'active')
        t.columns.unshift({ ...structuredClone(col('parent_id')), name: 'first_col', oldName: undefined })
      })
      expect(actual).toEqual(expected)
    })

    it('drops, adds, changes and renames indexes and the primary key', async () => {
      const [expected, actual] = await alter((t) => {
        t.indexes = t.indexes.filter((i) => i.name !== 'idx_name')
        t.indexes.find((i) => i.name === 'fk_plain_parent_idx')!.name = 'parent_idx'
        t.indexes.find((i) => i.name === 'email_UNIQUE')!.columns[0].length = 20
        t.indexes.find((i) => i.kind === 'PRIMARY')!.columns.push({ name: 'name', length: null, desc: false })
        t.indexes.push({ name: 'idx_bal', kind: 'INDEX', columns: [{ name: 'balance', length: null, desc: false }, { name: 'created_at', length: null, desc: true }], using: '', comment: 'by balance', extra: '' })
      })
      expect(actual).toEqual(expected)
    })

    it('changes a foreign key in place and renames the table with new options', async () => {
      const [expected, actual] = await alter((t) => {
        Object.assign(t.foreignKeys[0], { onDelete: 'SET NULL', onUpdate: 'CASCADE' })
        Object.assign(t.options, { comment: "it's renamed", rowFormat: 'COMPACT' })
        t.name = 'plain2'
      })
      expect(actual).toEqual(expected)
    })
  })
}
