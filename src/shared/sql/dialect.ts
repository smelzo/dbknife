// What engine-neutral code needs to know about an engine's SQL dialect:
// identifier and literal quoting, lexical rules, row limits, plans and the
// editor language. Engine-specific features (table editor, administration)
// keep their own SQL instead.

import type { Cell, ColumnInfo, Engine, ServerInfo } from '../types'
import {
  mssqlFunctions,
  mssqlKeywords,
  mysqlFunctions,
  mysqlKeywords,
  postgresFunctions,
  postgresKeywords,
  sqliteFunctions,
  sqliteKeywords
} from './keywords'
import { mysqlRules, postgresRules, sqliteRules, tsqlRules, type LexerRules } from './lexer'
import { quoteIdentifier as mysqlIdentifier, sqlLiteral as mysqlLiteral, quoteString as mysqlString, toHex } from './quote'

export interface Dialect {
  engine: Engine
  rules: LexerRules
  // function properties rather than methods: they do not use `this` and are passed around detached
  quoteIdentifier: (name: string) => string
  /** `schema.name`, or `name` without a schema. */
  qualified: (schema: string | undefined, name: string) => string
  quoteString: (value: string) => string
  /** Column types, as the catalog writes them, holding numbers (bit included). */
  numericType: RegExp
  /** SQL literal for a cell value; `column`, when known, is the result column the value belongs to. */
  literal(value: Cell, column?: Pick<ColumnInfo, 'type'>): string
  /** Clause capping the rows of a SELECT (automatic limit), leading space included. */
  limitClause(limit: number): string
  /** Where limitClause goes: after the statement, or after SELECT [ALL | DISTINCT] of the main query (T-SQL TOP). */
  limitPosition: 'end' | 'select'
  /** INSERT of a row where every column takes its default. */
  insertDefaults(table: string): string
  /** Statement making `schema` the default one; null when the engine has no such notion. */
  useSchema(schema: string): string | null
  /** Statement starting a transaction (T-SQL: BEGIN TRANSACTION, a BEGIN alone opens a block). */
  beginTransaction: string
  /** Statement switching autocommit of the session; null when the driver emulates it (api.db.setAutocommit). */
  autocommitStatement(on: boolean): string | null
  /**
   * Prefix turning a statement into the query of its execution plan, as
   * api.db.explain runs it; null when the driver obtains the plan otherwise
   * (SQL Server: SET SHOWPLAN_XML).
   */
  explainPrefix: string | null
  /** Monaco language id of the SQL editor. */
  editorLanguage: 'mysql' | 'pgsql' | 'sql'
  /** sql-formatter language. */
  formatterLanguage(info: ServerInfo | null): 'mysql' | 'mariadb' | 'postgresql' | 'sqlite' | 'transactsql'
  /** Schemas hidden from the navigator unless "show system schemas" is on. */
  isSystemSchema(name: string): boolean
  /** Upper-case keywords and type names: completion, keyword casing, identifiers needing quotes. */
  keywords: ReadonlySet<string>
  /** Upper-case names of the built-in functions offered by completion. */
  functions: readonly string[]
}

const doubleQuoted = (name: string): string => '"' + name.replace(/"/g, '""') + '"'
const bracketed = (name: string): string => '[' + name.replace(/]/g, ']]') + ']'
/** Standard SQL string literal: quotes doubled, no backslash escapes. */
const standardString = (value: string): string => "'" + value.replace(/'/g, "''") + "'"
const nationalString = (value: string): string => 'N' + standardString(value)

function makeLiteral(quoteString: (v: string) => string, binary: (b: Uint8Array) => string): (v: Cell) => string {
  return (value) => {
    if (value === null) return 'NULL'
    if (typeof value === 'number') return String(value)
    if (value instanceof Uint8Array) return binary(value)
    return quoteString(value)
  }
}

function qualifier(quote: (n: string) => string): Dialect['qualified'] {
  return (schema, name) => (schema ? `${quote(schema)}.${quote(name)}` : quote(name))
}

const mysqlSystem = new Set(['information_schema', 'performance_schema', 'mysql', 'sys'])

export const mysqlDialect: Dialect = {
  engine: 'mysql',
  rules: mysqlRules,
  quoteIdentifier: mysqlIdentifier,
  qualified: qualifier(mysqlIdentifier),
  quoteString: mysqlString,
  numericType: /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|bit|year)\b/i,
  literal: mysqlLiteral,
  limitClause: (n) => ` LIMIT 0, ${n}`,
  limitPosition: 'end',
  insertDefaults: (table) => `INSERT INTO ${table} () VALUES ()`,
  useSchema: (schema) => `USE ${mysqlIdentifier(schema)}`,
  beginTransaction: 'START TRANSACTION',
  autocommitStatement: (on) => `SET autocommit = ${on ? 1 : 0}`,
  explainPrefix: 'EXPLAIN ',
  editorLanguage: 'mysql',
  formatterLanguage: (info) => (info?.isMariaDB ? 'mariadb' : 'mysql'),
  isSystemSchema: (name) => mysqlSystem.has(name),
  keywords: new Set(mysqlKeywords),
  functions: mysqlFunctions
}

