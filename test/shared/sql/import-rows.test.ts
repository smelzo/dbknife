import { describe, expect, it } from 'vitest'
import { mssqlDialect, mysqlDialect, postgresDialect, sqliteDialect } from '@shared/sql/dialect'
import { importStatements, serverFilledColumn } from '@shared/sql/import-rows'

const columns = [
  { name: 'id', type: 'int' },
  { name: 'name', type: 'varchar(20)' }
]

describe('importStatements', () => {
  it('splits the rows in batches of at most 500 per INSERT', () => {
    const rows = Array.from({ length: 1001 }, (_, i) => [i, 'x'])
    const statements = importStatements(mysqlDialect, 's', 't', columns, rows)
    expect(statements).toHaveLength(3)
    // every row lands in exactly one statement
    expect(statements.map((s) => s.split('), (').length)).toEqual([500, 500, 1])
  })

  it('closes an INSERT before it exceeds maxBytes, a longer row alone, keeping every row in order', () => {
    const maxBytes = 1_048_576
    const sizes = [300_000, 300_000, 300_000, 300_000, maxBytes + 100_000, 300_000, 300_000]
    const rows = sizes.map((n, i) => [i, String.fromCharCode(97 + i).repeat(n)])
    const statements = importStatements(mysqlDialect, 's', 't', [{ name: 'id', type: 'int' }, { name: 'name', type: 'text' }], rows, 500, maxBytes)
    const head = 'INSERT INTO `s`.`t` (`id`, `name`) VALUES '
    const tuples = rows.map(([id, name]) => `(${id}, '${name}')`)
    expect(statements.length).toBeGreaterThan(1)
    for (const s of statements) {
      expect(s.startsWith(head)).toBe(true)
      if (s.length > maxBytes) expect(s).toBe(head + tuples[4])
    }
    expect(statements).toContain(head + tuples[4])
    expect(statements.map((s) => s.slice(head.length)).join(', ')).toBe(tuples.join(', '))
  })

  it('writes NULL for null', () => {
    const [sql] = importStatements(mysqlDialect, 's', 't', columns, [[null, null]])
    expect(sql).toBe('INSERT INTO `s`.`t` (`id`, `name`) VALUES (NULL, NULL)')
  })

  it('writes booleans and numbers into a column that is not numeric as text', () => {
    // PostgreSQL refuses an integer literal (1) into a boolean or jsonb column, and reads the text
    const pg = [
      { name: 'active', type: 'boolean' },
      { name: 'doc', type: 'jsonb' }
    ]
    expect(importStatements(postgresDialect, 'public', 't', pg, [[true, 12], [false, 1]])[0]).toBe(
      `INSERT INTO "public"."t" ("active", "doc") VALUES ('1', '12'), ('0', '1')`
    )
    // SQL Server types a VALUES list by precedence: (12), (N'A7') into nvarchar would fail converting 'A7' to int
    expect(importStatements(mssqlDialect, 'dbo', 't', [{ name: 'code', type: 'nvarchar(10)' }], [[12], ['A7']])[0]).toBe(
      "INSERT INTO [dbo].[t] ([code]) VALUES (N'12'), (N'A7')"
    )
  })

  it('writes booleans as 1/0 and numbers as numbers into a numeric column', () => {
    // MySQL BIT(1) takes 1, while '1' is the byte 0x31 and too long
    expect(importStatements(mysqlDialect, 's', 't', [{ name: 'flag', type: 'bit(1)' }], [[true], [false]])[0]).toBe(
      'INSERT INTO `s`.`t` (`flag`) VALUES (1), (0)'
    )
    expect(importStatements(postgresDialect, 'public', 't', [{ name: 'id', type: 'integer' }], [[12]])[0]).toBe(
      'INSERT INTO "public"."t" ("id") VALUES (12)'
    )
    // SQLite keeps a value as given in a column without a type or of type ANY: '12' would not match a = 12
    expect(importStatements(sqliteDialect, 'main', 't', [{ name: 'a', type: '' }, { name: 'b', type: 'ANY' }], [[12, 12]])[0]).toBe(
      'INSERT INTO "t" ("a", "b") VALUES (12, 12)'
    )
    // T-SQL decimal reads 1e-7 as a number, not the text N'1e-7'
    expect(importStatements(mssqlDialect, 'dbo', 't', [{ name: 'n', type: 'decimal(10,8)' }], [[1e-7]])[0]).toBe(
      'INSERT INTO [dbo].[t] ([n]) VALUES (1e-7)'
    )
  })

  // contract (owner, 14 nov 2026): a CSV cell is text; only the target column's type decides a conversion
  it('writes CSV text as it is into a text column', () => {
    const cells = ['+39123456', '1.10', '1e3', 'TRUE', 'false']
    for (const [dialect, type] of [
      [postgresDialect, 'text'],
      [sqliteDialect, 'TEXT'],
      [mysqlDialect, 'varchar(20)'],
      [mssqlDialect, 'nvarchar(20)']
    ] as const) {
      const sql = importStatements(dialect, 's', 't', [{ name: 'c', type }], cells.map((c) => [c]))[0]
      for (const c of cells) expect(sql, `${dialect.engine} ${c}`).toContain(`'${c}')`)
    }
  })

  it('converts the text true/false (any case) into a boolean column', () => {
    // SQLite keeps the text 'true' in a BOOLEAN column, where it is false in a condition
    expect(importStatements(sqliteDialect, 'main', 't', [{ name: 'active', type: 'BOOLEAN' }], [['true'], ['False']])[0]).toBe(
      `INSERT INTO "t" ("active") VALUES ('1'), ('0')`
    )
    expect(importStatements(postgresDialect, 'public', 't', [{ name: 'active', type: 'boolean' }], [['TRUE']])[0]).toBe(
      `INSERT INTO "public"."t" ("active") VALUES ('1')`
    )
    // MySQL BOOLEAN is TINYINT(1), which refuses the text 'true' in strict mode
    expect(importStatements(mysqlDialect, 's', 't', [{ name: 'active', type: 'tinyint(1)' }], [['true'], ['false']])[0]).toBe(
      'INSERT INTO `s`.`t` (`active`) VALUES (1), (0)'
    )
    expect(importStatements(mssqlDialect, 'dbo', 't', [{ name: 'active', type: 'bit' }], [['true']])[0]).toBe('INSERT INTO [dbo].[t] ([active]) VALUES (1)')
    // other text into a boolean column is left to the database
    expect(importStatements(postgresDialect, 'public', 't', [{ name: 'active', type: 'boolean' }], [['yes']])[0]).toBe(
      `INSERT INTO "public"."t" ("active") VALUES ('yes')`
    )
  })

  it("passes the target column's type to the literal", () => {
    // SQL Server: decimal text into a numeric column is a number, into a text column a string
    expect(importStatements(mssqlDialect, 'dbo', 't', columns, [['12', '12']])[0]).toBe("INSERT INTO [dbo].[t] ([id], [name]) VALUES (12, N'12')")
  })

  it('gives no statement for no rows', () => {
    expect(importStatements(postgresDialect, 'public', 't', columns, [])).toEqual([])
  })
})

// oracle: the `extra` texts of the catalogs (workspace/catalog/*.ts) for columns the server fills
describe('serverFilledColumn', () => {
  it('recognizes identity, auto_increment, serial, SQLite rowid alias and generated columns', () => {
    for (const extra of [
      'auto_increment',
      'AUTOINCREMENT',
      'rowid',
      'VIRTUAL GENERATED',
      'STORED GENERATED',
      'GENERATED ALWAYS AS IDENTITY',
      'GENERATED BY DEFAULT AS IDENTITY',
      'GENERATED ALWAYS AS ((a + b)) STORED',
      'serial',
      'IDENTITY(1,1)',
      'AS ([a]+[b]) PERSISTED'
    ])
      expect(serverFilledColumn(extra), extra).toBe(true)
  })

  it('leaves out defaults and other attributes', () => {
    for (const extra of ['', 'DEFAULT_GENERATED', 'DEFAULT_GENERATED on update CURRENT_TIMESTAMP', 'COLLATE Latin1_General_CI_AS'])
      expect(serverFilledColumn(extra), extra).toBe(false)
  })
})
