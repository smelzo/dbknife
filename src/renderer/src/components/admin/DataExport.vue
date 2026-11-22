<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { FolderOpen, RefreshCw } from 'lucide-vue-next'
import type { DumpOptions, ToolInfo } from '@shared/types'
import { valueText } from '@shared/value-text'
import type { Workspace } from '@/workspace/workspace'
import { t } from '@/i18n'
import type { AdminTab } from './admin'
import { useToolJob } from './tool-job'

/**
 * Data Export: mysqldump (pg_dump) of the checked schemas/tables to a project
 * folder or a single file; for SQL Server, sqlpackage of the whole database
 * to a .bacpac file.
 */
const props = defineProps<{ ws: Workspace; tab: AdminTab }>()

/** Checked schemas → their checked tables. */
const selection = reactive(new Map<string, Set<string>>())
const current = ref('')
const content = ref<DumpOptions['content']>('both')
const routines = ref(false)
const events = ref(false)
const triggers = ref(true)
const targetKind = ref<'folder' | 'file'>('folder')
const folderPath = ref('')
const filePath = ref('')
const singleTransaction = ref(false)
const createSchema = ref(false)
const tool = ref<ToolInfo>()
const toolChecked = ref(false)
const logEl = ref<HTMLElement>()

const isPostgres = props.ws.config.engine === 'postgres'
const bacpac = props.ws.features.dumpFormat === 'bacpac'
const flavorLabels: Record<ToolInfo['flavor'], string> = { mysql: 'MySQL', mariadb: 'MariaDB', postgres: 'PostgreSQL', mssql: 'SQL Server' }
/** SQL Server: the database of the session, exported whole. */
const database = ref('')

const { job, start, cancel } = useToolJob((p) => props.ws.log(p.error ? 'error' : 'ok', t('workspace.admin.export'), p.error ?? p.message ?? ''))

const objectsOf = (schema: string): { name: string; type: string }[] => {
  const o = props.ws.meta.objects[schema]
  return o
    ? [
        ...o.tables.map((table) => ({ name: table.name, type: t('admin.export.typeTable') })),
        ...o.views.map((v) => ({ name: v.name, type: t('admin.export.typeView') }))
      ]
    : []
}
const currentObjects = computed(() => objectsOf(current.value))
const currentSet = computed(() => selection.get(current.value))

async function show(schema: string): Promise<void> {
  current.value = schema
  await props.ws.meta.loadObjects(schema)
}

async function toggleSchema(schema: string, checked: boolean): Promise<void> {
  if (!checked) {
    selection.delete(schema)
    return
  }
  await props.ws.meta.loadObjects(schema)
  selection.set(schema, new Set(objectsOf(schema).map((o) => o.name)))
}

function toggleTable(name: string, checked: boolean): void {
  const set = new Set(selection.get(current.value))
  if (checked) set.add(name)
  else set.delete(name)
  if (set.size) selection.set(current.value, set)
  else selection.delete(current.value)
}

function selectAll(checked: boolean): void {
  if (checked) selection.set(current.value, new Set(currentObjects.value.map((o) => o.name)))
  else selection.delete(current.value)
}

const partial = (schema: string): boolean => {
  const set = selection.get(schema)
  return !!set && set.size < objectsOf(schema).length
}

async function refresh(): Promise<void> {
  await props.ws.meta.loadSchemas()
  if (current.value) await props.ws.meta.loadObjects(current.value, true)
}

const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')

async function chooseTarget(): Promise<void> {
  const path =
    targetKind.value === 'folder'
      ? await window.api.files.chooseOpen({ title: t('admin.selectDumpFolder'), folder: true })
      : await window.api.files.chooseSave({
          title: bacpac ? t('admin.export.toBacpac') : t('admin.export.toFile'),
          defaultPath: filePath.value || (bacpac ? `${database.value || 'Database'}_${today}.bacpac` : `Dump${today}.sql`),
          filters: bacpac ? [{ name: t('admin.bacpacFiles'), extensions: ['bacpac'] }] : [{ name: t('main.files.sqlFiles'), extensions: ['sql'] }]
        })
  if (!path) return
  if (targetKind.value === 'folder') folderPath.value = path
  else filePath.value = path
}

const targetPath = computed(() => (targetKind.value === 'folder' ? folderPath.value : filePath.value).trim())
const canStart = computed(() => !job.running && !!tool.value && (bacpac || selection.size > 0) && !!targetPath.value)

