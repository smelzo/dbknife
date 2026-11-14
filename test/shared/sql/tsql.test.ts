import { describe, expect, it } from 'vitest'
import { splitStatements } from '@shared/sql/splitter'
import { applyRowLimit, referencedTables } from '@shared/sql/analyze'
import { mssqlDialect, mysqlDialect } from '@shared/sql/dialect'
import { significantTokens, tsqlRules, unquoteIdentifier } from '@shared/sql/lexer'

const split = (src: string): string[] => splitStatements(src, tsqlRules).map((s) => s.text)
const limit = (sql: string): string => applyRowLimit(sql, 50, mssqlDialect)

describe('T-SQL batches', () => {
  it('ends the statement at GO alone on a line, with a count or a comment', () => {
    const statements = splitStatements('SELECT 1\nGO\nSELECT 2\n  go 3 -- again\nSELECT 3', tsqlRules)
    expect(statements.map((s) => s.text)).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3'])
    expect(statements.map((s) => s.delimiter)).toEqual(['GO', 'GO', ';'])
    expect(statements.map((s) => s.goCount)).toEqual([undefined, 3, undefined])
  })

  it('does not take GO inside strings, comments or a line for a separator', () => {
    const src = "SELECT 'a\nGO\nb'\n/* x\nGO\n*/ SELECT 2 GO\nSELECT 3"
    expect(split(src)).toEqual([src])
  })

  it('keeps procedure, function, trigger and view bodies whole up to GO', () => {
    const proc = 'CREATE PROCEDURE dbo.p AS\nSET NOCOUNT ON;\nSELECT 1;\nSELECT 2;'
    const alter = 'CREATE OR ALTER FUNCTION f() RETURNS int AS BEGIN DECLARE @x int; SET @x = 1; RETURN @x; END;'
    const view = 'ALTER VIEW v AS SELECT 1 AS a;'
    expect(split(`${proc}\nGO\n${alter}\nGO\n${view}`)).toEqual([proc, alter, view])
  })

  it('does not split inside BEGIN ... END blocks, TRY/CATCH and CASE included', () => {
    const block = [
      'IF @x = 1',
      'BEGIN',
      '  BEGIN TRY',
      "    UPDATE t SET k = CASE WHEN v > 0 THEN 'p' ELSE 'n' END;",
      '    DELETE FROM log;',
      '  END TRY',
      '  BEGIN CATCH',
      '    THROW;',
      '  END CATCH',
      'END'
    ].join('\n')
    expect(split(`${block};\nSELECT 1;`)).toEqual([block, 'SELECT 1'])
  })

  it('tells statements starting with BEGIN or END from block delimiters', () => {
    expect(split('BEGIN TRAN; UPDATE t SET a = 1; COMMIT; BEGIN TRANSACTION x; ROLLBACK')).toEqual([
      'BEGIN TRAN',
      'UPDATE t SET a = 1',
      'COMMIT',
      'BEGIN TRANSACTION x',
      'ROLLBACK'
    ])
    expect(split("BEGIN DIALOG @h FROM SERVICE s TO SERVICE 't'; IF @h IS NOT NULL BEGIN END CONVERSATION @h; SELECT 1; END; SELECT 2")).toEqual([
      "BEGIN DIALOG @h FROM SERVICE s TO SERVICE 't'",
      'IF @h IS NOT NULL BEGIN END CONVERSATION @h; SELECT 1; END',
      'SELECT 2'
    ])
  })

  it('does not split before ELSE', () => {
    expect(split('IF @x = 1 SELECT 1; ELSE SELECT 2; SELECT 3')).toEqual(['IF @x = 1 SELECT 1; ELSE SELECT 2', 'SELECT 3'])
  })

  it('keeps statements without semicolons together', () => {
    expect(split('SELECT 1\nSELECT 2')).toEqual(['SELECT 1\nSELECT 2'])
  })

  it('honours brackets, N strings, nested comments and -- without a space', () => {
    const src = "SELECT [a]];b], N'it''s;', \"c;d\" FROM t /* a /* b */ ; */ --x;\n; SELECT 1--1\n; SELECT 'a\\'; SELECT 2"
    expect(split(src)).toEqual(["SELECT [a]];b], N'it''s;', \"c;d\" FROM t", 'SELECT 1', "SELECT 'a\\'", 'SELECT 2'])
  })
})

describe('T-SQL lexing', () => {
  it('reads temporary table names and N strings as single tokens', () => {
    expect(significantTokens("SELECT * FROM ##g JOIN #t ON N'x' = 1", tsqlRules).map((t) => [t.type, t.text])).toEqual([
      ['word', 'SELECT'],
      ['symbol', '*'],
      ['word', 'FROM'],
      ['word', '##g'],
      ['word', 'JOIN'],
      ['word', '#t'],
      ['word', 'ON'],
      ['string', "N'x'"],
      ['symbol', '='],
      ['number', '1']
    ])
  })

  it('unquotes bracket identifiers with doubled closing brackets', () => {
    expect(unquoteIdentifier('[a]]b]')).toBe('a]b')
    expect(referencedTables('SELECT * FROM [Sales].[Order ]]X]]] o JOIN #tmp t ON 1 = 1', tsqlRules)).toEqual([
      { schema: 'Sales', table: 'Order ]X]', alias: 'o' },
      { schema: undefined, table: '#tmp', alias: 't' }
    ])
  })
})

