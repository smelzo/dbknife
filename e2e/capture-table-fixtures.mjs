// Regenerates test/shared/sql/fixtures/<server>/<table>.sql: the SHOW CREATE TABLE
// output of the tables in e2e/table-fixture.sql on the docker test servers.
// node e2e/capture-table-fixtures.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import mysql from 'mysql2/promise'

const root = resolve(import.meta.dirname, '..')
const fixture = readFileSync(join(root, 'e2e/table-fixture.sql'), 'utf8')
// functional key parts exist only in MySQL
const mysqlOnly = 'CREATE TABLE te_scratch.functional (a INT, b INT, KEY fx ((a + b)), KEY plain_a (a))'

for (const [server, port] of [['mysql', 33061], ['mariadb', 33062]]) {
  const db = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root', password: 'test', multipleStatements: true })
  await db.query(fixture)
  if (server === 'mysql') await db.query(mysqlOnly)
  const [tables] = await db.query("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = 'te_scratch'")
  const dir = join(root, 'test/shared/sql/fixtures', server)
  mkdirSync(dir, { recursive: true })
  for (const { name } of tables) {
    const [[row]] = await db.query(`SHOW CREATE TABLE te_scratch.\`${name}\``)
    writeFileSync(join(dir, `${name}.sql`), row['Create Table'])
  }
  console.log(server, tables.map((t) => t.name).join(', '))
  await db.end()
}
