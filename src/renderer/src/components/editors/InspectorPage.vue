<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { RefreshCw } from 'lucide-vue-next'
import type { Row } from '@shared/types'
import { t } from '@/i18n'
import { formatBytes } from '@/workspace/format'
import type { EditorTab, Workspace } from '@/workspace/workspace'
import MonacoEditor from '../editor/MonacoEditor.vue'
import { inspectorSections } from './inspector/engines'
import type { Field } from './inspector/sections'

type InspectorTab = Extract<EditorTab, { kind: 'inspector' }>

/** The Table Inspector, or the Schema Inspector when no table is given. */
const props = defineProps<{ ws: Workspace; tab: InspectorTab }>()

const engineSections = computed(() => inspectorSections(props.ws.config.engine))
const sections = computed(() => (props.tab.table ? engineSections.value.table : engineSections.value.schema))
const active = ref('info')
const section = computed(() => sections.value.find((s) => s.id === active.value) ?? sections.value[0])
const rows = ref<Row[]>([])
const ddl = ref('')
const error = ref('')
const status = ref('')
const loading = ref(false)
const analyzeOp = computed(() => props.ws.features.maintenance.find((op) => op.name === 'analyze'))

function text(row: Row, field: Field): string {
  const v = row[field.key]
  if (v === null || v === undefined) return field.bytes ? '' : 'NULL'
  return field.bytes ? formatBytes(Number(v)) : String(v)
}

async function refresh(): Promise<void> {
  const s = section.value
  const { schema, table } = props.tab
  error.value = ''
  loading.value = true
  try {
    if (!s.sql) ddl.value = s.text ? await s.text(props.ws, schema) : await props.ws.meta.ddl(table ? 'TABLE' : 'SCHEMA', schema, table)
    else {
      const sql = typeof s.sql === 'string' ? s.sql : s.sql(props.ws.dialect, schema, table)
      const query = engineSections.value.query?.(props.ws) ?? props.ws.query
      rows.value = await query(sql, table ? [schema, table] : [schema])
    }
  } catch (e) {
    error.value = (e as Error).message
    rows.value = []
  } finally {
    loading.value = false
  }
}

onMounted(refresh)
watch(active, refresh)

async function analyze(): Promise<void> {
  const sql = analyzeOp.value!.statement(props.ws.dialect, props.tab.schema, props.tab.table!)
  const r = await props.ws.runStatements([sql])
  const result = r.result?.resultSets[0]?.rows.at(-1)
  status.value = r.ok
    ? result
      ? t('inspector.analyzeResult', { result: String(result[result.length - 1]) })
      : t('inspector.analyzeDone')
    : (r.error ?? '')
  await refresh()
}

/** Double click in the schema lists opens the object. */
function open(row: Row): void {
  if (!props.tab.table) section.value.open?.(props.ws, props.tab.schema, row)
}
</script>

<template>
  <div class="page">
    <div class="page-header">
      <span>{{ tab.table ? t('inspector.titleTable', { schema: tab.schema, table: tab.table }) : t('inspector.titleSchema', { schema: tab.schema }) }}</span>
      <span class="spacer" />
      <span class="status muted">{{ status }}</span>
      <button v-if="tab.table && analyzeOp" :disabled="ws.busy" @click="analyze">{{ t('workspace.maintenance.analyzeTable') }}</button>
      <button v-if="tab.table" @click="ws.openTableEditor(tab.schema, tab.table)">{{ t('inspector.alterTable') }}</button>
      <button class="icon-btn" :title="t('inspector.refresh')" :disabled="loading" @click="refresh"><RefreshCw :size="14" /></button>
    </div>
    <div class="tabbar">
      <div v-for="s in sections" :key="s.id" class="tab" :class="{ active: s.id === section.id }" @mousedown="active = s.id">
        <span class="label">{{ s.label }}</span>
      </div>
    </div>
    <p v-if="error" class="error selectable">{{ error }}</p>
    <div v-if="!section.sql" class="ddl"><MonacoEditor :model-value="ddl" read-only /></div>
    <div v-else-if="section.info" class="page-body info">
      <table v-if="rows[0]" class="kv">
        <tbody>
          <tr v-for="field in section.fields" :key="field.key">
            <th>{{ field.label }}:</th>
            <td class="selectable">{{ text(rows[0], field) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else class="page-body">
      <table class="list">
        <thead>
          <tr>
            <th v-for="field in section.fields" :key="field.key" :class="{ num: field.bytes }">{{ field.label }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, i) in rows" :key="i" @dblclick="open(row)">
            <td v-for="field in section.fields" :key="field.key" class="selectable" :class="{ num: field.bytes, null: row[field.key] === null }">
              {{ text(row, field) }}
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!rows.length && !loading && !error" class="empty-state">{{ section.empty }}</div>
    </div>
  </div>
</template>

<style scoped>
.spacer {
  flex: 1;
}

.page-header button {
  font-size: var(--fs);
  font-weight: normal;
}

.status {
  font-size: var(--fs);
  font-weight: normal;
}

.error {
  color: var(--danger);
  margin: 0;
  padding: 6px 14px;
  white-space: pre-wrap;
}

.ddl {
  flex: 1;
  min-height: 0;
}

.info {
  padding: 12px 14px;
}

table.kv {
  border-collapse: collapse;
}

table.kv th,
table.kv td {
  padding: 3px 0;
  text-align: left;
  vertical-align: top;
}

table.kv th {
  padding-right: 16px;
  font-weight: normal;
  color: var(--text-muted);
  white-space: nowrap;
}

td.num,
th.num {
  text-align: right !important;
}

td.null {
  color: var(--null);
}

.page-body .empty-state {
  height: auto;
  padding: 30px;
}
</style>
