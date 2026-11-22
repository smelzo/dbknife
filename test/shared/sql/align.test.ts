import { describe, expect, it } from 'vitest'
import {
  alignAction,
  chunkByBytes,
  compareTables,
  keysetParams,
  keysetWhere,
  rowChanges,
  type ColumnShape,
  type IndexPart,
  type TableShape
} from '@shared/sql/align'
import type { AlignKind, AlignStatus } from '@shared/types'

// The same table as information_schema describes it on MySQL 8.4 and on MariaDB 11.7
// (values measured, see "Come i due server descrivono la stessa tabella" in .claude/docs/piano-allineamento.md):
//   id int NOT NULL AUTO_INCREMENT, t tinyint DEFAULT NULL, big bigint unsigned NOT NULL,
//   flag tinyint(1) NOT NULL DEFAULT 0, z int zerofill, s1 varchar(20) DEFAULT 'NULL',
//   s2 varchar(20) DEFAULT 'it''s', s3 varchar(20) DEFAULT 'a\\b', n int NOT NULL DEFAULT 0,
//   m int DEFAULT (n+1), ts timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
//   g int AS (n*2) VIRTUAL, PRIMARY KEY (id), UNIQUE big_u (big), KEY n_desc (n DESC, s1),
//   CONSTRAINT probe_chk CHECK (n >= 0), CONSTRAINT probe_fk FOREIGN KEY (t) REFERENCES parent (id)
//   ON DELETE CASCADE ON UPDATE RESTRICT
const ci = 'utf8mb4_general_ci'
type Col = [name: string, type: string, nullable: string, def: string | null, extra: string, collation: string | null, generation: string | null]
const columns = (rows: Col[]): ColumnShape[] =>
  rows.map(([name, type, nullable, def, extra, collation, generation], i) => ({
    name,
    position: i + 1,
    type,
    nullable,
    default: def,
    extra,
    collation,
    generation,
    comment: '',
    srsId: null
  }))

const indexes = (expression: boolean): IndexPart[] =>
  (
    [
      ['PRIMARY', 0, 1, 'id', 'A'],
      ['big_u', 0, 1, 'big', 'A'],
      ['n_desc', 1, 1, 'n', 'D'],
      ['n_desc', 1, 2, 's1', 'A']
    ] as const
  ).map(([name, nonUnique, seq, column, collation]) => ({
    name,
    nonUnique,
    seq,
    column,
    subPart: null,
    type: 'BTREE',
    collation,
    comment: '',
    visible: true,
    ...(expression ? { expression: null } : {})
  }))

const shape = (flavor: 'mysql' | 'mariadb', schema: string, cols: Col[], check: string): TableShape => ({
  columns: columns(cols),
  indexes: indexes(flavor === 'mysql'),
  foreignKeys: [
    { name: 'probe_fk', columns: ['t'], refSchema: schema, refTable: 'parent', refColumns: ['id'], updateRule: 'RESTRICT', deleteRule: 'CASCADE' }
  ],
  checks: [{ name: 'probe_chk', clause: check, enforced: true }],
  table: { engine: 'InnoDB', collation: ci, createOptions: '', comment: '' },
  flavor,
  createTable: `CREATE TABLE \`probe\` (… ${flavor} …)`
})

