import { describe, expect, it } from 'vitest'
import { splitStatements, statementAt } from '@shared/sql/splitter'
import { applyRowLimit, referencedTables } from '@shared/sql/analyze'
import { quoteString } from '@shared/sql/quote'

const texts = (src: string): string[] => splitStatements(src).map((s) => s.text)

describe('splitStatements', () => {
  it('does not split on delimiters inside strings, identifiers and comments', () => {
    const src = "SELECT ';' AS a, `x;y` FROM t -- c;\n; /* ; */ SELECT \"it\\\"s;\"; # x;\nSELECT 3"
    expect(texts(src)).toEqual(["SELECT ';' AS a, `x;y` FROM t", 'SELECT "it\\"s;"', 'SELECT 3'])
  })

  it('honours the DELIMITER command, also when glued to END', () => {
    const src = [
      'DELIMITER $$',
      'CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END$$',
      'DELIMITER ;',
      'CALL p();'
    ].join('\n')
    expect(texts(src)).toEqual(['CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END', 'CALL p()'])
  })

  it('keeps executable comments as statements (mysqldump headers)', () => {
    expect(texts('/*!40101 SET NAMES utf8 */;\n-- plain\nSELECT 1;')).toEqual(['/*!40101 SET NAMES utf8 */', 'SELECT 1'])
  })

  it('treats -- without a following space as an operator, not a comment', () => {
    expect(texts('SELECT 1--1; SELECT 2')).toEqual(['SELECT 1--1', 'SELECT 2'])
  })
})

describe('statementAt', () => {
  const src = 'SELECT 1;\n\nSELECT 2;   \nSELECT 3'
  const stmts = splitStatements(src)
  it('picks the statement under the caret, including just after its delimiter', () => {
    expect(statementAt(stmts, src.indexOf('2'))?.text).toBe('SELECT 2')
    expect(statementAt(stmts, src.indexOf('2;') + 2)?.text).toBe('SELECT 2')
  })
  it('falls back to the preceding statement in the gap between statements', () => {
    expect(statementAt(stmts, src.indexOf('\n\n') + 1)?.text).toBe('SELECT 1')
  })
})

describe('applyRowLimit', () => {
  it('appends LIMIT to a select without one, before trailing comments', () => {
    expect(applyRowLimit('SELECT * FROM t -- note', 1000)).toBe('SELECT * FROM t LIMIT 0, 1000 -- note')
  })
  it('leaves statements with a top-level LIMIT, INTO or locking clause untouched', () => {
    for (const sql of [
      'SELECT * FROM t LIMIT 5',
      'SELECT a INTO @x FROM t',
      'SELECT * FROM t FOR UPDATE',
      'UPDATE t SET a = 1',
      'WITH c AS (SELECT 1) UPDATE t, c SET t.a = 1'
    ]) {
      expect(applyRowLimit(sql, 1000)).toBe(sql)
    }
  })
  it('ignores LIMIT inside subqueries', () => {
    expect(applyRowLimit('SELECT * FROM (SELECT * FROM t LIMIT 1) x', 10)).toBe(
      'SELECT * FROM (SELECT * FROM t LIMIT 1) x LIMIT 0, 10'
    )
  })
  it('does nothing when the limit is disabled', () => {
    expect(applyRowLimit('SELECT 1', 0)).toBe('SELECT 1')
  })
})

describe('referencedTables', () => {
  it('collects schema-qualified tables and aliases from FROM and JOIN', () => {
    expect(referencedTables('SELECT * FROM db.a x, c JOIN `b` AS y ON x.id = y.id WHERE 1')).toEqual([
      { schema: 'db', table: 'a', alias: 'x' },
      { schema: undefined, table: 'c', alias: undefined },
      { schema: undefined, table: 'b', alias: 'y' }
    ])
  })
})

describe('quoteString', () => {
  it('escapes quotes, backslashes and control characters', () => {
    expect(quoteString("a'b\\c\nd\0")).toBe("'a\\'b\\\\c\\nd\\0'")
  })
})
