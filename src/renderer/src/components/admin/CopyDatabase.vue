<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { FolderOpen, RefreshCw } from 'lucide-vue-next'
import type { CopyOptions, CopyPreview, CopySchemaRef, ToolInfo } from '@shared/types'
import type { Workspace } from '@/workspace/workspace'
import { alertError, confirm } from '@/dialogs'
import { t } from '@/i18n'
import { useApp, withCredentials } from '@/stores/app'
import type { AdminTab } from './admin'
import { useToolJob } from './tool-job'

/**
 * Copy Database (MySQL/MariaDB): the checked schemas, renamed if needed, to a
 * SQL script file, to the same server or to another saved connection.
 */
const props = defineProps<{ ws: Workspace; tab: AdminTab }>()
const app = useApp()

type TargetKind = CopyOptions['target']['kind']

/** Checked schemas → their names in the target. */
const selection = reactive(new Map<string, string>())
const targetKind = ref<TargetKind>('instance')
const filePath = ref('')
const connectionId = ref('')
/** Session opened on the chosen connection; closed when the choice changes, when the job ends and on unmount. */
const targetSession = ref('')
const content = ref<CopyOptions['content']>('both')
const routines = ref(true)
const triggers = ref(true)
const events = ref(true)
const definers = ref<CopyOptions['definers']>('keep')
/** Once the user picks the DEFINER option, it no longer follows the target. */
const definersTouched = ref(false)
const existing = ref<CopyOptions['existing']>('stop')
const preview = ref<CopyPreview>()
const previewing = ref(false)
const previewError = ref('')
/** Source collation → its replacement ('' = unchanged). */
const collations = reactive<Record<string, string>>({})
const tool = ref<ToolInfo>()
const toolChecked = ref(false)
const logEl = ref<HTMLElement>()

const flavorLabels: Partial<Record<ToolInfo['flavor'], string>> = { mysql: 'MySQL', mariadb: 'MariaDB' }
const connections = computed(() => app.connections.filter((c) => c.engine === 'mysql' && c.id !== props.ws.config.id))
/** A server target, whose missing collations must be replaced; a script file may replace them freely. */
const toServer = computed(() => targetKind.value !== 'file')

/** Session of the running job's target connection, closed when the job ends. */
let jobTarget: { kind: TargetKind; sessionId: string } | undefined

const { job, start, cancel } = useToolJob((p) => {
  props.ws.log(p.error ? 'error' : 'ok', t('workspace.admin.copy'), p.error ?? p.message ?? '')
  if (jobTarget?.kind === 'instance') {
    props.ws.refreshAfterDdl()
    // the copy created the target schemas: the next start must see them as existing
    schedulePreview()
  }
  if (jobTarget?.kind === 'connection' && jobTarget.sessionId === targetSession.value) void chooseConnection('')
  jobTarget = undefined
})

const defaultName = (schema: string, kind = targetKind.value): string => (kind === 'instance' ? `${schema}_copy` : schema)

function toggleSchema(schema: string, checked: boolean): void {
  if (checked) selection.set(schema, defaultName(schema))
  else selection.delete(schema)
}

const refs = computed<CopySchemaRef[]>(() => [...selection].map(([source, target]) => ({ source, target: target.trim() })))

/** The target name of a checked schema is empty, the source itself on the same server, or given twice. */
function nameProblem(source: string): boolean {
  const name = selection.get(source)?.trim().toLowerCase()
  if (!name) return true
  if (targetKind.value === 'instance' && name === source.toLowerCase()) return true
  return refs.value.filter((r) => r.target.toLowerCase() === name).length > 1
}

const existingTargets = computed(() => (toServer.value ? (preview.value?.existing ?? []).map((s) => s.toLowerCase()) : []))
const exists = (source: string): boolean => existingTargets.value.includes(selection.get(source)?.trim().toLowerCase() ?? '')

// --- target connection --------------------------------------------------------

let opening = 0

function closeTarget(): void {
  if (targetSession.value) void window.api.db.close(targetSession.value)
  targetSession.value = ''
}

async function chooseConnection(id: string): Promise<void> {
  const n = ++opening
  closeTarget()
  connectionId.value = id
  const config = connections.value.find((c) => c.id === id)
  if (!config) return
  const r = await withCredentials(config, (c) => window.api.db.open(config.id, c))
  // a later choice (or the page closing) supersedes this one
  if (n !== opening) {
    if (r?.ok) void window.api.db.close(r.sessionId!)
    return
  }
  if (r?.ok) {
    targetSession.value = r.sessionId!
    return
  }
  connectionId.value = ''
  if (r) await alertError(t('app.connectFailed', { name: config.name }), r.error?.message)
}

