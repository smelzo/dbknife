// Minimal SQL lexer: enough to split scripts, find statement boundaries
// and inspect top-level keywords. It does not validate syntax. The lexical
// rules of each engine (quoting, comments, escapes) come from LexerRules.

export type TokenType =
  | 'word'
  | 'quoted' // quoted identifier: `a`, "a" (standard SQL), [a] (SQLite, T-SQL)
  | 'string' // '...', "..." (MySQL), E'...', $tag$...$tag$ (PostgreSQL), N'...' (T-SQL)
  | 'number'
  | 'comment'
  | 'space'
  | 'symbol'

export interface Token {
  type: TokenType
  text: string
  start: number
  end: number
}

export interface LexerRules {
  backtickIdentifiers: boolean
  /** "..." quotes an identifier (standard SQL) rather than a string (MySQL). */
  doubleQuotedIdentifiers: boolean
  /** [name] quotes an identifier (SQLite, T-SQL). */
  bracketIdentifiers: boolean
  /** `]]` inside [name] stands for `]` (T-SQL). */
  bracketEscapes: boolean
  /** `#` starts a line comment (MySQL). */
  hashComments: boolean
  /** `--` starts a comment only when followed by whitespace (MySQL). */
  dashCommentNeedsSpace: boolean
  /** Backslash escapes in every string literal (MySQL). */
  backslashEscapes: boolean
  /** E'...' strings with backslash escapes and $tag$...$tag$ strings (PostgreSQL). */
  postgresStrings: boolean
  /** N'...' Unicode strings (T-SQL). */
  nationalStrings: boolean
  /** `#` is part of names: temporary tables #t and ##t (T-SQL). */
  hashInNames: boolean
  /** Block comments nest (PostgreSQL, T-SQL). */
  nestedComments: boolean
  /** Client-side DELIMITER command and executable comments (mysql client). */
  clientDelimiter: boolean
  /** `;` inside CREATE TRIGGER ... BEGIN ... END does not end the statement (SQLite). */
  triggerBodies: boolean
  /** Client-side GO alone on a line ends a batch (sqlcmd, SSMS). */
  batchSeparator: boolean
  /**
   * `;` does not end a statement inside BEGIN ... END blocks, before ELSE,
   * or in the body of CREATE/ALTER PROCEDURE, FUNCTION, TRIGGER and VIEW,
   * which runs up to GO (T-SQL).
   */
  tsqlBlocks: boolean
}

export const mysqlRules: LexerRules = {
  backtickIdentifiers: true,
  doubleQuotedIdentifiers: false,
  bracketIdentifiers: false,
  bracketEscapes: false,
  hashComments: true,
  dashCommentNeedsSpace: true,
  backslashEscapes: true,
  postgresStrings: false,
  nationalStrings: false,
  hashInNames: false,
  nestedComments: false,
  clientDelimiter: true,
  triggerBodies: false,
  batchSeparator: false,
  tsqlBlocks: false
}

export const postgresRules: LexerRules = {
  backtickIdentifiers: false,
  doubleQuotedIdentifiers: true,
  bracketIdentifiers: false,
  bracketEscapes: false,
  hashComments: false,
  dashCommentNeedsSpace: false,
  backslashEscapes: false,
  postgresStrings: true,
  nationalStrings: false,
  hashInNames: false,
  nestedComments: true,
  clientDelimiter: false,
  triggerBodies: false,
  batchSeparator: false,
  tsqlBlocks: false
}

export const sqliteRules: LexerRules = {
  backtickIdentifiers: true,
  doubleQuotedIdentifiers: true,
  bracketIdentifiers: true,
  bracketEscapes: false,
  hashComments: false,
  dashCommentNeedsSpace: false,
  backslashEscapes: false,
  postgresStrings: false,
  nationalStrings: false,
  hashInNames: false,
  nestedComments: false,
  clientDelimiter: false,
  triggerBodies: true,
  batchSeparator: false,
  tsqlBlocks: false
}

export const tsqlRules: LexerRules = {
  backtickIdentifiers: false,
  doubleQuotedIdentifiers: true,
  bracketIdentifiers: true,
  bracketEscapes: true,
  hashComments: false,
  dashCommentNeedsSpace: false,
  backslashEscapes: false,
  postgresStrings: false,
  nationalStrings: true,
  hashInNames: true,
  nestedComments: true,
  clientDelimiter: false,
  triggerBodies: false,
  batchSeparator: true,
  tsqlBlocks: true
}

const isSpace = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f'
const isWordChar = (c: string, rules: LexerRules): boolean => /[\p{L}\p{N}_$@]/u.test(c) || (c === '#' && rules.hashInNames)
const isDigit = (c: string): boolean => c >= '0' && c <= '9'