describe('T-SQL row limit', () => {
  it('puts TOP after SELECT [ALL | DISTINCT] of the main query', () => {
    expect(limit('SELECT * FROM t')).toBe('SELECT TOP (50) * FROM t')
    expect(limit('select distinct a FROM t ORDER BY a')).toBe('select distinct TOP (50) a FROM t ORDER BY a')
    expect(limit('WITH c AS (SELECT a FROM t) SELECT a FROM c')).toBe('WITH c AS (SELECT a FROM t) SELECT TOP (50) a FROM c')
    expect(limit('SELECT * FROM (SELECT TOP 1 a FROM t) x')).toBe('SELECT TOP (50) * FROM (SELECT TOP 1 a FROM t) x')
  })

  it('leaves queries that cannot take a TOP untouched', () => {
    for (const sql of [
      'SELECT TOP 5 * FROM t',
      'SELECT * FROM t ORDER BY a OFFSET 10 ROWS',
      'SELECT * FROM t ORDER BY a OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY',
      'SELECT a INTO #tmp FROM t',
      'SELECT a FROM t FOR XML PATH',
      'SELECT a FROM t FOR JSON AUTO',
      'SELECT a FROM t UNION ALL SELECT b FROM u',
      'SELECT a FROM t EXCEPT SELECT b FROM u',
      'WITH c AS (SELECT 1 AS a) UPDATE t SET a = 1',
      '(SELECT a FROM t) ORDER BY a'
    ]) {
      expect(limit(sql)).toBe(sql)
    }
  })
})

describe('T-SQL quoting', () => {
  const datetime = { type: 'datetime' }

  it('quotes identifiers with brackets and strings as N literals', () => {
    expect(mssqlDialect.qualified('my]s', 't')).toBe('[my]]s].[t]')
    expect(mssqlDialect.literal("it's a\\b")).toBe("N'it''s a\\b'")
    expect(mssqlDialect.literal(new Uint8Array([1, 255]))).toBe('0x01ff')
    expect(mssqlDialect.insertDefaults('[t]')).toBe('INSERT INTO [t] DEFAULT VALUES')
  })

  it('writes date/time values of datetime columns in ISO 8601 form, independent of DATEFORMAT', () => {
    expect(mssqlDialect.literal('2026-10-26 14:00:00.000', datetime)).toBe("'2026-10-26T14:00:00.000'")
    expect(mssqlDialect.literal('2026-10-26 14:00', { type: 'smalldatetime' })).toBe("'2026-10-26T14:00:00'")
    expect(mssqlDialect.literal('2026-10-26', datetime)).toBe("'2026-10-26T00:00:00'")
    expect(mssqlDialect.literal('2026-10-26 14:00:00.1234567', { type: 'datetime2(7)' })).toBe("'2026-10-26T14:00:00.1234567'")
    expect(mssqlDialect.literal('2026-10-26 14:00:00 +02:00', { type: 'DATETIMEOFFSET' })).toBe("'2026-10-26T14:00:00+02:00'")
  })

  it('writes decimal numbers of numeric columns without quotes', () => {
    expect(mssqlDialect.literal('123.45', { type: 'decimal(10,2)' })).toBe('123.45')
    expect(mssqlDialect.literal('-0.5', { type: 'money' })).toBe('-0.5')
    expect(mssqlDialect.literal('+12', { type: 'NUMERIC(5,0)' })).toBe('+12')
    expect(mssqlDialect.literal('9223372036854775807', { type: 'bigint' })).toBe('9223372036854775807')
  })

  it('keeps text that is not a plain number quoted in numeric columns, for the server to reject', () => {
    for (const v of ['1e5', '12,5', '1.2.3', ' 1', '1;DROP TABLE t', '-', '', '0x10']) {
      expect(mssqlDialect.literal(v, { type: 'decimal(10,2)' })).toBe(`N'${v}'`)
    }
    expect(mssqlDialect.literal('123', { type: 'nvarchar(10)' })).toBe("N'123'")
    expect(mssqlDialect.literal('123')).toBe("N'123'")
  })

  it('leaves other values and columns as plain literals', () => {
    expect(mssqlDialect.literal('26/10/2026', datetime)).toBe("N'26/10/2026'")
    expect(mssqlDialect.literal('2026-10-26 14:00:00', { type: 'nvarchar' })).toBe("N'2026-10-26 14:00:00'")
    expect(mssqlDialect.literal(null, datetime)).toBe('NULL')
    expect(mysqlDialect.literal('2026-10-26 14:00:00', datetime)).toBe("'2026-10-26 14:00:00'")
  })
})
