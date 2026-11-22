<script setup lang="ts">
import { computed, onMounted, ref, toRaw, watch } from 'vue'
import type { TableDef } from '@shared/sql/create-table'
import { t } from '@/i18n'
import type { TriggerMeta } from '@/workspace/metadata'
import { reviewAndApply } from '@/workspace/review'
import type { EditorTab, Workspace } from '@/workspace/workspace'
import MonacoEditor from '../editor/MonacoEditor.vue'
import ColumnsTab from './table/ColumnsTab.vue'
import IndexesTab from './table/IndexesTab.vue'
import ForeignKeysTab from './table/ForeignKeysTab.vue'
import { tableEditorEngine } from './table/engines'
import type { Collation } from './table/model'

type TableTab = Extract<EditorTab, { kind: 'table' }>

/** The Create/Alter Table editor: edits a model of the table read by the engine's TableEditorEngine. */
const props = defineProps<{ ws: Workspace; tab: TableTab }>()

type Section = 'columns' | 'indexes' | 'fks' | 'triggers' | 'options'
const engine = computed(() => tableEditorEngine(props.ws.config.engine))
const sections = computed<{ id: Section; label: string }[]>(() => [
  { id: 'columns', label: t('tableEditor.tab.columns') },
  { id: 'indexes', label: t('tableEditor.tab.indexes') },
  { id: 'fks', label: t('tableEditor.tab.fks') },
  ...(props.ws.features.triggers ? [{ id: 'triggers' as const, label: t('tableEditor.tab.triggers') }] : []),
  { id: 'options', label: t('tableEditor.tab.options') }
])
const rowFormats = ['DEFAULT', 'DYNAMIC', 'FIXED', 'COMPRESSED', 'REDUNDANT', 'COMPACT']

const section = ref<Section>('columns')
/** Table as it is on the server; null for a table not created yet. */
const original = ref<TableDef | null>(null)
const model = ref<TableDef>(engine.value.newTable())
const ddl = ref('')
/** Set when the table could not be read or understood: the editor is read-only. */
const loadError = ref('')
const error = ref('')
const notice = ref('')
const triggers = ref<TriggerMeta[]>([])
const collations = ref<Collation[]>([])
const engines = ref<string[]>([])

const clone = (def: TableDef): TableDef => structuredClone(toRaw(def))

const charsets = computed(() => [...new Set(collations.value.map((c) => c.charset))].sort())
const tableCollations = computed(() =>
  collations.value.filter((c) => !model.value.options.charset || c.charset === model.value.options.charset).map((c) => c.name)
)

/** Statements of the edits, or why the engine cannot make them. */
const script = computed<{ statements: string[]; refusal: string }>(() => {
  if (loadError.value) return { statements: [], refusal: '' }
  try {
    const statements = original.value ? engine.value.alter(props.tab.schema, original.value, model.value) : engine.value.create(props.tab.schema, model.value)
    return { statements, refusal: '' }
  } catch (e) {
    return { statements: [], refusal: (e as Error).message }
  }
})
const statements = computed(() => script.value.statements)
/** Changes not applied, as Revert sees them; a new table starts from the engine's template, whose CREATE is never empty. */
const dirty = computed(() =>
  original.value
    ? statements.value.length > 0 || !!script.value.refusal
    : JSON.stringify(model.value) !== JSON.stringify(engine.value.newTable())
)
watch(dirty, (d) => (props.tab.dirty = d), { immediate: true })

async function loadLists(): Promise<void> {
  collations.value = await engine.value.collations(props.ws).catch(() => [])
  if (!engine.value.mysqlOptions) return
  const r = await window.api.db.query(
    props.ws.sessionId,
    "SELECT ENGINE AS name FROM information_schema.ENGINES WHERE SUPPORT IN ('YES', 'DEFAULT') ORDER BY ENGINE"
  )
  engines.value = r.rows.map((row) => String(row.name))
}

async function load(): Promise<void> {
  loadError.value = ''
  error.value = ''
  const table = props.tab.table
  if (!table) {
    original.value = null
    model.value = engine.value.newTable()
    return
  }
  try {
    original.value = await engine.value.load(props.ws, props.tab.schema, table)
    model.value = clone(original.value)
  } catch (e) {
    loadError.value = (e as Error).message
    ddl.value = await props.ws.meta.ddl('TABLE', props.tab.schema, table).catch(() => '')
  }
  triggers.value = await props.ws.meta.loadTriggers(props.tab.schema, table).catch(() => [])
}

onMounted(() => {
  void loadLists()
  void props.ws.meta.loadObjects(props.tab.schema).catch(() => undefined)
  void load()
})

function revert(): void {
  error.value = ''
  model.value = original.value ? clone(original.value) : engine.value.newTable()
}