function startExport(): void {
  const options: DumpOptions = {
    objects: [...selection].map(([schema, set]) => ({
      schema,
      tables: set.size === objectsOf(schema).length ? [] : [...set]
    })),
    content: content.value,
    routines: routines.value,
    events: !isPostgres && events.value,
    triggers: triggers.value,
    singleTransaction: targetKind.value === 'file' && singleTransaction.value,
    createSchema: createSchema.value,
    target: { kind: targetKind.value, path: targetPath.value }
  }
  void start(() => window.api.tools.exportDump(props.ws.sessionId, options))
}

watch(
  () => job.log,
  () => nextTick(() => logEl.value && (logEl.value.scrollTop = logEl.value.scrollHeight))
)

onMounted(async () => {
  if (bacpac) {
    targetKind.value = 'file'
    database.value = valueText((await props.ws.query('SELECT DB_NAME() AS db'))[0]?.db)
    tool.value = (await window.api.tools.find(props.ws.sessionId)).dump
    toolChecked.value = true
    return
  }
  const schemas = await props.ws.meta.loadSchemas()
  const first = props.ws.defaultSchema || props.ws.visibleSchemas()[0] || schemas[0]
  if (first) void show(first)
  tool.value = (await window.api.tools.find(props.ws.sessionId)).dump
  toolChecked.value = true
})
</script>

