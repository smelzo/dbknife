<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import type { AlignKind, AlignObjectRef, AlignOptions, Alignment } from '@shared/types'
import type { MessageKey } from '@shared/i18n'
import type { Workspace } from '@/workspace/workspace'
import { alertError, promptText } from '@/dialogs'
import { t } from '@/i18n'
import { environmentLabel, useApp } from '@/stores/app'
import Modal from '../common/Modal.vue'
import { alignConnection, openSessionFor, type AlignSession } from './align-sessions'
import { noteText, runAlignment } from './align-run'
import { useToolJob } from './tool-job'

/**
 * Quick alignment from the table menu (MySQL/MariaDB): the objects of the
 * schema to align, with the table chosen, a target and the options; Align
 * applies them here, Save As saves them, Compare opens the Alignments editor.
 */
const props = defineProps<{ ws: Workspace; schema: string; table: string }>()
const emit = defineEmits<{ close: [] }>()
const app = useApp()

// --- objects of the source ------------------------------------------------------

const kinds: AlignKind[] = ['table', 'sequence', 'view', 'procedure', 'function', 'trigger', 'event']
const groupLabels: Record<AlignKind, MessageKey> = {
  table: 'schemaTree.tables',
  sequence: 'schemaTree.sequences',
  view: 'schemaTree.views',
  procedure: 'schemaTree.procedures',
  function: 'schemaTree.functions',
  trigger: 'schemaTree.triggers',
  event: 'admin.copy.events'
}
/** TABLE_TYPE of the objects the alignment knows, as the main reads them. */
const relationKinds: Record<string, AlignKind | undefined> = { 'BASE TABLE': 'table', VIEW: 'view', SEQUENCE: 'sequence' }

const objects = ref<AlignObjectRef[]>([])
const loading = ref(true)
const keyOf = (o: AlignObjectRef): string => `${o.kind}\u0000${o.name}`
const checked = reactive(new Set<string>([keyOf({ kind: 'table', name: props.table })]))
const groups = computed(() =>
  kinds
    .map((kind) => ({ kind, items: objects.value.filter((o) => o.kind === kind) }))
    .filter((g) => g.items.length)
    .map((g) => ({ ...g, checked: g.items.filter((o) => checked.has(keyOf(o))).length }))
)
/** Plain objects, in the order of the list, as IPC takes them. */
const chosen = computed<AlignObjectRef[]>(() => objects.value.filter((o) => checked.has(keyOf(o))).map((o) => ({ kind: o.kind, name: o.name })))

function setChecked(items: AlignObjectRef[], on: boolean): void {
  for (const o of items) {
    if (on) checked.add(keyOf(o))
    else checked.delete(keyOf(o))
  }
}

async function loadObjects(): Promise<void> {
  const s = props.ws.sessionId
  const read = async (sql: string): Promise<{ name: string; type: string }[]> => {
    const r = await window.api.db.query(s, sql, [props.schema])
    if (r.error) throw new Error(r.error.message)
    return r.rows.map((x) => ({ name: String(x.name), type: String(x.type) }))
  }
  try {
    const list: AlignObjectRef[] = []
    for (const r of await read('SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME')) {
      const kind = relationKinds[r.type]
      if (kind) list.push({ kind, name: r.name })
    }
    for (const r of await read('SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS type FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME')) {
      // MariaDB's packages are left out, as the main does
      if (r.type === 'PROCEDURE' || r.type === 'FUNCTION') list.push({ kind: r.type === 'PROCEDURE' ? 'procedure' : 'function', name: r.name })
    }
    for (const r of await read("SELECT TRIGGER_NAME AS name, 'TRIGGER' AS type FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME")) list.push({ kind: 'trigger', name: r.name })
    for (const r of await read("SELECT EVENT_NAME AS name, 'EVENT' AS type FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME")) list.push({ kind: 'event', name: r.name })
    objects.value = list
  } catch (err) {
    await alertError(t('admin.align.dialog.objectsFailed', { schema: props.schema }), (err as Error).message)
  } finally {
    loading.value = false
  }
}

// --- target and options -------------------------------------------------------------

/** The workspace's connection first, then the other MySQL/MariaDB ones. */
const connections = computed(() => [props.ws.config, ...app.connections.filter((c) => c.engine === 'mysql' && c.id !== props.ws.config.id)])
const target = reactive({ connectionId: '', schema: '', schemas: [] as string[], session: undefined as AlignSession | undefined })
/** Number of the latest choice: a session still opening for an earlier one is closed when it arrives. */
let opening = 0
let unmounted = false
const targetConfig = computed(() => alignConnection(props.ws, target.connectionId))

