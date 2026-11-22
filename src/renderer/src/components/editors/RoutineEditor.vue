<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { MessageKey } from '@shared/i18n'
import { splitStatements } from '@shared/sql/splitter'
import { significantTokens, unquoteIdentifier } from '@shared/sql/lexer'
import { inTransaction } from '@shared/sql/transaction'
import { t } from '@/i18n'
import { reviewAndApply } from '@/workspace/review'
import { routineTitles, type EditorTab, type RoutineKind, type Workspace } from '@/workspace/workspace'
import MonacoEditor from '../editor/MonacoEditor.vue'

type RoutineTab = Extract<EditorTab, { kind: 'routine' }>

/** Editor for views, stored procedures, functions and triggers: the object's DDL as text. */
const props = defineProps<{ ws: Workspace; tab: RoutineTab }>()

const text = ref('')
const loaded = ref('')
const error = ref('')
/** Line ends as LF: Monaco makes mixed CRLF/LF uniform, which is no change by the user. */
const eol = (s: string): string => s.replace(/\r\n?/g, '\n')
watch(
  () => eol(text.value) !== eol(loaded.value),
  (dirty) => (props.tab.dirty = dirty),
  { immediate: true }
)
const kind = computed(() => props.tab.objectType)
const dialect = computed(() => props.ws.dialect)
// only the mysql client needs another delimiter around bodies containing `;`
const wrap = computed(() => kind.value !== 'VIEW' && dialect.value.rules.clientDelimiter)

const headers: Record<RoutineKind, { existing: MessageKey; created: MessageKey }> = {
  VIEW: { existing: 'routineEditor.header.view', created: 'routineEditor.header.newView' },
  PROCEDURE: { existing: 'routineEditor.header.procedure', created: 'routineEditor.header.newProcedure' },
  FUNCTION: { existing: 'routineEditor.header.function', created: 'routineEditor.header.newFunction' },
  TRIGGER: { existing: 'routineEditor.header.trigger', created: 'routineEditor.header.newTrigger' }
}
const header = computed(() =>
  props.tab.name
    ? t(headers[kind.value].existing, { schema: props.tab.schema, name: props.tab.name })
    : t(headers[kind.value].created, { schema: props.tab.schema })
)

function templateFor(): string {
  const q = dialect.value.quoteIdentifier
  const table = props.tab.table ?? 'table'
  const engine = dialect.value.engine
  if (engine === 'mssql') {
    // no default schema for the session: names are qualified
    const name = (n: string): string => dialect.value.qualified(props.tab.schema, n)
    switch (kind.value) {
      case 'VIEW':
        return `CREATE OR ALTER VIEW ${name('new_view')}\nAS\nSELECT 1 AS ${q('value')}`
      case 'PROCEDURE':
        return `CREATE OR ALTER PROCEDURE ${name('new_procedure')}\nAS\nBEGIN\n    SET NOCOUNT ON;\n\nEND`
      case 'FUNCTION':
        return `CREATE OR ALTER FUNCTION ${name('new_function')} ()\nRETURNS int\nAS\nBEGIN\n    RETURN 1;\nEND`
      case 'TRIGGER':
        return `CREATE OR ALTER TRIGGER ${name(`${table}_after_insert`)} ON ${name(table)}\nAFTER INSERT\nAS\nBEGIN\n    SET NOCOUNT ON;\n\nEND`
    }
  }
  if (kind.value === 'VIEW') return `CREATE VIEW ${q('new_view')} AS\nSELECT 1`
  if (engine === 'postgres') {
    switch (kind.value) {
      case 'PROCEDURE':
        return `CREATE PROCEDURE ${q('new_procedure')}()\nLANGUAGE plpgsql\nAS $$\nBEGIN\n\nEND\n$$`
      case 'FUNCTION':
        return `CREATE FUNCTION ${q('new_function')}()\nRETURNS integer\nLANGUAGE plpgsql\nAS $$\nBEGIN\n    RETURN 1;\nEND\n$$`
      case 'TRIGGER':
        return `CREATE TRIGGER ${q(`${table}_before_insert`)} BEFORE INSERT ON ${q(table)} FOR EACH ROW\nEXECUTE FUNCTION trigger_function()`
    }
  }
  if (engine === 'sqlite') return `CREATE TRIGGER ${q(`${table}_before_insert`)} BEFORE INSERT ON ${q(table)}\nBEGIN\n    SELECT 1;\nEND`
  switch (kind.value) {
    case 'PROCEDURE':
      return 'CREATE PROCEDURE `new_procedure` ()\nBEGIN\n\nEND'
    case 'FUNCTION':
      return 'CREATE FUNCTION `new_function` ()\nRETURNS INTEGER\nDETERMINISTIC\nBEGIN\n    RETURN 1;\nEND'
    default:
      return `CREATE TRIGGER \`${table}_BEFORE_INSERT\` BEFORE INSERT ON \`${table}\` FOR EACH ROW\nBEGIN\n\nEND`
  }
}

/** T-SQL: the module's CREATE as CREATE OR ALTER, which keeps the object (and its permissions) when applied. */
function createOrAlter(ddl: string): string {
  const [first, second] = significantTokens(ddl, dialect.value.rules)
  if (first?.text.toUpperCase() !== 'CREATE' || second?.text.toUpperCase() === 'OR') return ddl
  return `${ddl.slice(0, first.end)} OR ALTER${ddl.slice(first.end)}`
}