export const postgresDialect: Dialect = {
  engine: 'postgres',
  rules: postgresRules,
  quoteIdentifier: doubleQuoted,
  qualified: qualifier(doubleQuoted),
  quoteString: standardString,
  // format_type names; bit is a bit string here, not a number
  numericType: /^(smallint|integer|bigint|numeric|real|double precision)\b/,
  literal: makeLiteral(standardString, (b) => `'\\x${toHex(b)}'::bytea`),
  limitClause: (n) => ` LIMIT ${n}`,
  limitPosition: 'end',
  insertDefaults: (table) => `INSERT INTO ${table} DEFAULT VALUES`,
  useSchema: (schema) => `SET search_path TO ${doubleQuoted(schema)}`,
  beginTransaction: 'BEGIN',
  autocommitStatement: () => null,
  explainPrefix: 'EXPLAIN (FORMAT JSON) ',
  editorLanguage: 'pgsql',
  formatterLanguage: () => 'postgresql',
  isSystemSchema: (name) => name === 'information_schema' || /^pg_(catalog|toast)$|^pg_(toast_)?temp_\d+$/.test(name),
  keywords: new Set(postgresKeywords),
  functions: postgresFunctions
}

export const sqliteDialect: Dialect = {
  engine: 'sqlite',
  rules: sqliteRules,
  quoteIdentifier: doubleQuoted,
  // main is the connection's own file, where unqualified names resolve: generated SQL leaves it out
  qualified: (schema, name) => qualifier(doubleQuoted)(schema === 'main' ? undefined : schema, name),
  quoteString: standardString,
  // the INTEGER and REAL affinities (https://www.sqlite.org/datatype3.html, 3.1), and the columns without a
  // type or of type ANY, which keep a value as it is given: a number written as text would stay text
  numericType: /INT|REAL|FLOA|DOUB|^\s*(ANY)?\s*$/i,
  literal: makeLiteral(standardString, (b) => `X'${toHex(b)}'`),
  limitClause: (n) => ` LIMIT ${n}`,
  limitPosition: 'end',
  insertDefaults: (table) => `INSERT INTO ${table} DEFAULT VALUES`,
  useSchema: () => null,
  beginTransaction: 'BEGIN',
  autocommitStatement: () => null,
  explainPrefix: 'EXPLAIN QUERY PLAN ',
  editorLanguage: 'sql',
  formatterLanguage: () => 'sqlite',
  isSystemSchema: (name) => name === 'temp',
  keywords: new Set(sqliteKeywords),
  functions: sqliteFunctions
}

const tsqlLiteral = makeLiteral(nationalString, (b) => `0x${toHex(b)}`)
const dateTimeType = /^(datetime|smalldatetime|datetime2|datetimeoffset)\b/i
const dateTimeText = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(:\d{2}(?:\.\d+)?)?)?(?: ?([+-]\d{2}:\d{2}))?$/
/** SQL Server types holding numbers. */
export const mssqlNumericType = /^(tinyint|smallint|int|bigint|decimal|numeric|money|smallmoney|float|real|bit)\b/i
const decimalText = /^[+-]?(\d+(\.\d*)?|\.\d+)$/

/**
 * T-SQL literal. Numeric columns get a numeric literal when the text is a
 * plain decimal number (the driver returns decimal, money and bigint as exact
 * text). Date/time columns get the ISO 8601 form with `T`, which
 * datetime and smalldatetime read the same way under any DATEFORMAT (with an
 * Italian session language '2026-10-26 14:00' is read as day 10 of month 26).
 */
function mssqlLiteral(value: Cell, column?: Pick<ColumnInfo, 'type'>): string {
  if (typeof value === 'string' && column && mssqlNumericType.test(column.type) && decimalText.test(value)) return value
  const m = typeof value === 'string' && column && dateTimeType.test(column.type) ? dateTimeText.exec(value) : null
  if (!m) return tsqlLiteral(value)
  const [, date, hoursMinutes = '00:00', seconds = ':00', offset = ''] = m
  return `'${date}T${hoursMinutes}${seconds}${offset}'`
}

const mssqlSystem = new Set([
  'sys', 'information_schema', 'guest', 'db_owner', 'db_accessadmin', 'db_securityadmin', 'db_ddladmin',
  'db_backupoperator', 'db_datareader', 'db_datawriter', 'db_denydatareader', 'db_denydatawriter'
])

export const mssqlDialect: Dialect = {
  engine: 'mssql',
  rules: tsqlRules,
  quoteIdentifier: bracketed,
  qualified: qualifier(bracketed),
  quoteString: nationalString,
  numericType: mssqlNumericType,
  literal: mssqlLiteral,
  limitClause: (n) => ` TOP (${n})`,
  limitPosition: 'select',
  insertDefaults: (table) => `INSERT INTO ${table} DEFAULT VALUES`,
  // the default schema belongs to the database user (ALTER USER ... WITH DEFAULT_SCHEMA), not to the session
  useSchema: () => null,
  beginTransaction: 'BEGIN TRANSACTION',
  // the driver switches IMPLICIT_TRANSACTIONS, committing the open transaction when autocommit goes back on
  autocommitStatement: () => null,
  explainPrefix: null,
  editorLanguage: 'sql',
  formatterLanguage: () => 'transactsql',
  isSystemSchema: (name) => mssqlSystem.has(name.toLowerCase()),
  keywords: new Set(mssqlKeywords),
  functions: mssqlFunctions
}

const dialects: Record<Engine, Dialect> = { mysql: mysqlDialect, postgres: postgresDialect, sqlite: sqliteDialect, mssql: mssqlDialect }

export const dialectFor = (engine: Engine): Dialect => dialects[engine]