<template>
  <div class="page">
    <div class="page-header">
      {{ t('workspace.admin.export') }}
      <span class="spacer" />
      <span v-if="tool" class="tool muted" :title="tool.path">{{ tool.path.split('/').pop() }} {{ tool.version }} ({{ flavorLabels[tool.flavor] }})</span>
      <span v-else-if="toolChecked && !bacpac" class="tool error">{{ t('admin.toolNotFound', { tool: isPostgres ? 'pg_dump' : 'mysqldump' }) }}</span>
    </div>
    <p v-if="toolChecked && !tool && bacpac" class="missing-tool error selectable">{{ t('admin.sqlpackageNotFound') }}</p>
    <div class="page-body export">
      <section v-if="bacpac">
        <h3>{{ t('admin.export.options') }}</h3>
        <p class="flush muted">{{ t('admin.export.bacpacHint', { database }) }}</p>
        <label for="de-bacpac" class="label">{{ t('admin.export.toBacpac') }}</label>
        <div class="path flush">
          <input id="de-bacpac" v-model="filePath" type="text" :placeholder="t('admin.filePath')" :aria-label="t('admin.bacpacFile')" />
          <button class="icon-btn" :title="t('admin.chooseFile')" @click="chooseTarget"><FolderOpen :size="14" /></button>
        </div>
      </section>
      <template v-else>
        <section class="tables-section">
          <h3>{{ t('admin.export.tablesToExport') }}</h3>
          <div class="lists">
            <div class="box">
              <table class="list">
                <thead>
                  <tr>
                    <th class="check-col" />
                    <th>{{ t('admin.users.schema') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="s in ws.visibleSchemas()" :key="s" :class="{ selected: s === current }" @click="show(s)">
                    <td class="check-col">
                      <input
                        type="checkbox"
                        :checked="selection.has(s)"
                        :indeterminate="partial(s)"
                        :aria-label="t('admin.export.exportSchema', { name: s })"
                        @click.stop
                        @change="toggleSchema(s, ($event.target as HTMLInputElement).checked)"
                      />
                    </td>
                    <td>{{ s }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div class="box">
              <table class="list">
                <thead>
                  <tr>
                    <th class="check-col" />
                    <th>{{ t('admin.export.schemaObjects') }}</th>
                    <th>{{ t('admin.export.type') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="o in currentObjects" :key="o.name">
                    <td class="check-col">
                      <input
                        type="checkbox"
                        :checked="!!currentSet?.has(o.name)"
                        :aria-label="t('admin.export.exportObject', { name: o.name })"
                        @change="toggleTable(o.name, ($event.target as HTMLInputElement).checked)"
                      />
                    </td>
                    <td>{{ o.name }}</td>
                    <td class="muted">{{ o.type }}</td>
                  </tr>
                </tbody>
              </table>
              <div v-if="current && !currentObjects.length" class="empty-state">{{ t('admin.export.noTables') }}</div>
            </div>
          </div>
          <div class="row">
            <button :title="t('admin.export.reloadSchemas')" @click="refresh"><RefreshCw :size="12" /> {{ t('admin.refresh') }}</button>
            <span class="spacer" />
            <select v-model="content" :aria-label="t('admin.export.dumpContent')">
              <option value="both">{{ t('admin.export.structureAndData') }}</option>
              <option value="data">{{ t('admin.export.dataOnly') }}</option>
              <option value="structure">{{ t('admin.export.structureOnly') }}</option>
            </select>
            <button :disabled="!currentObjects.length" @click="selectAll(true)">{{ t('menu.edit.selectAll') }}</button>
            <button :disabled="!currentObjects.length" @click="selectAll(false)">{{ t('admin.users.unselectAll') }}</button>
          </div>
          <div class="row">
            <span class="label">{{ t('admin.export.objectsToExport') }}</span>
            <template v-if="isPostgres">
              <label class="check"><input v-model="routines" type="checkbox" /> {{ t('admin.export.dumpSchemaObjects') }}</label>
            </template>
            <template v-else>
              <label class="check"><input v-model="routines" type="checkbox" /> {{ t('admin.export.dumpRoutines') }}</label>
              <label class="check"><input v-model="events" type="checkbox" /> {{ t('admin.export.dumpEvents') }}</label>
              <label class="check"><input v-model="triggers" type="checkbox" /> {{ t('admin.export.dumpTriggers') }}</label>
            </template>
          </div>
        </section>

        <section>
          <h3>{{ t('admin.export.options') }}</h3>
          <div class="target">
            <label class="check"><input v-model="targetKind" type="radio" value="folder" /> {{ t('admin.export.toFolder') }}</label>
            <div class="path">
              <input v-model="folderPath" type="text" :placeholder="t('admin.folderPath')" :aria-label="t('admin.dumpFolder')" :disabled="targetKind !== 'folder'" />
              <button class="icon-btn" :title="t('admin.chooseFolder')" :disabled="targetKind !== 'folder'" @click="chooseTarget"><FolderOpen :size="14" /></button>
            </div>
            <p class="hint muted">
              {{ t('admin.export.toFolderHint') }}
              <template v-if="isPostgres">{{ t('admin.export.postDataHint') }}</template>
            </p>
            <label class="check"><input v-model="targetKind" type="radio" value="file" /> {{ t('admin.export.toFile') }}</label>
            <div class="path">
              <input v-model="filePath" type="text" :placeholder="t('admin.filePath')" :aria-label="t('admin.selfContainedFile')" :disabled="targetKind !== 'file'" />
              <button class="icon-btn" :title="t('admin.chooseFile')" :disabled="targetKind !== 'file'" @click="chooseTarget"><FolderOpen :size="14" /></button>
            </div>
            <p class="hint muted">{{ t('admin.export.toFileHint') }}</p>
          </div>
          <div class="row">
            <label v-if="!isPostgres" class="check">
              <input v-model="singleTransaction" type="checkbox" :disabled="targetKind !== 'file'" />
              {{ t('admin.export.singleTransaction') }}
            </label>
            <label class="check"><input v-model="createSchema" type="checkbox" /> {{ t('admin.export.createSchema') }}</label>
          </div>
          <p v-if="isPostgres" class="hint muted">{{ t('admin.export.noOwnersHint') }}</p>
        </section>
      </template>

      <section class="progress-section">
        <div class="row">
          <span class="status" :class="{ error: job.error }" :title="job.message">{{ job.message || t('admin.export.pressStart') }}</span>
          <button v-if="job.running" @click="cancel">{{ t('common.cancel') }}</button>
          <button class="primary" :disabled="!canStart" @click="startExport">{{ t('admin.export.start') }}</button>
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

.status {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.export {
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

.tables-section {
  flex: 1;
}

.lists {
  flex: 1;
  display: grid;
  grid-template-columns: minmax(180px, 1fr) 2fr;
  gap: 8px;
  min-height: 110px;
}

.box {
  position: relative;
  overflow: auto;
  border: 1px solid var(--border);
  background: var(--bg-content);
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

.flush {
  margin: 0;
}

.missing-tool {
  margin: 0;
  padding: 6px 14px;
  border-bottom: 1px solid var(--border);
}

.hint {
  margin: 0 0 6px 22px;
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