async function load(): Promise<void> {
  error.value = ''
  let ddl = templateFor()
  if (props.tab.name) {
    try {
      ddl = await props.ws.meta.ddl(kind.value, props.tab.schema, props.tab.name)
      if (dialect.value.engine === 'mssql') ddl = createOrAlter(ddl)
    } catch (e) {
      error.value = (e as Error).message
    }
  }
  text.value = wrap.value ? `DELIMITER $$\n${ddl}$$\nDELIMITER ;\n` : ddl
  loaded.value = text.value
}

onMounted(load)

const name = '(?:`(?:[^`]|``)+`|"(?:[^"]|"")+"|\\[[^\\]]+\\]|[\\w$]+)'
const createPattern = new RegExp(
  "^CREATE\\s+(?:OR\\s+(?:REPLACE|ALTER)\\s+)?(?:TEMP(?:ORARY)?\\s+)?(?:ALGORITHM\\s*=\\s*\\w+\\s+)?(?:DEFINER\\s*=\\s*(?:`[^`]*`|'[^']*'|\\S+?)(?:@(?:`[^`]*`|'[^']*'|\\S+))?\\s+)?" +
    `(?:SQL\\s+SECURITY\\s+\\w+\\s+)?(?:AGGREGATE\\s+)?(?:CONSTRAINT\\s+)?(?:MATERIALIZED\\s+)?(VIEW|PROC(?:EDURE)?|FUNCTION|TRIGGER|EVENT)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${name}(?:\\s*\\.\\s*${name})?)`,
  'i'
)

/** The statement from its first word: a T-SQL module read from the catalog keeps the comments written before CREATE. */
const fromFirstWord = (sql: string): string => sql.slice(significantTokens(sql, dialect.value.rules)[0]?.start ?? 0)

function objectName(sql: string): string | undefined {
  const m = createPattern.exec(fromFirstWord(sql).trim())
  if (!m) return undefined
  const parts = m[2].split(/\s*\.\s*(?=[`"[\w$])/)
  return unquoteIdentifier(parts[parts.length - 1])
}

/** DROP of a routine; a PostgreSQL trigger is named together with its table. */
function dropStatement(target: string, materialized: boolean): string {
  const d = dialect.value
  if (kind.value === 'TRIGGER' && d.engine === 'postgres') {
    return `DROP TRIGGER IF EXISTS ${d.quoteIdentifier(target)} ON ${d.qualified(props.tab.schema, props.tab.table!)}`
  }
  return `DROP ${materialized ? 'MATERIALIZED VIEW' : kind.value} IF EXISTS ${d.qualified(props.tab.schema, target)}`
}

async function apply(): Promise<void> {
  error.value = ''
  const d = dialect.value
  const statements = splitStatements(text.value, d.rules).map((s) => s.text)
  const newName = statements.map(objectName).find(Boolean)
  if (!newName) {
    error.value = t('routineEditor.noCreateStatement', { kind: kind.value })
    return
  }
  const use = d.useSchema(props.tab.schema)
  const script: string[] = use ? [use] : []
  // SQLite views and PostgreSQL materialized views cannot be replaced: they are dropped and created like routines;
  // T-SQL replaces views and routines alike with CREATE OR ALTER
  const materialized = statements.some((st) => /^CREATE\s+MATERIALIZED\s/i.test(st))
  const replaceView = kind.value === 'VIEW' && d.engine !== 'sqlite' && d.engine !== 'mssql' && !materialized
  for (const st of statements) {
    if (replaceView && props.tab.name && /^CREATE\s+(?!OR\s+REPLACE)/i.test(st)) {
      script.push(st.replace(/^CREATE\s+/i, 'CREATE OR REPLACE '))
      continue
    }
    if (!replaceView && objectName(st)) {
      // CREATE OR REPLACE (T-SQL: OR ALTER) keeps the object, and what depends on it (e.g. a trigger on its function)
      const replaces = /^CREATE\s+OR\s+(REPLACE|ALTER)\s/i.test(fromFirstWord(st))
      if (props.tab.name && !(replaces && newName === props.tab.name)) script.push(dropStatement(props.tab.name, materialized))
      if (newName !== props.tab.name && !replaces) script.push(dropStatement(newName, materialized))
    }
    script.push(st)
  }
  const previous = props.ws.defaultSchema
  const restore = previous && previous !== props.tab.schema ? d.useSchema(previous) : null
  if (restore) script.push(restore)
  // T-SQL: the DROP of a renamed module and the new one's CREATE are undone together
  if (await reviewAndApply(props.ws, d.engine === 'mssql' ? inTransaction(script, 'BEGIN TRANSACTION') : script)) {
    props.tab.name = newName
    props.tab.title = t(routineTitles[kind.value], { name: newName })
    props.ws.meta.invalidate(props.tab.schema)
    void props.ws.meta.loadObjects(props.tab.schema)
    await load()
  }
}
</script>

<template>
  <div class="page">
    <div class="page-header">
      <span>{{ header }}</span>
      <span class="spacer" />
    </div>
    <div class="editor"><MonacoEditor v-model="text" :language="ws.dialect.editorLanguage" /></div>
    <p v-if="error" class="error selectable">{{ error }}</p>
    <div class="actions">
      <button :disabled="text === loaded" @click="text = loaded">{{ t('common.revert') }}</button>
      <button class="primary" :disabled="ws.busy" @click="apply">{{ t('common.apply') }}</button>
    </div>
  </div>
</template>

<style scoped>
.spacer {
  flex: 1;
}

.editor {
  flex: 1;
  min-height: 0;
}

.error {
  color: var(--danger);
  margin: 0;
  padding: 6px 14px;
  white-space: pre-wrap;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 8px 14px;
  border-top: 1px solid var(--border);
  background: var(--bg-panel);
}
</style>