async function chooseTarget(connectionId: string): Promise<void> {
  const n = ++opening
  target.session?.close()
  Object.assign(target, { connectionId, schema: '', schemas: [], session: undefined })
  if (!connectionId) return
  const s = await openSessionFor(props.ws, connectionId)
  if (n !== opening || unmounted) return s?.close()
  if (!s) {
    target.connectionId = ''
    return
  }
  target.session = s
  const r = await window.api.db.query(s.sessionId, 'SELECT SCHEMA_NAME AS s FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME')
  if (n !== opening) return
  if (r.error) await alertError(t('admin.align.schemasFailed', { name: targetConfig.value?.name ?? '' }), r.error.message)
  // the source schema is not a target of itself
  const same = connectionId === props.ws.config.id
  target.schemas = r.error ? [] : r.rows.map((x) => String(x.s)).filter((x) => !props.ws.dialect.isSystemSchema(x) && !(same && x === props.schema))
}

const options = reactive<AlignOptions>({ structure: true, data: true, deleteRows: false, definers: 'keep', backup: true })

// --- align, save, compare -----------------------------------------------------------

const tool = useToolJob()
const { job } = tool
const logEl = ref<HTMLElement>()
const savedAs = ref('')

const complete = computed(() => !!target.session && !!target.schema && chosen.value.length > 0)
const canAlign = computed(() => complete.value && (options.structure || options.data) && !job.running)

const draft = (): Partial<Alignment> => ({
  source: { connectionId: props.ws.config.id, schema: props.schema },
  target: { connectionId: target.connectionId, schema: target.schema },
  objects: chosen.value,
  drop: [],
  options: { ...options }
})

const summary = computed(() =>
  target.schema
    ? t('admin.align.dialog.summary', { count: chosen.value.length, connection: targetConfig.value?.name ?? '', schema: target.schema })
    : t('admin.align.objectsCount', { count: chosen.value.length })
)
/** The running job, else the latest of Save As and the job's outcome. */
const statusText = computed(() => {
  if (!job.running && savedAs.value) return t('admin.align.dialog.saved', { name: savedAs.value })
  return job.message || t('admin.align.dialog.pressAlign')
})

async function align(): Promise<void> {
  if (!canAlign.value) return
  savedAs.value = ''
  await runAlignment(
    props.ws,
    {
      source: { sessionId: props.ws.sessionId, schema: props.schema },
      target: { sessionId: target.session!.sessionId, schema: target.schema },
      objects: chosen.value,
      drop: [],
      options: { ...options }
    },
    target.connectionId,
    tool
  )
}

async function saveAs(): Promise<void> {
  const typed = await promptText(t('admin.align.saveTitle'), t('admin.align.name'), t('admin.align.defaultName', { source: props.schema, target: target.schema }))
  const name = typed?.trim()
  if (!name) return
  const alignment = { ...draft(), id: crypto.randomUUID(), name, runs: [] } as Alignment
  try {
    await window.api.alignments.save(alignment)
    savedAs.value = name
  } catch (err) {
    await alertError(t('admin.align.saveFailed', { name }), (err as Error).message)
  }
}

function compare(): void {
  const d = draft()
  emit('close')
  props.ws.openAdmin('align', undefined, d)
}

watch(
  () => job.log,
  () => nextTick(() => logEl.value && (logEl.value.scrollTop = logEl.value.scrollHeight))
)

onMounted(() => Promise.all([loadObjects(), chooseTarget(props.ws.config.id)]))

// a job already started goes on in the main, on sessions of its own
onUnmounted(() => {
  unmounted = true
  opening++
  target.session?.close()
})
</script>

