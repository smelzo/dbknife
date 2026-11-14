import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { TableDef } from '@shared/sql/create-table'
import { alterTableSql, createTableSql } from '@shared/sql/table-ddl-sqlite'
import type { Row } from '@shared/types'
import { loadSqliteTable } from '@/components/editors/table/load-sqlite'

// The table editor's SQLite statements run against SQLite itself: what it
// reports about the tables is the oracle.

const kitchen = `CREATE TABLE parent (id INTEGER PRIMARY KEY, code TEXT UNIQUE);
CREATE TABLE kitchen (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name VARCHAR(40) NOT NULL DEFAULT 'x''y' COLLATE NOCASE,
  qty NUMERIC DEFAULT -1 CHECK (qty >= -1),
  created DATETIME DEFAULT CURRENT_TIMESTAMP,
  bin BLOB DEFAULT X'00ff',
  expr REAL DEFAULT (1.5 * 2),
  parent_id INTEGER REFERENCES parent ON DELETE CASCADE,
  code TEXT CONSTRAINT fk_code REFERENCES parent (code) ON UPDATE SET NULL,
  shout TEXT GENERATED ALWAYS AS (name || '!') VIRTUAL,
  twice INTEGER AS (qty * 2) STORED,
  "odd ""name""" DOUBLE PRECISION,
  u TEXT UNIQUE,
  CONSTRAINT uq_pair UNIQUE (name, qty DESC),
  CONSTRAINT chk CHECK (length(name) > 0),
  FOREIGN KEY (code) REFERENCES parent (code) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX idx_qty ON kitchen (qty DESC, name);
CREATE INDEX idx_lower ON kitchen (lower(name));
CREATE TRIGGER kitchen_ai AFTER INSERT ON kitchen BEGIN UPDATE kitchen SET qty = qty + 1 WHERE id = NEW.id; END;`

function open(sql: string): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(sql)
  return db
}

const query = (db: DatabaseSync) => async (sql: string, params: unknown[] = []): Promise<Row[]> =>
  db.prepare(sql).all(...(params as never[])) as Row[]

const run = (db: DatabaseSync, statements: string[]): void => statements.forEach((s) => db.exec(s))

/** What SQLite reports about a table: columns, indexes with their keys, foreign keys, AUTOINCREMENT. */
function describeTable(db: DatabaseSync, table: string): unknown {
  const all = (sql: string, ...p: string[]): unknown[] => db.prepare(sql).all(...p).map((r) => ({ ...r }))
  return {
    columns: all('SELECT name, type, "notnull", dflt_value, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid', table),
    indexes: all(
      `SELECT il."unique", il.origin, il.partial,
         (SELECT group_concat(coalesce(ii.name, '?') || ii."desc" || ii.coll, ',' ORDER BY ii.seqno) FROM pragma_index_xinfo(il.name) ii WHERE ii.key) AS cols
       FROM pragma_index_list(?) il ORDER BY cols`,
      table
    ),
    // a key without columns references the parent's primary key
    foreignKeys: all(
      `SELECT "table", "from", coalesce("to", (SELECT name FROM pragma_table_info(f."table") WHERE pk = 1)) AS "to", on_update, on_delete, "match"
       FROM pragma_foreign_key_list(?) f ORDER BY "from", "to"`,
      table
    ),
    autoincrement: /AUTOINCREMENT/i.test(String(db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(table)?.sql))
  }
}

