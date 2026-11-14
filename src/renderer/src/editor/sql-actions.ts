import { format } from 'sql-formatter'
import type { ServerInfo } from '@shared/types'
import type { Dialect } from '@shared/sql/dialect'
import { tokenize } from '@shared/sql/lexer'
import { splitStatements } from '@shared/sql/splitter'
import { monaco } from './monaco'

/** Text the action applies to: the selection, or the whole model. */
function target(editor: monaco.editor.IStandaloneCodeEditor): { range: monaco.IRange; text: string } {
  const model = editor.getModel()!
  const sel = editor.getSelection()
  const range = sel && !sel.isEmpty() ? sel : model.getFullModelRange()
  return { range, text: model.getValueInRange(range) }
}

function replace(editor: monaco.editor.IStandaloneCodeEditor, range: monaco.IRange, text: string): void {
  editor.pushUndoStop()
  editor.executeEdits('sql-action', [{ range, text }])
  editor.pushUndoStop()
}

/**
 * Beautify statement by statement, so DELIMITER blocks and statements the
 * formatter cannot parse are kept as written.
 */
export function beautify(editor: monaco.editor.IStandaloneCodeEditor, dialect: Dialect, info: ServerInfo | null): void {
  const { range, text } = target(editor)
  const statements = splitStatements(text, dialect.rules)
  if (!statements.length) return
  let out = ''
  let pos = 0
  for (const st of statements) {
    out += text.slice(pos, st.start)
    let formatted = st.text
    if (st.delimiter === ';') {
      try {
        formatted = format(st.text, { language: dialect.formatterLanguage(info), keywordCase: 'upper', tabWidth: 4 })
      } catch {
        // leave unparsable statements untouched
      }
    }
    out += formatted
    pos = st.end
  }
  out += text.slice(pos)
  replace(editor, range, out)
}

export function changeKeywordCase(editor: monaco.editor.IStandaloneCodeEditor, dialect: Dialect, upper: boolean): void {
  const { range, text } = target(editor)
  const out = tokenize(text, dialect.rules)
    .map((t) => (t.type === 'word' && dialect.keywords.has(t.text.toUpperCase()) ? (upper ? t.text.toUpperCase() : t.text.toLowerCase()) : t.text))
    .join('')
  replace(editor, range, out)
}