function setCharset(charset: string): void {
  model.value.options.charset = charset
  model.value.options.collation = ''
}

/** Problems the server would report less clearly. */
function validate(def: TableDef): string {
  if (!def.name.trim()) return t('tableEditor.validate.noName')
  if (!def.columns.length) return t('tableEditor.validate.noColumns')
  const names = def.columns.map((c) => c.name.toLowerCase())
  const dup = names.find((n, i) => names.indexOf(n) !== i)
  if (dup) return t('tableEditor.validate.duplicateColumn', { name: dup })
  const empty = def.indexes.find((i) => !i.columns.length)
  if (empty) return t('tableEditor.validate.indexWithoutColumns', { name: empty.name })
  const unnamed = def.indexes.find((i) => !i.name.trim() && !i.constraint)
  if (unnamed) return t('tableEditor.validate.indexWithoutName')
  const fk = def.foreignKeys.find((f) => !f.refTable || !f.columns.length || f.refColumns.some((c) => !c))
  if (fk) return t('tableEditor.validate.fkIncomplete', { name: fk.name })
  return ''
}

async function apply(): Promise<void> {
  error.value = validate(model.value)
  notice.value = ''
  const sql = statements.value
  if (error.value || !sql.length) return
  const schema = props.tab.schema
  const applied = await reviewAndApply(props.ws, sql, { cleanup: engine.value.cleanup })
  if (!applied && sql.length === 1) return
  props.ws.meta.invalidate(schema)
  void props.ws.meta.loadObjects(schema, true)
  if (!applied) {
    // an earlier statement may have run: compare the edits with what the server has now
    if (props.tab.table) {
      original.value = await engine.value.load(props.ws, schema, props.tab.table).catch(() => original.value)
    }
    return
  }
  props.tab.table = model.value.name
  props.tab.title = t('workspace.tab.table', { name: model.value.name })
  await load()
  notice.value = (await engine.value.afterApply?.(props.ws, schema, model.value.name).catch(() => '')) ?? ''
}
</script>

