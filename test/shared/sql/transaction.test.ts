import { describe, expect, it } from 'vitest'
import { opensTransaction } from '@shared/sql/transaction'

describe('opensTransaction', () => {
  it('opens a transaction before ordinary statements, after leading comments', () => {
    expect(opensTransaction('/* c */ -- x\nUPDATE t SET a = 1', 'postgres')).toBe(true)
    expect(opensTransaction('SELECT 1', 'sqlite')).toBe(true)
  })

  it('leaves transaction control statements alone', () => {
    for (const sql of ['BEGIN', 'start transaction', 'COMMIT', 'END', 'ROLLBACK', 'ABORT']) expect(opensTransaction(sql, 'postgres')).toBe(false)
    expect(opensTransaction('BEGIN IMMEDIATE', 'sqlite')).toBe(false)
  })

  it('leaves PostgreSQL statements that cannot run in a transaction block alone', () => {
    for (const sql of [
      'VACUUM FULL t',
      'CREATE DATABASE x',
      'DROP TABLESPACE x',
      'CREATE UNIQUE INDEX CONCURRENTLY i ON t (a)',
      'REINDEX DATABASE x',
      'REINDEX (VERBOSE) TABLE CONCURRENTLY t',
      'ALTER SYSTEM SET work_mem = 1',
      'CLUSTER'
    ]) {
      expect(opensTransaction(sql, 'postgres'), sql).toBe(false)
    }
    for (const sql of ['CREATE INDEX i ON t (a)', 'REINDEX TABLE t', 'CLUSTER t USING i', 'ALTER TABLE t ADD c int']) {
      expect(opensTransaction(sql, 'postgres'), sql).toBe(true)
    }
  })

  it('leaves SQLite pragmas, VACUUM, ATTACH and DETACH alone', () => {
    for (const sql of ['PRAGMA foreign_keys = OFF', 'VACUUM', "ATTACH 'x.db' AS x", 'DETACH x']) expect(opensTransaction(sql, 'sqlite')).toBe(false)
  })
})
