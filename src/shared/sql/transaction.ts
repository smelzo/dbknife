// Autocommit-off mode of the engines whose sessions have no such switch
// (PostgreSQL, SQLite): the driver opens a transaction before a statement
// when none is open, as psql does with AUTOCOMMIT off.

import type { Engine } from '../types'
import { postgresRules, significantTokens, sqliteRules } from './lexer'

/** Statements that end or start a transaction themselves. */
const transactionControl = new Set(['BEGIN', 'START', 'COMMIT', 'END', 'ROLLBACK', 'ABORT'])

/** Leading words of PostgreSQL statements that cannot run inside a transaction block. */
const postgresOutside = [
  /^VACUUM\b/,
  /^(CREATE|DROP) (DATABASE|TABLESPACE)\b/,
  /^(CREATE|DROP) (UNIQUE )?INDEX CONCURRENTLY\b/,
  /^REINDEX (SYSTEM|DATABASE)\b/,
  /^REINDEX (\(.*\) )?\w+ CONCURRENTLY\b/,
  /^ALTER SYSTEM\b/,
  /^CLUSTER$/,
  /^DISCARD ALL\b/,
  /^(PREPARE TRANSACTION|COMMIT PREPARED|ROLLBACK PREPARED)\b/,
  /^CHECKPOINT\b/
]

/**
 * A script of several statements as one transaction: the review dialog rolls it back when one fails.
 * `begin` starts it (T-SQL: BEGIN TRANSACTION, a BEGIN alone opens a block).
 */
export const inTransaction = (statements: string[], begin = 'BEGIN'): string[] => (statements.length > 1 ? [begin, ...statements, 'COMMIT'] : statements)

/**
 * Whether, with autocommit off, a transaction has to be opened before `sql`.
 * SQLite: PRAGMA, ATTACH and DETACH are left alone too (several pragmas and
 * ATTACH do not work inside a transaction).
 */
export function opensTransaction(sql: string, engine: Extract<Engine, 'postgres' | 'sqlite'>): boolean {
  const tokens = significantTokens(sql, engine === 'postgres' ? postgresRules : sqliteRules)
  const words = tokens
    .slice(0, 6)
    .map((t) => t.text.toUpperCase())
    .join(' ')
  const first = words.split(' ')[0]
  if (!first || transactionControl.has(first)) return false
  if (engine === 'sqlite') return !/^(VACUUM|PRAGMA|ATTACH|DETACH)$/.test(first)
  return !postgresOutside.some((re) => re.test(words))
}