<template>
  <div class="page table-editor">
    <div class="header">
      <div class="form-grid">
        <label>{{ t('tableEditor.tableName') }}</label>
        <input v-model.trim="model.name" type="text" :disabled="!!loadError" spellcheck="false" />
        <template v-if="engine.mysqlOptions">
          <label>{{ t('tableEditor.charsetCollation') }}</label>
          <div class="pair">
            <select :value="model.options.charset" :disabled="!!loadError" @change="setCharset(($event.target as HTMLSelectElement).value)">
              <option value="">{{ t('tableEditor.schemaDefault') }}</option>
              <option v-if="model.options.charset && !charsets.includes(model.options.charset)">{{ model.options.charset }}</option>
              <option v-for="cs in charsets" :key="cs">{{ cs }}</option>
            </select>
            <select v-model="model.options.collation" :disabled="!!loadError">
              <option value="">{{ t('common.default') }}</option>
              <option v-if="model.options.collation && !tableCollations.includes(model.options.collation)">{{ model.options.collation }}</option>
              <option v-for="co in tableCollations" :key="co">{{ co }}</option>
            </select>
          </div>
        </template>
      </div>
      <div class="form-grid">
        <label>{{ t('tableEditor.schema') }}</label>
        <input type="text" :value="tab.schema" disabled />
        <template v-if="engine.mysqlOptions">
          <label>{{ t('tableEditor.engine') }}</label>
          <select v-model="model.options.engine" :disabled="!!loadError">
            <option v-if="model.options.engine && !engines.includes(model.options.engine)">{{ model.options.engine }}</option>
            <option v-for="e in engines" :key="e">{{ e }}</option>
          </select>
        </template>
      </div>
      <div v-if="engine.comments" class="form-grid comments">
        <label>{{ t('tableEditor.comments') }}</label>
        <textarea v-model="model.options.comment" rows="3" :disabled="!!loadError" />
      </div>
    </div>
    <div class="tabbar">
      <div v-for="s in sections" :key="s.id" class="tab" :class="{ active: section === s.id }" @mousedown="section = s.id">
        <span class="label">{{ s.label }}</span>
      </div>
    </div>
    <div v-if="loadError" class="body readonly">
      <p class="error selectable">{{ t('tableEditor.cannotEdit', { error: loadError }) }}</p>
      <div class="ddl"><MonacoEditor :model-value="ddl" read-only /></div>
    </div>
    <div v-else class="body">
      <ColumnsTab v-if="section === 'columns'" :model="model" :collations="collations" :engine="engine" :existing="!!original" />
      <IndexesTab v-else-if="section === 'indexes'" :model="model" :engine="engine" />
      <ForeignKeysTab v-else-if="section === 'fks'" :ws="ws" :schema="tab.schema" :model="model" :engine="engine" />
      <div v-else-if="section === 'triggers'" class="triggers">
        <div class="toolbar">
          <button :disabled="!tab.table" @click="ws.openRoutineEditor(tab.schema, 'TRIGGER', null, tab.table!)">{{ t('tableEditor.triggers.add') }}</button>
          <span v-if="!tab.table" class="muted">{{ t('tableEditor.triggers.applyFirst') }}</span>
        </div>
        <table class="list">
          <thead>
            <tr>
              <th>{{ t('tableEditor.triggers.name') }}</th>
              <th>{{ t('tableEditor.triggers.timing') }}</th>
              <th>{{ t('tableEditor.triggers.event') }}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            <tr v-for="tr in triggers" :key="tr.name" @dblclick="ws.openRoutineEditor(tab.schema, 'TRIGGER', tr.name, tab.table!)">
              <td>{{ tr.name }}</td>
              <td>{{ tr.timing }}</td>
              <td>{{ tr.event }}</td>
              <td class="edit"><button @click="ws.openRoutineEditor(tab.schema, 'TRIGGER', tr.name, tab.table!)">{{ t('tableEditor.triggers.edit') }}</button></td>
            </tr>
          </tbody>
        </table>
        <div v-if="!triggers.length" class="empty-state">{{ t('tableEditor.triggers.none') }}</div>
      </div>
      <div v-else class="options">
        <div class="form-grid">
          <template v-if="engine.mysqlOptions">
            <label>{{ t('tableEditor.rowFormat') }}</label>
            <select v-model="model.options.rowFormat">
              <option value="">{{ t('common.default') }}</option>
              <option v-for="f in rowFormats" :key="f">{{ f }}</option>
            </select>
            <label>{{ t('tableEditor.autoIncrement') }}</label>
            <input v-model.trim="model.options.autoIncrement" type="text" :placeholder="t('tableEditor.nextValue')" />
          </template>
          <template v-if="model.options.other">
            <label>{{ t('tableEditor.otherOptions') }}</label>
            <span class="mono selectable">{{ model.options.other }}</span>
          </template>
          <template v-if="model.otherDefinitions.length">
            <label>{{ t('tableEditor.keptDefinitions') }}</label>
            <pre class="mono selectable">{{ model.otherDefinitions.join(',\n') }}</pre>
          </template>
          <template v-if="model.options.partition">
            <label>{{ t('tableEditor.partitioning') }}</label>
            <pre class="mono selectable">{{ model.options.partition }}</pre>
          </template>
        </div>
        <p class="muted note">{{ t('tableEditor.keptNote') }}</p>
      </div>
    </div>
    <p v-if="error || script.refusal" class="error selectable">{{ error || script.refusal }}</p>
    <p v-if="notice" class="notice selectable">{{ notice }}</p>
    <div class="actions">
      <button :disabled="!!loadError || (!statements.length && !script.refusal)" @click="revert">{{ t('common.revert') }}</button>
      <button class="primary" :disabled="ws.busy || !statements.length" @click="apply">{{ t('common.apply') }}</button>
    </div>
  </div>
</template>

<style scoped>
.header {
  display: grid;
  grid-template-columns: 1fr minmax(200px, 0.7fr) 1fr;
  gap: 8px 24px;
  padding: 12px 14px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.header .form-grid {
  align-content: start;
}

.header .comments {
  align-items: start;
}

.header textarea {
  font-family: var(--font-ui);
  resize: none;
  height: 100%;
}

.pair {
  display: flex;
  gap: 8px;
  min-width: 0;
}

.pair select {
  flex: 1;
  min-width: 0;
}

.body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.body > * {
  flex: 1;
  min-height: 0;
}

.readonly .error {
  flex: 0 0 auto;
}

.ddl {
  border-top: 1px solid var(--border);
}

.triggers {
  overflow: auto;
}

.triggers .toolbar {
  gap: 10px;
}

.triggers .empty-state {
  height: auto;
  padding: 30px;
}

td.edit {
  width: 1%;
}

.options {
  overflow: auto;
  padding: 14px;
}

.options .form-grid {
  max-width: 760px;
  align-items: start;
}

.options .form-grid > label {
  padding-top: 3px;
}

.options select,
.options input {
  justify-self: start;
  min-width: 180px;
}

.options pre {
  margin: 0;
  padding-top: 3px;
  white-space: pre-wrap;
}

.note {
  margin-top: 18px;
}

.error {
  color: var(--danger);
  margin: 0;
  padding: 6px 14px;
  white-space: pre-wrap;
}

.notice {
  color: var(--warning);
  margin: 0;
  padding: 6px 14px;
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