watch(targetKind, (kind, old) => {
  for (const [schema, name] of selection) if (name === defaultName(schema, old)) selection.set(schema, defaultName(schema, kind))
  if (!definersTouched.value) definers.value = kind === 'connection' ? 'remove' : 'keep'
  if (kind !== 'connection') void chooseConnection('')
})

// --- collations ---------------------------------------------------------------

/** For a file, the source's own collations are the replacements offered. */
const previewSession = computed(() => (targetKind.value === 'connection' ? targetSession.value : props.ws.sessionId))
const available = computed(() => new Set((preview.value?.available ?? []).map((c) => c.name.toLowerCase())))
const missing = (collation: string): boolean => toServer.value && !available.value.has(collation.toLowerCase())
/** The collations of a charset, its default first. */
const choicesFor = (charset: string): CopyPreview['available'] =>
  (preview.value?.available ?? []).filter((c) => c.charset.toLowerCase() === charset.toLowerCase()).sort((a, b) => Number(b.isDefault) - Number(a.isDefault))

/** Keeps the replacements still offered; the others go back to none, since a replacement is always the user's choice. */
function applyPreview(p: CopyPreview): void {
  preview.value = p
  for (const c of p.used) {
    if (!choicesFor(c.charset).some((x) => x.name === collations[c.name])) collations[c.name] = ''
  }
}

let previewTimer: ReturnType<typeof setTimeout> | undefined
let previewRun = 0

async function loadPreview(): Promise<void> {
  const n = ++previewRun
  previewError.value = ''
  try {
    const p = refs.value.length && previewSession.value ? await window.api.tools.copyPreview(props.ws.sessionId, refs.value, previewSession.value) : undefined
    if (n !== previewRun) return
    if (p) applyPreview(p)
    else preview.value = undefined
  } catch (err) {
    if (n !== previewRun) return
    preview.value = undefined
    previewError.value = (err as Error).message
  }
  previewing.value = false
}

// target names are typed: wait for a pause before asking the servers
function schedulePreview(): void {
  previewing.value = true
  clearTimeout(previewTimer)
  previewTimer = setTimeout(loadPreview, 300)
}

watch([refs, previewSession], schedulePreview)

const unmapped = computed(() => toServer.value && !!preview.value?.used.some((c) => missing(c.name) && !collations[c.name]))

/** The replacements chosen: those of the missing collations for a server, any given for a file. */
const collationMap = computed(() =>
  Object.fromEntries(
    (preview.value?.used ?? []).filter((c) => collations[c.name] && (!toServer.value || missing(c.name))).map((c) => [c.name, collations[c.name]])
  )
)

// --- start --------------------------------------------------------------------

const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')

async function chooseFile(): Promise<void> {
  const path = await window.api.files.chooseSave({
    title: t('admin.copy.toFile'),
    defaultPath: filePath.value || `Copy${today}.sql`,
    filters: [{ name: t('main.files.sqlFiles'), extensions: ['sql'] }]
  })
  if (path) filePath.value = path
}

async function refresh(): Promise<void> {
  await props.ws.meta.loadSchemas()
}

const targetReady = computed(() =>
  targetKind.value === 'file' ? !!filePath.value.trim() : targetKind.value === 'connection' ? !!targetSession.value : true
)
const canStart = computed(
  () =>
    !job.running &&
    refs.value.length > 0 &&
    !refs.value.some((r) => nameProblem(r.source)) &&
    targetReady.value &&
    !previewing.value &&
    !!preview.value &&
    !unmapped.value &&
    (content.value === 'structure' || !!tool.value)
)

async function startCopy(): Promise<void> {
  const existingNames = refs.value.filter((r) => exists(r.source)).map((r) => r.target)
  if (existing.value === 'recreate' && existingNames.length) {
    const ok = await confirm(t('admin.copy.recreateConfirm', { schemas: existingNames.join(', ') }), t('admin.copy.recreateDetail'), t('admin.copy.recreate'))
    if (!ok) return
  }
  const target: CopyOptions['target'] =
    targetKind.value === 'file'
      ? { kind: 'file', path: filePath.value.trim() }
      : targetKind.value === 'connection'
        ? { kind: 'connection', sessionId: targetSession.value }
        : { kind: 'instance' }
  const options: CopyOptions = {
    schemas: refs.value,
    content: content.value,
    routines: routines.value,
    triggers: triggers.value,
    events: events.value,
    definers: definers.value,
    existing: existing.value,
    collations: collationMap.value,
    target
  }
  jobTarget = { kind: target.kind, sessionId: targetSession.value }
  void start(() => window.api.tools.copyDatabase(props.ws.sessionId, options))
}

