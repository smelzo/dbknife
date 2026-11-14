import { describe, expect, it } from 'vitest'
import { splitStatements } from '@shared/sql/splitter'
import { applyRowLimit, referencedTables } from '@shared/sql/analyze'
import { postgresDialect, sqliteDialect } from '@shared/sql/dialect'
import { postgresRules, sqliteRules } from '@shared/sql/lexer'

const pg = (src: string): string[] => splitStatements(src, postgresRules).map((s) => s.text)
const lite = (src: string): string[] => splitStatements(src, sqliteRules).map((s) => s.text)

describe('PostgreSQL statement splitting', () => {
  it('keeps a dollar-quoted function body in one statement', () => {
    const body = 'CREATE FUNCTION f() RETURNS int AS $fn$ BEGIN PERFORM 1; RETURN 2; END $fn$ LANGUAGE plpgsql'
    expect(pg(`${body};\nSELECT 1;`)).toEqual([body, 'SELECT 1'])
    expect(pg('DO $$ BEGIN RAISE NOTICE \'x;\'; END $$; SELECT 2')).toEqual(["DO $$ BEGIN RAISE NOTICE 'x;'; END $$", 'SELECT 2'])
  })

  it('does not take positional parameters for dollar quotes', () => {
    expect(pg('SELECT $1; SELECT $2')).toEqual(['SELECT $1', 'SELECT $2'])
  })

  it('honours E-string escapes, nested comments and double-quoted identifiers', () => {
    expect(pg("SELECT E'it\\'s;'; SELECT 2")).toEqual(["SELECT E'it\\'s;'", 'SELECT 2'])
    // without nesting the comment would end at the first */ and leave `; */` as a statement
    expect(pg('SELECT 1 /* a /* b */ ; */; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2'])
    expect(pg('SELECT "a;b" FROM t; SELECT 2')).toEqual(['SELECT "a;b" FROM t', 'SELECT 2'])
  })

  it('treats a backslash as an ordinary character in standard strings', () => {
    expect(pg("SELECT 'a\\'; SELECT 2")).toEqual(["SELECT 'a\\'", 'SELECT 2'])
  })

  it('does not interpret DELIMITER, which is a mysql client command', () => {
    expect(pg('DELIMITER //\nSELECT 1;')).toEqual(['DELIMITER //\nSELECT 1'])
  })
})

describe('SQLite statement splitting', () => {
  it('keeps the BEGIN ... END body of a trigger in one statement, CASE included', () => {
    const trigger = [
      'CREATE TRIGGER t_ai AFTER INSERT ON t BEGIN',
      "  UPDATE t SET kind = CASE WHEN new.v > 0 THEN 'p' ELSE 'n' END WHERE id = new.id;",
      '  DELETE FROM log;',
      'END'
    ].join('\n')
    expect(lite(`${trigger};\nSELECT 1;`)).toEqual([trigger, 'SELECT 1'])
  })

  it('splits transaction statements that use BEGIN and END', () => {
    expect(lite('BEGIN; INSERT INTO t VALUES (1); END;')).toEqual(['BEGIN', 'INSERT INTO t VALUES (1)', 'END'])
  })

  it('accepts bracket, backtick and double-quoted identifiers', () => {
    expect(lite('SELECT [a;b], `c;d`, "e;f" FROM t; SELECT 2')).toEqual(['SELECT [a;b], `c;d`, "e;f" FROM t', 'SELECT 2'])
  })
})

describe('dialect-specific SQL', () => {
  it('appends LIMIT n, without the MySQL offset form', () => {
    expect(applyRowLimit('SELECT * FROM t', 50, postgresDialect)).toBe('SELECT * FROM t LIMIT 50')
    expect(applyRowLimit('SELECT * FROM t FETCH FIRST 5 ROWS ONLY', 50, postgresDialect)).toBe('SELECT * FROM t FETCH FIRST 5 ROWS ONLY')
  })

  it('quotes literals without backslash escapes and identifiers with double quotes', () => {
    expect(postgresDialect.literal("it's a\\b")).toBe("'it''s a\\b'")
    expect(postgresDialect.literal(new Uint8Array([1, 255]))).toBe("'\\x01ff'::bytea")
    expect(sqliteDialect.literal(new Uint8Array([1, 255]))).toBe("X'01ff'")
    expect(postgresDialect.qualified('my"s', 't')).toBe('"my""s"."t"')
  })

  it('resolves double-quoted table names and aliases', () => {
    expect(referencedTables('SELECT * FROM "Sales"."Order ""X""" o', postgresRules)).toEqual([
      { schema: 'Sales', table: 'Order "X"', alias: 'o' }
    ])
  })
})
