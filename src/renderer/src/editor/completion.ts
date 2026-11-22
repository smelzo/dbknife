import { referencedTables } from '@shared/sql/analyze'
import { significantTokens, unquoteIdentifier } from '@shared/sql/lexer'
import { splitStatements, statementAt } from '@shared/sql/splitter'
import { t } from '@/i18n'
import type { Workspace } from '@/workspace/workspace'
import { monaco } from './monaco'

/** Which workspace owns a model, so completion can read that connection's catalog. */
const owners = new Map<string, Workspace>()

export function registerModelOwner(model: monaco.editor.ITextModel, ws: Workspace): void {
  owners.set(model.uri.toString(), ws)
  model.onWillDispose(() => owners.delete(model.uri.toString()))
}

const Kind = monaco.languages.CompletionItemKind

const tableIntroducers = new Set(['FROM', 'JOIN', 'UPDATE', 'INTO', 'TABLE', 'DESCRIBE', 'DESC', 'TRUNCATE'])

async function provide(
  model: monaco.editor.ITextModel,
  position: monaco.Position
): Promise<monaco.languages.CompletionList> {
  const ws = owners.get(model.uri.toString())
  if (!ws?.connected) return { suggestions: [] }
  const meta = ws.meta
  const dialect = ws.dialect
  // PostgreSQL folds unquoted names to lower case: names with capitals need quotes there; T-SQL #temp names need none
  const plain = dialect.rules.hashInNames ? /^[A-Za-z_#][\w$#]*$/ : /^[A-Za-z_][\w$]*$/
  const needsQuote = (name: string): boolean =>
    !plain.test(name) || dialect.keywords.has(name.toUpperCase()) || (dialect.engine === 'postgres' && name !== name.toLowerCase())
  const ident = (name: string): string => (needsQuote(name) ? dialect.quoteIdentifier(name) : name)
  const text = model.getValue()
  const offset = model.getOffsetAt(position)
  const st = statementAt(splitStatements(text, dialect.rules), offset)
  const stmtText = st ? text.slice(st.start, Math.max(st.end, offset)) : ''
  const before = st && st.start <= offset ? text.slice(st.start, offset) : ''
  const word = model.getWordUntilPosition(position)
  const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
  const upper = ws.settings.uppercaseKeywords
  const out: monaco.languages.CompletionItem[] = []
  const add = (label: string, kind: monaco.languages.CompletionItemKind, detail: string, rank: number, insert = label): void => {
    out.push({ label, kind, detail, insertText: insert, range, sortText: `${rank}${label.toLowerCase()}` })
  }
  const schema = ws.defaultSchema
  const refs = referencedTables(stmtText, dialect.rules)

  const addColumnsOf = async (s: string, table: string, rank: number): Promise<void> => {
    try {
      for (const c of await meta.loadColumns(s, table)) add(c.name, Kind.Field, `${table}.${c.type}`, rank, ident(c.name))
    } catch {
      // unknown table: nothing to add
    }
  }
  const addObjectsOf = async (s: string, rank: number): Promise<void> => {
    try {
      const o = await meta.loadObjects(s)
      for (const table of o.tables) add(table.name, Kind.Struct, t('editor.completion.tableIn', { schema: s }), rank, ident(table.name))
      for (const v of o.views) add(v.name, Kind.Interface, t('editor.completion.viewIn', { schema: s }), rank, ident(v.name))
      for (const r of o.routines) add(r.name, Kind.Function, t(r.type === 'PROCEDURE' ? 'editor.completion.procedureIn' : 'editor.completion.functionIn', { schema: s }), rank + 1, ident(r.name))
    } catch {
      // schema not accessible
    }
  }

  // qualifier.prefix → columns of an alias/table, or objects of a schema
  const qualified = /(`(?:[^`]|``)+`|"(?:[^"]|"")+"|\[[^\]]+\]|[\w$]+)\.([`"[]?[\w$]*)$/.exec(before)
  if (qualified) {
    const q = unquoteIdentifier(qualified[1])
    const ref = refs.find((r) => r.alias === q) ?? refs.find((r) => !r.alias && r.table === q) ?? refs.find((r) => r.table === q)
    if (ref) {
      await addColumnsOf(ref.schema ?? schema, ref.table, 0)
    } else if (meta.schemas.includes(q)) {
      await addObjectsOf(q, 0)
    } else if (schema) {
      await addColumnsOf(schema, q, 0)
    }
    return { suggestions: out }
  }

  const tokens = significantTokens(before, dialect.rules)
  const typing = tokens.length && before.length === tokens[tokens.length - 1].end ? tokens.length - 1 : tokens.length
  const prev = tokens[typing - 1]?.text.toUpperCase() ?? ''

  if (prev === 'USE') {
    for (const s of meta.schemas) add(s, Kind.Module, t('editor.completion.schema'), 0, ident(s))
    return { suggestions: out }
  }
  if (tableIntroducers.has(prev)) {
    if (schema) await addObjectsOf(schema, 0)
    for (const s of meta.schemas) add(s, Kind.Module, t('editor.completion.schema'), 2, ident(s))
    return { suggestions: out }
  }
  // T-SQL runs procedures with EXEC; MySQL and PostgreSQL with CALL
  const callWords = dialect.engine === 'mssql' ? ['EXEC', 'EXECUTE'] : ['CALL']
  if (callWords.includes(prev) && schema) {
    const o = await meta.loadObjects(schema).catch(() => undefined)
    for (const r of o?.routines ?? []) if (r.type === 'PROCEDURE') add(r.name, Kind.Function, t('editor.completion.procedure'), 0, ident(r.name))
    return { suggestions: out }
  }

  await Promise.all(refs.map((r) => addColumnsOf(r.schema ?? schema, r.table, 0)))
  for (const r of refs) if (r.alias) add(r.alias, Kind.Variable, t('editor.completion.aliasOf', { table: r.table }), 1, ident(r.alias))
  for (const k of dialect.keywords) add(upper ? k : k.toLowerCase(), Kind.Keyword, t('editor.completion.keyword'), 3)
  for (const f of dialect.functions) add(upper ? f : f.toLowerCase(), Kind.Function, t('editor.completion.function'), 4, `${upper ? f : f.toLowerCase()}()`)
  if (schema) await addObjectsOf(schema, 2)
  for (const s of meta.schemas) add(s, Kind.Module, t('editor.completion.schema'), 5, ident(s))
  return { suggestions: dedupe(out) }
}

function dedupe(items: monaco.languages.CompletionItem[]): monaco.languages.CompletionItem[] {
  const seen = new Set<string>()
  return items.filter((i) => {
    const k = `${typeof i.label === 'string' ? i.label : i.label.label}\u0000${i.kind}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

for (const language of ['mysql', 'pgsql', 'sql']) {
  monaco.languages.registerCompletionItemProvider(language, {
    triggerCharacters: ['.'],
    provideCompletionItems: (model, position) => provide(model, position)
  })
}
