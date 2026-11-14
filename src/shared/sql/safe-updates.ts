import { topLevel } from './analyze'
import { significantTokens, type LexerRules, type Token } from './lexer'

const mainVerbs = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE'])

/** T-SQL statements that end the check: definitions (routine and trigger bodies, ON DELETE) and privileges. */
const uncheckedStatements = new Set(['CREATE', 'ALTER', 'GRANT', 'REVOKE', 'DENY'])

/**
 * Words before an UPDATE or DELETE that is a clause, not a statement (THEN DELETE...).
 * ON is not one: ON DELETE/UPDATE only occurs after CREATE or ALTER, while SET NOCOUNT ON can precede a DELETE.
 */
const clausePredecessors = new Set(['FOR', 'OF', 'DO', 'THEN', 'AFTER', 'BEFORE', 'INSTEAD', 'OR', 'KEY'])

/** Words that start another statement and end the current UPDATE or DELETE. SET is not one: it belongs to UPDATE. */
const statementStarts = new Set([
  'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'COMMIT', 'ROLLBACK', 'DECLARE', 'EXEC', 'EXECUTE',
  'PRINT', 'IF', 'WHILE', 'BEGIN', 'END', 'RETURN', 'TRUNCATE', 'USE'
])

const analyzeOptions = new Set(['ANALYZE', 'ANALYSE'])
const falseValues = new Set(['FALSE', 'OFF', '0'])

/**
 * Top-level words of the statement that a PostgreSQL EXPLAIN runs: EXPLAIN ANALYZE [VERBOSE] <statement> or
 * EXPLAIN (ANALYZE ...) <statement>. undefined for an EXPLAIN without ANALYZE, which only plans the statement.
 */
function analyzedStatement(tokens: Token[], words: string[]): string[] | undefined {
  if (tokens[1]?.text === '(') {
    let depth = 0
    let analyze = false
    for (let i = 1; i < tokens.length; i++) {
      const text = tokens[i].text.toUpperCase()
      if (text === '(') depth++
      else if (text === ')' && --depth === 0) break
      else if (depth === 1 && analyzeOptions.has(text)) analyze = !falseValues.has(tokens[i + 1]?.text.toUpperCase() ?? '')
    }
    // the options are in parentheses, left out of the top-level words
    return analyze ? words.slice(1) : undefined
  }
  if (!analyzeOptions.has(words[1])) return undefined
  return words.slice(words[2] === 'VERBOSE' ? 3 : 2)
}

/**
 * Safe Updates checked by the client (engines without a server setting like
 * MySQL's sql_safe_updates): an UPDATE or DELETE without a top-level WHERE.
 * A WHERE inside a subquery or a string does not count.
 *
 * With semicolons required (PostgreSQL, SQLite) the text is one statement:
 * its verb is the first word, or the first main verb after WITH (CTE bodies
 * are in parentheses and not checked). After EXPLAIN ANALYZE, which runs the
 * statement, the checked statement is the one explained; a plain EXPLAIN
 * runs nothing and passes.
 *
 * In T-SQL the semicolon is optional and the text may hold a whole batch:
 * every top-level UPDATE or DELETE that is a statement (not MERGE ... THEN
 * DELETE...) must have a WHERE before the next word that starts a statement
 * (not the END of a CASE, nor an IF function call). UPDATE STATISTICS is not
 * a change. CREATE, ALTER, GRANT, REVOKE or DENY end the check: the rest of
 * the text (routine and trigger bodies, ON DELETE, privileges) is not checked.
 */
export function violatesSafeUpdates(sql: string, rules: LexerRules): boolean {
  const tokens = significantTokens(sql, rules)
  const top = topLevel(tokens).filter((t) => t.type === 'word')
  const words = top.map((t) => t.text.toUpperCase())
  if (!rules.tsqlBlocks) {
    const statement = words[0] === 'EXPLAIN' ? analyzedStatement(tokens, words) : words
    if (!statement) return false
    const verb = statement[0] === 'WITH' ? statement.find((w) => mainVerbs.has(w)) : statement[0]
    return (verb === 'UPDATE' || verb === 'DELETE') && !statement.includes('WHERE')
  }
  const calls = new Set(tokens.filter((t, i) => tokens[i + 1]?.text === '('))
  let openCases = 0
  let inChange = false
  let hasWhere = false
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    const change = (w === 'UPDATE' || w === 'DELETE') && !clausePredecessors.has(words[i - 1])
    if (w === 'CASE') openCases++
    else if (w === 'END' && openCases > 0) openCases--
    else if (uncheckedStatements.has(w) || (i === 0 && w === 'EXPLAIN')) break
    else if (change || (statementStarts.has(w) && w !== 'UPDATE' && w !== 'DELETE' && !(w === 'IF' && calls.has(top[i])))) {
      if (inChange && !hasWhere) return true
      inChange = change && !(w === 'UPDATE' && words[i + 1] === 'STATISTICS')
      hasWhere = false
    } else if (w === 'WHERE') hasWhere = true
  }
  return inChange && !hasWhere
}