/** Index just past a quoted run starting at `pos` (which holds the opening quote); a doubled `close` stands for itself when `doubled`. */
function scanQuoted(src: string, pos: number, close: string, backslash: boolean, doubled = true): number {
  let i = pos + 1
  while (i < src.length) {
    const c = src[i]
    if (c === '\\' && backslash) {
      i += 2
      continue
    }
    if (c === close) {
      if (src[i + 1] === close && doubled) {
        i += 2
        continue
      }
      return i + 1
    }
    i++
  }
  return src.length
}

function scanBlockComment(src: string, pos: number, nested: boolean): number {
  let depth = 0
  let i = pos
  while (i < src.length) {
    if (src.startsWith('/*', i) && (nested || depth === 0)) {
      depth++
      i += 2
    } else if (src.startsWith('*/', i)) {
      depth--
      i += 2
      if (depth === 0) return i
    } else i++
  }
  return src.length
}

const dollarTag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/

/**
 * Scans one token at `pos`. Returns its type and end offset.
 */
export function scanToken(src: string, pos: number, rules: LexerRules = mysqlRules): { type: TokenType; end: number } {
  const c = src[pos]
  const next = src[pos + 1]
  if (isSpace(c)) {
    let i = pos + 1
    while (i < src.length && isSpace(src[i])) i++
    return { type: 'space', end: i }
  }
  if (
    (c === '#' && rules.hashComments) ||
    (c === '-' && next === '-' && (!rules.dashCommentNeedsSpace || pos + 2 >= src.length || isSpace(src[pos + 2])))
  ) {
    let i = pos
    while (i < src.length && src[i] !== '\n') i++
    return { type: 'comment', end: i }
  }
  if (c === '/' && next === '*') return { type: 'comment', end: scanBlockComment(src, pos, rules.nestedComments) }
  if (c === "'") return { type: 'string', end: scanQuoted(src, pos, "'", rules.backslashEscapes) }
  if (c === '"') {
    return rules.doubleQuotedIdentifiers
      ? { type: 'quoted', end: scanQuoted(src, pos, '"', false) }
      : { type: 'string', end: scanQuoted(src, pos, '"', rules.backslashEscapes) }
  }
  if (c === '`' && rules.backtickIdentifiers) return { type: 'quoted', end: scanQuoted(src, pos, '`', false) }
  if (c === '[' && rules.bracketIdentifiers) return { type: 'quoted', end: scanQuoted(src, pos, ']', false, rules.bracketEscapes) }
  if ((c === 'N' || c === 'n') && next === "'" && rules.nationalStrings) {
    return { type: 'string', end: scanQuoted(src, pos + 1, "'", rules.backslashEscapes) }
  }
  if (rules.postgresStrings) {
    if ((c === 'E' || c === 'e') && next === "'") return { type: 'string', end: scanQuoted(src, pos + 1, "'", true) }
    if (c === '$') {
      const tag = dollarTag.exec(src.slice(pos, pos + 64))?.[0]
      if (tag) {
        const close = src.indexOf(tag, pos + tag.length)
        return { type: 'string', end: close < 0 ? src.length : close + tag.length }
      }
    }
  }
  if (isDigit(c) || (c === '.' && next !== undefined && isDigit(next))) {
    let i = pos + 1
    while (i < src.length && /[0-9a-zA-Z_.]/.test(src[i])) i++
    return { type: 'number', end: i }
  }
  if (isWordChar(c, rules)) {
    let i = pos + 1
    while (i < src.length && isWordChar(src[i], rules)) i++
    return { type: 'word', end: i }
  }
  return { type: 'symbol', end: pos + 1 }
}

export function tokenize(src: string, rules: LexerRules = mysqlRules): Token[] {
  const tokens: Token[] = []
  let pos = 0
  while (pos < src.length) {
    const { type, end } = scanToken(src, pos, rules)
    tokens.push({ type, text: src.slice(pos, end), start: pos, end })
    pos = end
  }
  return tokens
}

/** Tokens without whitespace and comments. */
export function significantTokens(src: string, rules: LexerRules = mysqlRules): Token[] {
  return tokenize(src, rules).filter((t) => t.type !== 'space' && t.type !== 'comment')
}

const closing: Record<string, string> = { '`': '`', '"': '"', '[': ']' }

/** Removes the quoting of an identifier token (`a``b` → a`b, "a""b" → a"b, [a]]b] → a]b). */
export function unquoteIdentifier(text: string): string {
  const close = closing[text[0]]
  if (text.length >= 2 && close && text[text.length - 1] === close) {
    // a SQLite [name] cannot hold `]]`: the lexer ends it at the first `]`
    return text.slice(1, -1).split(close + close).join(close)
  }
  return text
}
