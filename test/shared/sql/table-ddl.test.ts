import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseCreateTable, type TableDef } from '@shared/sql/create-table'
import { alterTableSql, createTableSql } from '@shared/sql/table-ddl'

// SHOW CREATE TABLE output captured from MySQL 8.4 and MariaDB 11.4
const fixtures = join(__dirname, 'fixtures')
const fixture = (server: string, table: string): string => readFileSync(join(fixtures, server, `${table}.sql`), 'utf8')
const all = ['mysql', 'mariadb'].flatMap((s) => readdirSync(join(fixtures, s)).map((f) => [s, f.replace(/\.sql$/, '')]))

describe('parseCreateTable', () => {
  it.each([
    ['mysql', 'CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)', "concat(`v`,_utf8mb4' ',`e`)", '/*!80023 INVISIBLE */', '', '((`d` >= 0))'],
    ['mariadb', 'current_timestamp(3) ON UPDATE current_timestamp(3)', "concat(`v`,' ',`e`)", 'INVISIBLE', 'CHECK (json_valid(`j`))', '(`d` >= 0)']
  ])('reads the %s dialect', (server, tsDefault, generated, invisible, jsonCheck, check) => {
    const t = parseCreateTable(fixture(server, 'kitchen'))
    const col = (name: string) => t.columns.find((c) => c.name === name)!
    expect(col('id')).toMatchObject({ unsigned: true, autoIncrement: true, nullable: false, comment: "pk 'quoted'" })
    expect(col('t')).toMatchObject({ type: 'TINYINT(3)', unsigned: true, zerofill: true, default: 'NULL' })
    expect(col('v')).toMatchObject({ charset: 'utf8mb4', collation: 'utf8mb4_bin', nullable: false, default: "'x''y'" })
    expect(col('b').default).toBe("b'101'")
    expect(col('e').type).toBe("ENUM('a','b,c','d''e')")
    expect(col('ts').default).toBe(tsDefault)
    expect(col('full_name').generated).toEqual({ expression: generated, storage: 'VIRTUAL' })
    expect(col('stored_len').generated?.storage).toBe('STORED')
    expect(col('hidden').extra).toBe(invisible)
    expect(col('j').extra).toBe(jsonCheck)
    expect(t.indexes.find((i) => i.name === 'uq_v')).toMatchObject({
      kind: 'UNIQUE',
      columns: [
        { name: 'v', length: 10, desc: false },
        { name: 'dt', length: null, desc: true }
      ]
    })
    expect(t.indexes.find((i) => i.name === 'idx_combo')).toMatchObject({ using: 'BTREE', comment: 'combo idx' })
    expect(t.indexes.map((i) => i.kind)).toEqual(expect.arrayContaining(['PRIMARY', 'SPATIAL', 'FULLTEXT']))
    expect(t.foreignKeys.find((f) => f.name === 'fk_parent')).toMatchObject({
      columns: ['parent_id'],
      refTable: 'parent',
      refColumns: ['id'],
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE'
    })
    expect(t.otherDefinitions).toEqual([`CONSTRAINT \`chk_d\` CHECK ${check}`])
    expect(t.options).toMatchObject({ engine: 'InnoDB', autoIncrement: '100', rowFormat: 'DYNAMIC', comment: "kitchen 'sink'" })
  })

  it('keeps clauses it does not model: partitioning and functional key parts', () => {
    expect(parseCreateTable(fixture('mysql', 'parted')).options.partition).toMatch(/^\/\*!50100 PARTITION BY RANGE \(`yr`\)[\s\S]*\*\/$/)
    expect(parseCreateTable(fixture('mariadb', 'parted')).options.partition).toMatch(/^PARTITION BY RANGE \(`yr`\)[\s\S]*MAXVALUE ENGINE = InnoDB\)$/)
    const functional = parseCreateTable(fixture('mysql', 'functional'))
    expect(functional.indexes.map((i) => i.name)).toEqual(['plain_a'])
    expect(functional.otherDefinitions).toEqual(['KEY `fx` (((`a` + `b`)))'])
  })

  it.each(all)('reads back its own CREATE TABLE unchanged (%s %s)', (server, table) => {
    const t = parseCreateTable(fixture(server, table))
    expect(parseCreateTable(createTableSql('s', t))).toEqual(t)
  })
})

describe('alterTableSql', () => {
  const plain = (): [TableDef, TableDef] => {
    const from = parseCreateTable(fixture('mysql', 'plain'))
    return [from, structuredClone(from)]
  }
  const column = (t: TableDef, name: string) => t.columns.find((c) => c.name === name)!

  it('returns no statements when nothing changed', () => {
    expect(alterTableSql('s', ...plain())).toEqual([])
  })

  it('renames a column with CHANGE COLUMN, without rebuilding the index that uses it', () => {
    const [from, to] = plain()
    column(to, 'name').name = 'full_name'
    to.indexes.find((i) => i.name === 'idx_name')!.columns[0].name = 'full_name'
    const [sql, ...more] = alterTableSql('s', from, to)
    expect(more).toEqual([])
    expect(sql).toMatch(/CHANGE COLUMN `name` `full_name` VARCHAR\(100\) NOT NULL$/)
    expect(sql).not.toMatch(/DROP|ADD|AFTER|FIRST/)
  })

  it('moves a column with a single positioned CHANGE COLUMN', () => {
    const [from, to] = plain()
    const email = column(to, 'email')
    to.columns.splice(to.columns.indexOf(email), 1)
    to.columns.splice(to.columns.indexOf(column(to, 'notes')) + 1, 0, email)
    expect(alterTableSql('s', from, to)).toEqual([
      'ALTER TABLE `s`.`plain`\n  CHANGE COLUMN `email` `email` VARCHAR(150) NULL DEFAULT NULL AFTER `notes`'
    ])
  })

  it('changes the type of one column only', () => {
    const [from, to] = plain()
    column(to, 'notes').type = 'MEDIUMTEXT'
    const [sql] = alterTableSql('s', from, to)
    expect(sql.split('\n').slice(1)).toEqual(['  CHANGE COLUMN `notes` `notes` MEDIUMTEXT NULL'])
  })

  it('drops and adds indexes', () => {
    const [from, to] = plain()
    to.indexes = to.indexes.filter((i) => i.name !== 'idx_name')
    to.indexes.push({ name: 'idx_bal', kind: 'INDEX', columns: [{ name: 'balance', length: null, desc: true }], using: '', comment: '', extra: '' })
    const [sql] = alterTableSql('s', from, to)
    expect(sql).toContain('DROP INDEX `idx_name`')
    expect(sql).toContain('ADD INDEX `idx_bal` (`balance` DESC)')
    expect(sql).not.toMatch(/email_UNIQUE|PRIMARY/)
  })

  it('drops a changed foreign key in a statement that precedes the one adding it back', () => {
    const [from, to] = plain()
    to.foreignKeys[0].onDelete = 'SET NULL'
    const statements = alterTableSql('s', from, to)
    expect(statements).toHaveLength(2)
    expect(statements[0]).toBe('ALTER TABLE `s`.`plain`\n  DROP FOREIGN KEY `fk_plain_parent`')
    expect(statements[1]).toContain('ADD CONSTRAINT `fk_plain_parent` FOREIGN KEY (`parent_id`) REFERENCES `parent` (`id`) ON DELETE SET NULL')
  })
})