const mysql = (): TableShape =>
  shape(
    'mysql',
    'src',
    [
      ['id', 'int', 'NO', null, 'auto_increment', null, ''],
      ['t', 'tinyint', 'YES', null, '', null, ''],
      ['big', 'bigint unsigned', 'NO', null, '', null, ''],
      ['flag', 'tinyint(1)', 'NO', '0', '', null, ''],
      ['z', 'int(10) unsigned zerofill', 'YES', null, '', null, ''],
      ['s1', 'varchar(20)', 'YES', 'NULL', '', ci, ''],
      ['s2', 'varchar(20)', 'YES', "it's", '', ci, ''],
      ['s3', 'varchar(20)', 'YES', 'a\\b', '', ci, ''],
      ['n', 'int', 'NO', '0', '', null, ''],
      ['m', 'int', 'YES', '(`n` + 1)', 'DEFAULT_GENERATED', null, ''],
      ['ts', 'timestamp', 'NO', 'CURRENT_TIMESTAMP', 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP', null, ''],
      ['g', 'int', 'YES', null, 'VIRTUAL GENERATED', null, '(`n` * 2)']
    ],
    '(`n` >= 0)'
  )

const mariadb = (): TableShape =>
  shape(
    'mariadb',
    'dst',
    [
      ['id', 'int(11)', 'NO', null, 'auto_increment', null, null],
      ['t', 'tinyint(4)', 'YES', 'NULL', '', null, null],
      ['big', 'bigint(20) unsigned', 'NO', null, '', null, null],
      ['flag', 'tinyint(1)', 'NO', '0', '', null, null],
      ['z', 'int(10) unsigned zerofill', 'YES', 'NULL', '', null, null],
      ['s1', 'varchar(20)', 'YES', "'NULL'", '', ci, null],
      ['s2', 'varchar(20)', 'YES', "'it''s'", '', ci, null],
      ['s3', 'varchar(20)', 'YES', "'a\\\\b'", '', ci, null],
      ['n', 'int(11)', 'NO', '0', '', null, null],
      ['m', 'int(11)', 'YES', '(`n` + 1)', '', null, null],
      ['ts', 'timestamp', 'NO', 'current_timestamp()', 'on update current_timestamp()', null, null],
      ['g', 'int(11)', 'YES', null, 'VIRTUAL GENERATED', null, '`n` * 2']
    ],
    '`n` >= 0'
  )

const col = (s: TableShape, name: string): ColumnShape => s.columns.find((c) => c.name === name)!

describe('compareTables between flavors', () => {
  // bug: every table recreated (and its rows copied again) at every run between MySQL and MariaDB
  it('a table described by MySQL 8.4 and by MariaDB 11.7 has the same structure', () => {
    expect(compareTables(mysql(), mariadb(), { src: 'dst' })).toEqual([])
    expect(compareTables(mariadb(), mysql(), { dst: 'src' })).toEqual([])
  })

  // bug: a normalization so loose that a real change of the target goes unnoticed (false "same")
  it('a normalization never hides a real difference', () => {
    const cases: [string, (s: TableShape, t: TableShape) => void, object][] = [
      ['extra column', (_, t) => t.columns.push({ ...col(t, 'n'), name: 'more', position: 13 }), { code: 'columnOnlyIn', params: { column: 'more', side: 'target' } }],
      ['type', (_, t) => (col(t, 'n').type = 'bigint(20)'), { code: 'columnDiffers', params: { column: 'n', property: 'COLUMN_TYPE' } }],
      ['index direction', (_, t) => (t.indexes.find((p) => p.name === 'n_desc' && p.seq === 1)!.collation = 'A'), { code: 'indexDiffers', params: { index: 'n_desc' } }],
      ['DELETE_RULE', (_, t) => (t.foreignKeys[0].deleteRule = 'SET NULL'), { code: 'foreignKeyDiffers', params: { name: 'probe_fk' } }],
      ['CHECK clause', (_, t) => (t.checks[0].clause = '`n` > 0'), { code: 'checkDiffers', params: { name: 'probe_chk' } }],
      ['engine', (_, t) => (t.table.engine = 'MyISAM'), { code: 'tableOptionDiffers', params: { property: 'ENGINE' } }],
      // MariaDB's unquoted NULL is DEFAULT NULL, the MySQL text NULL is DEFAULT 'NULL'
      // MariaDB writes a newline as \n inside the quotes; MySQL's bare text a\nb is a backslash and an n
      [
        'escape sequence in a string default',
        (s, t) => {
          col(s, 's3').default = 'a\\nb'
          col(t, 's3').default = "'a\\nb'"
        },
        { code: 'columnDiffers', params: { column: 's3', property: 'COLUMN_DEFAULT' } }
      ],
      ['CHECK NOT ENFORCED', (s) => (s.checks[0].enforced = false), { code: 'checkDiffers', params: { name: 'probe_chk' } }],
      ["DEFAULT NULL vs DEFAULT 'NULL'", (_, t) => (col(t, 's1').default = 'NULL'), { code: 'columnDiffers', params: { column: 's1', property: 'COLUMN_DEFAULT' } }],
      [
        'string literal inside an expression',
        (s, t) => {
          col(s, 'g').generation = "concat(code,'a b')"
          col(t, 'g').generation = "concat(code,'ab')"
        },
        { code: 'columnDiffers', params: { column: 'g', property: 'GENERATION_EXPRESSION' } }
      ],
      [
        'parentheses that do not enclose the whole expression',
        (s, t) => {
          col(s, 'g').generation = '(a) + (b)'
          col(t, 'g').generation = 'a + b'
        },
        { code: 'columnDiffers', params: { column: 'g', property: 'GENERATION_EXPRESSION' } }
      ]
    ]
    for (const [label, change, note] of cases) {
      const s = mysql()
      const t = mariadb()
      change(s, t)
      expect(compareTables(s, t, { src: 'dst' }), label).toMatchObject([note])
    }
    // the same DEFAULT 'NULL' / DEFAULT NULL with MariaDB as the source
    const s = mariadb()
    const t = mysql()
    col(t, 's1').default = null
    expect(compareTables(s, t, { dst: 'src' })).toMatchObject([{ code: 'columnDiffers', params: { column: 's1', property: 'COLUMN_DEFAULT' } }])
  })

  // bug: a generated column with a string recreated at every run, because MySQL escapes quotes and writes _latin1'…'
  it('MySQL escapes and charset introducers in generated expressions are not a difference', () => {
    const s = mysql()
    const t = mariadb()
    col(s, 'g').generation = "concat(`email`,_latin1\\'a b\\')"
    col(t, 'g').generation = "concat(`email`,'a b')"
    expect(compareTables(s, t, { src: 'dst' })).toEqual([])
  })
})

describe('compareTables with the same flavor', () => {
  // the SHOW CREATE TABLE of MySQL 8.4 before and after the table is created again from it (measured on dbm-test-mysql)
  const created = (column: string): string =>
    `CREATE TABLE \`padre\` (\n  \`id\` int NOT NULL,\n  \`nome\` varchar(20) ${column} NOT NULL,\n  PRIMARY KEY (\`id\`),\n  CONSTRAINT \`padre_chk\` CHECK ((\`id\` > 0))\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`
  const table = (createTable: string): TableShape => ({ ...mysql(), createTable })

  it("a table recreated from MySQL's SHOW CREATE TABLE is not different from its source", () => {
    const source = table(created('COLLATE utf8mb4_general_ci'))
    expect(compareTables(source, table(created('CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci')), {})).toEqual([])
    // the collation itself still counts
    expect(compareTables(source, table(created('CHARACTER SET latin1 COLLATE latin1_bin')), {})).not.toEqual([])
  })
})

describe('keyset paging', () => {
  // bug: an OR/AND expansion that skips or repeats rows between two blocks
  it('the keyset filter on a 3-column key returns exactly the tuples after the last one', () => {
    const tuples: number[][] = []
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) for (let c = 0; c < 3; c++) tuples.push([a, b, c])
    const where = keysetWhere(['a', 'b', 'c'])
    for (const last of tuples) {
      const params = keysetParams(last)
      let p = 0
      // the SQL condition as a JS expression on the row r
      const js = where
        .replace(/`(\w+)`/g, 'r.$1')
        .replace(/\?/g, () => JSON.stringify(params[p++]))
        .replace(/ = /g, ' === ')
        .replace(/\bOR\b/g, '||')
        .replace(/\bAND\b/g, '&&')
      expect(p).toBe(params.length)
      // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the test evaluates the generated condition as JavaScript on purpose
      const test = new Function('r', `return ${js}`) as (r: Record<string, number>) => boolean
      const after = tuples.filter(([a, b, c]) => test({ a, b, c }))
      expect(after, JSON.stringify(last)).toEqual(tuples.slice(tuples.indexOf(last) + 1))
    }
  })
})

