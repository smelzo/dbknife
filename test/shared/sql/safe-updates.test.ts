import { describe, expect, it } from 'vitest'
import { dialectFor } from '@shared/sql/dialect'
import { violatesSafeUpdates } from '@shared/sql/safe-updates'

const postgres = dialectFor('postgres').rules
const mssql = dialectFor('mssql').rules
const sqlite = dialectFor('sqlite').rules
const engines = { postgres, mssql, sqlite }

describe('violatesSafeUpdates', () => {
  it('refuses UPDATE and DELETE without a top-level WHERE', () => {
    for (const [engine, rules] of Object.entries(engines)) {
      for (const sql of [
        'UPDATE t SET a = 1',
        'DELETE FROM t',
        'WITH x AS (SELECT 1) DELETE FROM t',
        'UPDATE t SET a = (SELECT b FROM u WHERE u.id = 1)',
        'UPDATE t SET a = CASE WHEN b THEN 1 END',
        "UPDATE t SET a = 'x WHERE y'"
      ]) {
        expect(violatesSafeUpdates(sql, rules), `${engine}: ${sql}`).toBe(true)
      }
    }
    expect(violatesSafeUpdates('DELETE TOP (10) FROM t', mssql)).toBe(true)
  })

  it('checks every UPDATE and DELETE of a T-SQL batch without semicolons', () => {
    for (const sql of [
      'SELECT * FROM t\nDELETE FROM t',
      'SET NOCOUNT ON\nDELETE FROM t',
      'DELETE FROM t WHERE id = 1\nDELETE FROM u',
      'BEGIN TRANSACTION\nUPDATE t SET a = 1\nCOMMIT'
    ]) {
      expect(violatesSafeUpdates(sql, mssql), sql).toBe(true)
    }
    expect(violatesSafeUpdates('UPDATE t SET a = 1 WHERE id = 1\nSELECT * FROM t', mssql)).toBe(false)
  })

  it('allows statements with a top-level WHERE and statements that are not UPDATE or DELETE', () => {
    for (const [engine, rules] of Object.entries(engines)) {
      for (const sql of [
        'UPDATE t SET a = 1 WHERE id = 2',
        'SELECT * FROM t',
        'EXPLAIN UPDATE t SET a = 1',
        'UPDATE t SET a = CASE WHEN b THEN 1 ELSE 0 END WHERE id = 1'
      ]) {
        expect(violatesSafeUpdates(sql, rules), `${engine}: ${sql}`).toBe(false)
      }
    }
    expect(violatesSafeUpdates('DELETE FROM t USING u WHERE t.id = u.id', postgres)).toBe(false)
    expect(violatesSafeUpdates('WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x', postgres)).toBe(false)
    expect(violatesSafeUpdates('CREATE PROCEDURE p AS UPDATE t SET a = 1', mssql)).toBe(false)
    expect(violatesSafeUpdates('GRANT UPDATE ON t TO u', postgres)).toBe(false)
    expect(violatesSafeUpdates('UPDATE t SET a = if(b, 1, 0) WHERE id = 1', sqlite)).toBe(false)
    expect(violatesSafeUpdates('UPDATE STATISTICS t', mssql)).toBe(false)
  })

  it('checks the statement that EXPLAIN ANALYZE runs on PostgreSQL', () => {
    for (const sql of [
      'EXPLAIN ANALYZE DELETE FROM t',
      'EXPLAIN ANALYSE VERBOSE UPDATE t SET a = 1',
      'EXPLAIN (ANALYZE, BUFFERS) DELETE FROM t',
      'EXPLAIN (FORMAT JSON, ANALYZE TRUE) WITH x AS (SELECT 1) DELETE FROM t'
    ]) {
      expect(violatesSafeUpdates(sql, postgres), sql).toBe(true)
    }
    for (const sql of [
      'EXPLAIN ANALYZE DELETE FROM t WHERE id = 1',
      'EXPLAIN ANALYZE SELECT * FROM t',
      'EXPLAIN (ANALYZE FALSE) DELETE FROM t',
      'EXPLAIN (FORMAT JSON) DELETE FROM t',
      'EXPLAIN VERBOSE DELETE FROM t'
    ]) {
      expect(violatesSafeUpdates(sql, postgres), sql).toBe(false)
    }
  })

  it('allows words that start T-SQL statements as column names where semicolons are required', () => {
    expect(violatesSafeUpdates('UPDATE events SET begin = now() WHERE id = 1', postgres)).toBe(false)
    expect(violatesSafeUpdates('UPDATE periods SET end = 1, begin = 2 WHERE id = 1', sqlite)).toBe(false)
    expect(violatesSafeUpdates('UPDATE t SET print = 1 WHERE id = 1', sqlite)).toBe(false)
  })

  it('stops checking a T-SQL batch at a definition or a privilege statement', () => {
    for (const sql of [
      "IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE name = 'fk')\nALTER TABLE dbo.o ADD CONSTRAINT fk FOREIGN KEY (c) REFERENCES dbo.c (id) ON DELETE CASCADE",
      'USE db\nGRANT SELECT, UPDATE ON dbo.t TO u'
    ]) {
      expect(violatesSafeUpdates(sql, mssql), sql).toBe(false)
    }
  })

  it('allows UPDATE and DELETE used as clauses of another statement', () => {
    expect(violatesSafeUpdates('SELECT * FROM t FOR UPDATE', postgres)).toBe(false)
    expect(violatesSafeUpdates('INSERT INTO t VALUES (1) ON CONFLICT (id) DO UPDATE SET a = 1', postgres)).toBe(false)
    expect(violatesSafeUpdates('MERGE t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET a = 1;', mssql)).toBe(false)
  })
})