describe('SQLite table editor', () => {
  it('reads a table and creates the same table again from the model', async () => {
    const db = open(kitchen)
    const t = await loadSqliteTable(query(db), 'main', 'kitchen')
    const col = (name: string) => t.columns.find((c) => c.name === name)!
    expect(col('id').autoIncrement).toBe(true)
    expect(col('name')).toMatchObject({ nullable: false, default: "'x''y'", collation: 'NOCASE' })
    expect(col('qty')).toMatchObject({ default: '-1', extra: 'CHECK (qty >= -1)' })
    expect(col('bin').default).toBe("X'00ff'")
    expect(col('shout').generated).toEqual({ expression: "name || '!'", storage: 'VIRTUAL' })
    expect(col('twice').generated?.storage).toBe('STORED')
    // the implicit parent key is spelled out
    expect(t.foreignKeys.find((f) => f.columns[0] === 'parent_id')).toMatchObject({ refTable: 'parent', refColumns: ['id'], onDelete: 'CASCADE' })
    expect(t.otherDefinitions).toHaveLength(2)
    expect(t.indexes.map((i) => [i.name, i.kind, !!i.constraint])).toEqual([
      ['PRIMARY', 'PRIMARY', true],
      ['', 'UNIQUE', true],
      ['uq_pair', 'UNIQUE', true],
      ['idx_qty', 'INDEX', false]
    ])
    expect(t.dependents).toHaveLength(2)

    const copy = open('CREATE TABLE parent (id INTEGER PRIMARY KEY, code TEXT UNIQUE)')
    run(copy, createTableSql('main', t))
    expect(describeTable(copy, 'kitchen')).toEqual(describeTable(db, 'kitchen'))
  })

  it('rebuilds a table keeping its rows, the rows of child tables, its indexes, triggers and views', async () => {
    const db = open(`CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT, note TEXT);
      CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent ON DELETE CASCADE);
      CREATE INDEX parent_name ON parent (name);
      CREATE TABLE audit (msg TEXT);
      CREATE TRIGGER parent_ai AFTER INSERT ON parent BEGIN INSERT INTO audit VALUES (NEW.name); END;
      CREATE VIEW parent_names AS SELECT name FROM parent;
      INSERT INTO parent (id, name, note) VALUES (1, 'a', 'x'), (2, 'b', 'y');
      INSERT INTO child (parent_id) VALUES (1), (1), (2);`)
    const from = await loadSqliteTable(query(db), 'main', 'parent')
    const to: TableDef = structuredClone(from)
    // a type change and a dropped column need a rebuild; the rename follows into index, trigger and view
    to.columns[1] = { ...to.columns[1], name: 'title', type: 'VARCHAR(20)' }
    to.columns.splice(2, 1)
    to.indexes.find((i) => i.name === 'parent_name')!.columns[0].name = 'title'
    const statements = alterTableSql('main', from, to)
    expect(statements).toContain('DROP TABLE "parent"')
    run(db, statements)

    expect(db.prepare('SELECT count(*) AS n FROM child').get()!.n).toBe(3)
    expect(db.prepare('SELECT id, title FROM parent ORDER BY id').all().map((r) => ({ ...r }))).toEqual([
      { id: 1, title: 'a' },
      { id: 2, title: 'b' }
    ])
    expect(db.prepare("SELECT type FROM pragma_table_info('parent') WHERE name = 'title'").get()!.type).toBe('VARCHAR(20)')
    expect(db.prepare("SELECT count(*) AS n FROM pragma_index_info('parent_name') WHERE name = 'title'").get()!.n).toBe(1)
    db.exec("INSERT INTO parent (id, title) VALUES (3, 'c')")
    expect(db.prepare('SELECT msg FROM audit').all().map((r) => r.msg)).toEqual(['a', 'b', 'c'])
    expect(db.prepare('SELECT count(*) AS n FROM parent_names').get()!.n).toBe(3)
    expect(db.prepare('SELECT foreign_keys AS on_ FROM pragma_foreign_keys').get()!.on_).toBe(1)
    expect(db.prepare('SELECT legacy_alter_table AS on_ FROM pragma_legacy_alter_table').get()!.on_).toBe(0)
  })

  it('renames and adds trailing columns with ALTER TABLE instead of rebuilding', async () => {
    const db = open("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT); CREATE INDEX t_a ON t (a); INSERT INTO t VALUES (1, 'x');")
    const from = await loadSqliteTable(query(db), 'main', 't')
    const to: TableDef = structuredClone(from)
    to.name = 'u'
    to.columns[1].name = 'b'
    to.indexes[1].columns[0].name = 'b'
    to.columns.push({ ...to.columns[1], oldName: undefined, name: 'c', type: 'INTEGER', nullable: false, default: '7' })
    const statements = alterTableSql('main', from, to)
    expect(statements.some((s) => s.startsWith('DROP TABLE'))).toBe(false)
    run(db, statements)
    expect({ ...db.prepare('SELECT * FROM u').get() }).toEqual({ id: 1, b: 'x', c: 7 })
    expect(db.prepare("SELECT tbl_name FROM sqlite_master WHERE name = 't_a'").get()!.tbl_name).toBe('u')
  })

  it('changes nothing when the model is unchanged', async () => {
    const db = open(kitchen)
    const from = await loadSqliteTable(query(db), 'main', 'kitchen')
    expect(alterTableSql('main', from, structuredClone(from))).toEqual([])
  })
})
