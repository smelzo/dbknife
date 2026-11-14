import { mysqlDialect, type Dialect } from './dialect'
import { mysqlRules, significantTokens, unquoteIdentifier, type LexerRules, type Token } from './lexer'

const upper = (t: Token | undefined): string => (t && t.type === 'word' ? t.text.toUpperCase() : '')

/** First keyword of a statement (upper case), e.g. SELECT, UPDATE, CREATE. */
export function statementKind(sql: string, rules: LexerRules = mysqlRules): string {
  for (const t of significantTokens(sql, rules)) {
    if (t.type === 'word') return t.text.toUpperCase()
    if (t.text !== '(') return ''
  }
  return ''
}

/** Top-level tokens (outside any parentheses) of a statement. */
export function topLevel(tokens: Token[]): Token[] {
  const out: Token[] = []
  let depth = 0
  for (const t of tokens) {
    if (t.text === '(') depth++
    else if (t.text === ')') depth = Math.max(0, depth - 1)
    else if (depth === 0) out.push(t)
  }
  return out
}

/**
 * Adds a row limit to a plain SELECT that has no top-level limit: appended
 * (`LIMIT 0, n` in MySQL), or after SELECT [ALL | DISTINCT] of the main query
 * (`TOP (n)` in T-SQL). Statements that select INTO, lock rows or are not
 * queries are returned unchanged; with TOP, so are compound queries (TOP
 * would cap their first part only) and the ones with OFFSET or FOR XML/JSON.
 */
export function applyRowLimit(sql: string, limit: number, dialect: Dialect = mysqlDialect): string {
  if (limit <= 0) return sql
  const tokens = significantTokens(sql, dialect.rules)
  if (tokens.length === 0) return sql
  const kind = statementKind(sql, dialect.rules)
  if (kind !== 'SELECT' && kind !== 'WITH') return sql
  const top = topLevel(tokens)
  const words = top.map(upper)
  if (kind === 'WITH' && !words.includes('SELECT')) return sql
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (w === 'LIMIT' || w === 'FETCH' || w === 'INTO' || w === 'PROCEDURE') return sql
    if (w === 'FOR' && (words[i + 1] === 'UPDATE' || words[i + 1] === 'SHARE')) return sql
    if (w === 'LOCK' && words[i + 1] === 'IN') return sql
  }
  if (dialect.limitPosition === 'select') {
    if (words.some((w) => /^(TOP|OFFSET|UNION|EXCEPT|INTERSECT)$/.test(w))) return sql
    if (words.some((w, i) => w === 'FOR' && /^(XML|JSON|BROWSE)$/.test(words[i + 1]))) return sql
    // a parenthesized query, (SELECT ...) ORDER BY ..., has no top-level SELECT
    let at = words.indexOf('SELECT')
    if (at < 0) return sql
    if (words[at + 1] === 'ALL' || words[at + 1] === 'DISTINCT') at++
    const after = top[at]
    return `${sql.slice(0, after.end)}${dialect.limitClause(limit)}${sql.slice(after.end)}`
  }
  const last = tokens[tokens.length - 1]
  return `${sql.slice(0, last.end)}${dialect.limitClause(limit)}${sql.slice(last.end)}`
}

export interface TableRef {
  schema?: string
  table: string
  alias?: string
}

const tableIntroducers = new Set(['FROM', 'JOIN', 'UPDATE', 'INTO', 'TABLE', 'DESCRIBE', 'DESC', 'EXPLAIN'])
const notAlias = new Set([
  'WHERE', 'ON', 'USING', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'CROSS', 'NATURAL', 'STRAIGHT_JOIN', 'GROUP',
  'ORDER', 'LIMIT', 'HAVING', 'SET', 'VALUES', 'VALUE', 'UNION', 'WINDOW', 'FOR', 'LOCK', 'PARTITION',
  'USE', 'FORCE', 'IGNORE', 'SELECT', 'AS', 'OUTER', 'INTO', 'FULL', 'EXCEPT', 'INTERSECT', 'RETURNING'
])

/** Tables referenced by a statement with their aliases (best effort, for auto-completion). */
export function referencedTables(sql: string, rules: LexerRules = mysqlRules): TableRef[] {
  const tokens = significantTokens(sql, rules)
  const refs: TableRef[] = []
  const isName = (t: Token | undefined): boolean => !!t && (t.type === 'word' || t.type === 'quoted')
  for (let i = 0; i < tokens.length; i++) {
    if (!tableIntroducers.has(upper(tokens[i]))) continue
    let j = i + 1
    // comma separated table lists: FROM a x, b y
    for (;;) {
      if (!isName(tokens[j]) || notAlias.has(upper(tokens[j]))) break
      let schema: string | undefined
      let table = unquoteIdentifier(tokens[j].text)
      j++
      if (tokens[j]?.text === '.' && isName(tokens[j + 1])) {
        schema = table
        table = unquoteIdentifier(tokens[j + 1].text)
        j += 2
      }
      let alias: string | undefined
      if (upper(tokens[j]) === 'AS') j++
      if (isName(tokens[j]) && !notAlias.has(upper(tokens[j]))) {
        alias = unquoteIdentifier(tokens[j].text)
        j++
      }
      refs.push({ schema, table, alias })
      if (tokens[j]?.text !== ',') break
      j++
    }
  }
  return refs
}
