import { mysqlRules, scanToken, type LexerRules } from './lexer'

export interface Statement {
  text: string
  /** Offset of the first significant character. */
  start: number
  /** Offset just past the statement body (delimiter excluded). */
  end: number
  /** Offset just past the delimiter (equals `end` when the statement is unterminated). */
  delimiterEnd: number
  delimiter: string
  /** T-SQL: the count of a `GO n` ending the statement. sqlcmd runs the batch n times, the editor once. */
  goCount?: number
}

const delimiterCommand = /^[ \t]*delimiter[ \t]+(\S+)[^\n]*/i
/** sqlcmd's batch separator: GO alone on a line, with an optional count and comment. */
const batchSeparator = /^[ \t]*go(?:[ \t]+(\d+))?[ \t]*(?:--.*)?\r?$/i

/** T-SQL statements that must be alone in their batch: their body runs up to GO. */
const tsqlModules = new Set(['PROC', 'PROCEDURE', 'FUNCTION', 'TRIGGER', 'VIEW'])
/** BEGIN followed by these words is a statement, not the start of a block. */
const beginStatements = new Set(['TRAN', 'TRANSACTION', 'DISTRIBUTED', 'DIALOG', 'CONVERSATION'])

const isTsqlModule = (w: string[]): boolean =>
  (w[0] === 'CREATE' && (tsqlModules.has(w[1]) || (w[1] === 'OR' && w[2] === 'ALTER' && tsqlModules.has(w[3])))) ||
  (w[0] === 'ALTER' && tsqlModules.has(w[1]))

/** Upper-case text of the first significant token from `pos` when it is a word, otherwise ''. */
function nextWord(src: string, pos: number, rules: LexerRules): string {
  while (pos < src.length) {
    const { type, end } = scanToken(src, pos, rules)
    if (type !== 'space' && type !== 'comment') return type === 'word' ? src.slice(pos, end).toUpperCase() : ''
    pos = end
  }
  return ''
}

/** Executable comments (`/*! ... *\/`, `/*M! ... *\/`) are code for the server. */
export const isExecutableComment = (text: string): boolean => text.startsWith('/*!') || text.startsWith('/*M!')

/**
 * Splits a script into statements honouring quotes and comments. With the
 * MySQL rules it also honours the client-side DELIMITER command (as the mysql
 * command line client does: the command is recognised at the beginning of a
 * line, outside a statement); with the SQLite rules a `;` inside the
 * BEGIN ... END body of CREATE TRIGGER does not end the statement. With the
 * T-SQL rules GO alone on a line always ends the statement, and a `;` ends
 * it only outside BEGIN ... END blocks and module bodies (see tsqlBlocks).
 */
export function splitStatements(src: string, rules: LexerRules = mysqlRules): Statement[] {
  const statements: Statement[] = []
  let delimiter = ';'
  let start = -1
  let bodyEnd = -1
  let pos = 0
  let atLineStart = true
  // first words of the current statement and BEGIN/CASE ... END nesting of a trigger body or T-SQL block
  let words: string[] = []
  let blockDepth = 0

  const finish = (delimiterEnd: number, ending = delimiter, goCount?: number): void => {
    if (start >= 0) {
      const statement: Statement = { text: src.slice(start, bodyEnd), start, end: bodyEnd, delimiterEnd, delimiter: ending }
      if (goCount !== undefined) statement.goCount = goCount
      statements.push(statement)
    }
    start = -1
    bodyEnd = -1
    words = []
    blockDepth = 0
  }

  while (pos < src.length) {
    if (rules.clientDelimiter && start < 0 && atLineStart) {
      const lineEnd = src.indexOf('\n', pos)
      const m = delimiterCommand.exec(src.slice(pos, lineEnd < 0 ? src.length : lineEnd))
      if (m) {
        delimiter = m[1]
        pos += m[0].length
        continue
      }
    }
    if (rules.batchSeparator && atLineStart) {
      const lineEnd = src.indexOf('\n', pos)
      const m = batchSeparator.exec(src.slice(pos, lineEnd < 0 ? src.length : lineEnd))
      if (m) {
        finish(pos + m[0].length, 'GO', m[1] === undefined ? undefined : Number(m[1]))
        pos += m[0].length
        atLineStart = false
        continue
      }
    }
    if (
      src.startsWith(delimiter, pos) &&
      blockDepth === 0 &&
      // T-SQL: a module body runs up to GO, and IF ... ; ELSE ... is one statement
      !(rules.tsqlBlocks && (isTsqlModule(words) || nextWord(src, pos + delimiter.length, rules) === 'ELSE'))
    ) {
      finish(pos + delimiter.length)
      pos += delimiter.length
      atLineStart = false
      continue
    }
    const scanned = scanToken(src, pos, rules)
    const type = scanned.type
    let end = scanned.end
    if (type === 'word' || type === 'number') {
      // a delimiter such as $$ can be glued to a word (END$$)
      const cut = src.slice(pos, end).indexOf(delimiter, 1)
      if (cut > 0) end = pos + cut
    }
    const text = src.slice(pos, end)
    if (type === 'space') {
      if (text.includes('\n')) atLineStart = true
    } else {
      atLineStart = false
      if (type !== 'comment' || (rules.clientDelimiter && isExecutableComment(text))) {
        if (start < 0) start = pos
        bodyEnd = end
      }
      if ((rules.triggerBodies || rules.tsqlBlocks) && type === 'word') {
        const w = text.toUpperCase()
        if (words.length < 4) words.push(w)
        if (rules.tsqlBlocks) {
          if ((w === 'BEGIN' && !beginStatements.has(nextWord(src, end, rules))) || w === 'CASE') blockDepth++
          else if (w === 'END' && blockDepth > 0 && nextWord(src, end, rules) !== 'CONVERSATION') blockDepth--
        } else if (words[0] === 'CREATE' && words.includes('TRIGGER')) {
          if (w === 'BEGIN' || (w === 'CASE' && blockDepth > 0)) blockDepth++
          else if (w === 'END' && blockDepth > 0) blockDepth--
        }
      }
    }
    pos = end
  }
  finish(src.length)
  return statements
}

/**
 * The statement the caret belongs to: the one containing the offset, otherwise
 * the closest preceding one, otherwise the first following one.
 */
export function statementAt(statements: Statement[], offset: number): Statement | undefined {
  let previous: Statement | undefined
  for (const s of statements) {
    if (offset >= s.start && offset <= s.delimiterEnd) return s
    if (s.delimiterEnd <= offset) previous = s
    else return previous ?? s
  }
  return previous
}