describe('rowChanges', () => {
  // bug: NULL and '' taken as equal, binary values compared by instance, decimals compared as numbers
  it('compares NULL, binary values and decimal texts exactly', () => {
    const source = [null, Buffer.from([1, 2, 3]), '1.50', 'x']
    const target = ['', Buffer.from([1, 2, 3]), '1.5', 'x']
    expect(rowChanges(source, target)).toEqual([0, 2])
  })
})

describe('chunkByBytes', () => {
  // bug: ER_NET_PACKET_TOO_LARGE on wide rows; or a row lost or reordered while splitting
  it('a block never exceeds the packet budget', () => {
    const sizes = [10, 40, 30, 120, 5, 5, 50, 49, 1, 100, 100]
    const budget = 100
    const chunks = chunkByBytes(sizes, (s) => s, budget)
    expect(chunks.flat()).toEqual(sizes)
    for (const c of chunks) {
      if (c.length > 1) expect(c.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(budget)
    }
    expect(chunks).toContainEqual([120])
  })
})

describe('alignAction', () => {
  // bug: "structure only" (or "data" off) that empties or rewrites a table
  it('with data off no action writes rows', () => {
    const statuses: AlignStatus[] = ['same', 'different', 'sourceOnly', 'targetOnly']
    const kinds: AlignKind[] = ['table', 'sequence', 'view', 'procedure', 'function', 'trigger', 'event']
    for (const status of statuses)
      for (const kind of kinds)
        for (const structureDiffers of [false, true])
          for (const hasKey of [false, true])
            for (const inDrop of [false, true])
              for (const structure of [false, true]) {
                const input = { status, kind, structureDiffers, hasKey, inDrop }
                const { action } = alignAction(input, { structure, data: false, deleteRows: true, definers: 'keep', backup: true })
                expect(['syncRows', 'replaceRows'], JSON.stringify({ input, structure })).not.toContain(action)
                if (kind === 'table') expect(action, JSON.stringify({ input, structure })).not.toBe('recreate')
              }
  })
})