<template>
  <Modal :title="t('admin.align.dialog.title', { schema })" width="780px" height="600px" @cancel="emit('close')">
    <div class="layout">
      <div class="cols">
        <div class="col">
          <h3>{{ t('admin.align.source') }}</h3>
          <div class="line">
            <span v-if="ws.config.environment" class="env-badge" :class="`env-${ws.config.environment}`">{{ environmentLabel(ws.config.environment) }}</span>
            {{ ws.config.name }} · <b>{{ schema }}</b>
          </div>
          <div class="line">
            <span class="muted">{{ t('admin.align.dialog.objects') }}</span>
            <span class="spacer" />
            <button :disabled="job.running" @click="setChecked(objects, true)">{{ t('admin.align.dialog.all') }}</button>
            <button :disabled="job.running" @click="setChecked(objects, false)">{{ t('admin.align.dialog.none') }}</button>
          </div>
          <div class="tree">
            <div v-if="!loading && !objects.length" class="empty-state">{{ t('admin.align.dialog.noObjects') }}</div>
            <template v-for="g in groups" :key="g.kind">
              <label class="check group">
                <input
                  type="checkbox"
                  :checked="g.checked === g.items.length"
                  :indeterminate="g.checked > 0 && g.checked < g.items.length"
                  :disabled="job.running"
                  @change="setChecked(g.items, ($event.target as HTMLInputElement).checked)"
                />
                {{ t('admin.align.dialog.group', { kind: t(groupLabels[g.kind]), checked: g.checked, total: g.items.length }) }}
              </label>
              <label v-for="o in g.items" :key="keyOf(o)" class="check item">
                <input type="checkbox" :checked="checked.has(keyOf(o))" :disabled="job.running" @change="setChecked([o], ($event.target as HTMLInputElement).checked)" />
                {{ o.name }}
              </label>
            </template>
          </div>
        </div>

        <div class="col">
          <h3>{{ t('admin.align.target') }}</h3>
          <div class="form-grid">
            <label for="ad-connection">{{ t('admin.align.targetConnection') }}</label>
            <select id="ad-connection" :value="target.connectionId" :disabled="job.running" @change="chooseTarget(($event.target as HTMLSelectElement).value)">
              <option value="">{{ t('admin.copy.chooseConnection') }}</option>
              <option v-for="c in connections" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
            <label for="ad-schema">{{ t('admin.align.targetSchema') }}</label>
            <select id="ad-schema" v-model="target.schema" :disabled="job.running">
              <option value="" disabled>{{ t('admin.align.chooseSchema') }}</option>
              <option v-for="s in target.schemas" :key="s" :value="s">{{ s }}</option>
            </select>
          </div>
          <p v-if="targetConfig?.environment === 'production'" class="hint">
            <span class="env-badge env-production">{{ environmentLabel('production') }}</span> {{ t('admin.align.dialog.productionHint') }}
          </p>
          <fieldset :disabled="job.running">
            <legend>{{ t('admin.align.dialog.options') }}</legend>
            <label class="check"><input v-model="options.structure" type="checkbox" /> {{ t('admin.align.structure') }}</label>
            <label class="check"><input v-model="options.data" type="checkbox" /> {{ t('admin.align.data') }}</label>
            <label class="check sub"><input v-model="options.deleteRows" type="checkbox" :disabled="!options.data" /> {{ t('admin.align.deleteRows') }}</label>
            <label class="check"><input v-model="options.backup" type="checkbox" /> {{ t('admin.align.backup') }}</label>
            <div class="line">
              <label for="ad-definers" class="muted">{{ t('admin.copy.definers') }}</label>
              <select id="ad-definers" v-model="options.definers">
                <option value="keep">{{ t('admin.copy.keepDefiners') }}</option>
                <option value="remove">{{ t('admin.copy.removeDefiners') }}</option>
              </select>
            </div>
          </fieldset>
        </div>
      </div>

      <div class="run">
        <div class="line">
          <span class="status" :class="{ error: job.error }" :title="statusText">{{ statusText }}</span>
          <button v-if="job.running" @click="tool.cancel">{{ t('common.cancel') }}</button>
        </div>
        <progress v-if="job.running" :value="job.progress >= 0 ? job.progress : undefined" max="1" />
        <ul v-if="job.preview?.warnings.length" class="warnings">
          <li v-for="(w, i) in job.preview.warnings" :key="i" class="selectable">{{ noteText(w) }}</li>
        </ul>
        <pre ref="logEl" class="log selectable">{{ job.log }}</pre>
      </div>
    </div>

    <template #footer>
      <span class="summary muted">{{ summary }}</span>
      <button @click="emit('close')">{{ t('common.close') }}</button>
      <button :disabled="!chosen.length || job.running" @click="compare">{{ t('admin.align.dialog.compare') }}</button>
      <button :disabled="!complete || job.running" @click="saveAs">{{ t('admin.align.dialog.saveAs') }}</button>
      <button class="primary" :disabled="!canAlign" @click="align">{{ t('admin.align.dialog.align') }}</button>
    </template>
  </Modal>
</template>

<style scoped>
.layout {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.cols {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}

.col {
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

h3 {
  margin: 0;
  font-size: var(--fs);
  font-weight: 600;
}

.line {
  display: flex;
  align-items: center;
  gap: 6px;
}

.spacer {
  flex: 1;
}

.env-badge {
  padding: 0 5px;
  border-radius: 3px;
  background: var(--env);
  color: var(--env-text);
  font-size: var(--fs-small);
  font-weight: 600;
}

.tree {
  position: relative;
  flex: 1;
  min-height: 120px;
  overflow: auto;
  padding: 4px 0;
  border: 1px solid var(--border);
  background: var(--bg-content);
}

.tree .check {
  display: flex;
  padding: 1px 8px;
}

.tree .group {
  font-weight: 600;
}

.tree .item {
  padding-left: 28px;
}

.tree .empty-state {
  position: absolute;
  inset: 0;
  height: auto;
}

fieldset {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
}

legend {
  padding: 0 4px;
  color: var(--text-muted);
}

.sub {
  margin-left: 22px;
}

.hint {
  margin: 0;
  color: var(--danger);
}

.run {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.status {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.error {
  color: var(--danger);
}

progress {
  width: 100%;
  height: 8px;
  accent-color: var(--accent);
}

.warnings {
  margin: 0;
  padding-left: 18px;
  color: var(--warning);
  font-size: var(--fs-small);
}

.log {
  height: 90px;
  margin: 0;
  padding: 6px 8px;
  overflow: auto;
  border: 1px solid var(--border);
  background: var(--bg-panel);
  font-family: var(--font-mono);
  font-size: var(--fs-small);
  white-space: pre-wrap;
}

.summary {
  flex: 1;
  min-width: 0;
  align-self: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