watch(
  () => job.log,
  () => nextTick(() => logEl.value && (logEl.value.scrollTop = logEl.value.scrollHeight))
)

onMounted(async () => {
  await props.ws.meta.loadSchemas()
  if (props.tab.schema) toggleSchema(props.tab.schema, true)
  tool.value = (await window.api.tools.find(props.ws.sessionId)).dump
  toolChecked.value = true
})

onUnmounted(() => {
  opening++
  clearTimeout(previewTimer)
  closeTarget()
})
</script>

<template>
  <div class="page">
    <div class="page-header">
      {{ t('workspace.admin.copy') }}
      <span class="spacer" />
      <span v-if="tool" class="tool muted" :title="tool.path">{{ tool.path.split('/').pop() }} {{ tool.version }} ({{ flavorLabels[tool.flavor] }})</span>
      <span v-else-if="toolChecked" class="tool error">{{ t('admin.toolNotFound', { tool: 'mysqldump' }) }}</span>
    </div>
    <div class="page-body copy">
      <section class="schemas-section">
        <h3>{{ t('admin.copy.schemasToCopy') }}</h3>
        <div class="box">
          <table class="list">
            <thead>
              <tr>
                <th class="check-col" />
                <th>{{ t('admin.users.schema') }}</th>
                <th>{{ t('admin.copy.targetName') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in ws.visibleSchemas()" :key="s">
                <td class="check-col">
                  <input
                    type="checkbox"
                    :checked="selection.has(s)"
                    :aria-label="t('admin.copy.copySchema', { name: s })"
                    @change="toggleSchema(s, ($event.target as HTMLInputElement).checked)"
                  />
                </td>
                <td>{{ s }}</td>
                <td>
                  <div v-if="selection.has(s)" class="target-name">
                    <input
                      type="text"
                      :value="selection.get(s)"
                      :aria-label="t('admin.copy.targetNameFor', { name: s })"
                      :aria-invalid="nameProblem(s)"
                      @input="selection.set(s, ($event.target as HTMLInputElement).value)"
                    />
                    <span v-if="existing === 'stop' && exists(s)" class="warning">{{ t('admin.copy.targetExists') }}</span>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="row">
          <button :title="t('admin.export.reloadSchemas')" @click="refresh"><RefreshCw :size="12" /> {{ t('admin.refresh') }}</button>
        </div>
      </section>

      <section>
        <h3>{{ t('admin.copy.target') }}</h3>
        <div class="target">
          <label class="check"><input v-model="targetKind" type="radio" value="file" /> {{ t('admin.copy.toFile') }}</label>
          <div v-if="targetKind === 'file'" class="path">
            <input v-model="filePath" type="text" :placeholder="t('admin.filePath')" :aria-label="t('admin.copy.scriptFile')" />
            <button class="icon-btn" :title="t('admin.chooseFile')" @click="chooseFile"><FolderOpen :size="14" /></button>
          </div>
          <label class="check"><input v-model="targetKind" type="radio" value="instance" /> {{ t('admin.copy.toInstance') }}</label>
          <label class="check"><input v-model="targetKind" type="radio" value="connection" /> {{ t('admin.copy.toConnection') }}</label>
          <div v-if="targetKind === 'connection'" class="path">
            <select :value="connectionId" :aria-label="t('admin.copy.targetConnection')" @change="chooseConnection(($event.target as HTMLSelectElement).value)">
              <option value="">{{ t('admin.copy.chooseConnection') }}</option>
              <option v-for="c in connections" :key="c.id" :value="c.id">{{ c.name }}</option>
            </select>
          </div>
        </div>
      </section>

      <section>
        <h3>{{ t('admin.copy.options') }}</h3>
        <div class="row">
          <select v-model="content" :aria-label="t('admin.copy.content')">
            <option value="both">{{ t('admin.copy.structureAndData') }}</option>
            <option value="structure">{{ t('admin.copy.structureOnly') }}</option>
          </select>
          <span class="label">{{ t('admin.copy.objectsToCopy') }}</span>
          <label class="check"><input v-model="routines" type="checkbox" /> {{ t('admin.copy.routines') }}</label>
          <label class="check"><input v-model="triggers" type="checkbox" /> {{ t('admin.copy.triggers') }}</label>
          <label class="check"><input v-model="events" type="checkbox" /> {{ t('admin.copy.events') }}</label>
        </div>
        <div class="row">
          <label for="cd-definers" class="label">{{ t('admin.copy.definers') }}</label>
          <select id="cd-definers" v-model="definers" @change="definersTouched = true">
            <option value="keep">{{ t('admin.copy.keepDefiners') }}</option>
            <option value="remove">{{ t('admin.copy.removeDefiners') }}</option>
          </select>
          <label for="cd-existing" class="label">{{ t('admin.copy.existing') }}</label>
          <select id="cd-existing" v-model="existing">
            <option value="stop">{{ t('admin.copy.existingStop') }}</option>
            <option value="recreate">{{ t('admin.copy.existingRecreate') }}</option>
          </select>
        </div>
      </section>

      <section>
        <h3>{{ t('admin.copy.collations') }}</h3>
        <p v-if="previewError" class="hint error selectable">{{ previewError }}</p>
        <p v-else class="hint muted">{{ toServer ? t('admin.copy.collationsHint') : t('admin.copy.collationsFileHint') }}</p>
        <div class="box collations">
          <table class="list">
            <thead>
              <tr>
                <th>{{ t('admin.copy.collation') }}</th>
                <th>{{ t('admin.copy.charset') }}</th>
                <th>{{ t('admin.copy.replaceWith') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in preview?.used ?? []" :key="c.name" :class="{ missing: missing(c.name) }">
                <td>{{ c.name }}</td>
                <td class="muted">{{ c.charset }}</td>
                <td>
                  <select
                    v-if="!toServer || missing(c.name)"
                    v-model="collations[c.name]"
                    :aria-label="t('admin.copy.replacementFor', { name: c.name })"
                    :aria-invalid="toServer && !collations[c.name]"
                  >
                    <option value="" :disabled="toServer">{{ toServer ? t('admin.copy.chooseCollation') : t('admin.copy.unchanged') }}</option>
                    <option v-for="x in choicesFor(c.charset)" :key="x.name" :value="x.name">
                      {{ x.isDefault ? t('admin.copy.defaultCollation', { name: x.name }) : x.name }}
                    </option>
                  </select>
                  <span v-else class="muted">{{ t('admin.copy.inTarget') }}</span>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-if="!preview?.used.length" class="empty-state">{{ t('admin.copy.noCollations') }}</div>
        </div>
      </section>

      <section class="progress-section">
        <div class="row">
          <span class="status" :class="{ error: job.error }" :title="job.message">{{ job.message || t('admin.copy.pressStart') }}</span>
          <button v-if="job.running" @click="cancel">{{ t('common.cancel') }}</button>
          <button class="primary" :disabled="!canStart" @click="startCopy">{{ t('admin.copy.start') }}</button>
        </div>
        <progress :value="job.progress >= 0 ? job.progress : undefined" max="1" />
        <pre ref="logEl" class="log selectable">{{ job.log }}</pre>
      </section>
    </div>
  </div>
</template>

<style scoped>
.spacer {
  flex: 1;
}

.tool {
  font-size: var(--fs);
  font-weight: normal;
}

.error {
  color: var(--danger);
}

.warning,
tr.missing td:first-child {
  color: var(--warning);
}

.status {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.copy {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 12px 14px;
}

section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

h3 {
  margin: 0;
  font-size: var(--fs);
  font-weight: 600;
}

.schemas-section {
  flex: 1;
}

.box {
  position: relative;
  flex: 1;
  min-height: 110px;
  overflow: auto;
  border: 1px solid var(--border);
  background: var(--bg-content);
}

.box.collations {
  flex: none;
  min-height: 80px;
  max-height: 160px;
}

.box .empty-state {
  position: absolute;
  inset: 0;
  height: auto;
}

.check-col {
  width: 24px;
}

table.list td.check-col,
table.list th.check-col {
  padding-right: 0;
}

.target-name {
  display: flex;
  align-items: center;
  gap: 8px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px 14px;
  flex-wrap: wrap;
}

.row button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.label {
  color: var(--text-muted);
}

.target {
  display: grid;
  gap: 4px;
}

.path {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: 22px;
}

.path input {
  flex: 1;
}

.hint {
  margin: 0;
  font-size: var(--fs-small);
}

.progress-section {
  flex-shrink: 0;
}

progress {
  width: 100%;
  height: 8px;
  accent-color: var(--accent);
}

.log {
  height: 120px;
  margin: 0;
  padding: 6px 8px;
  overflow: auto;
  border: 1px solid var(--border);
  background: var(--bg-panel);
  font-family: var(--font-mono);
  font-size: var(--fs-small);
  white-space: pre-wrap;
}
</style>
