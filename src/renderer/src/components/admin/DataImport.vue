<script lang="ts">
import { reactive } from 'vue'

/** Workspaces whose File > Run SQL Script command waits for the import page to choose a file. */
export const runScriptRequests = reactive(new Set<string>())
</script>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { FolderOpen } from 'lucide-vue-next'
import type { ImportOptions, ToolInfo } from '@shared/types'
import type { Workspace } from '@/workspace/workspace'
import { promptText } from '@/dialogs'
import { t } from '@/i18n'
import type { AdminTab } from './admin'
import { useToolJob } from './tool-job'

/**
 * Data Import/Restore: feeds a dump project folder or a SQL file to the mysql
 * client (psql); for SQL Server, sqlpackage imports a .bacpac file into a new
 * database.
 */
const props = defineProps<{ ws: Workspace; tab: AdminTab }>()

const isPostgres = props.ws.config.engine === 'postgres'
const bacpac = props.ws.features.dumpFormat === 'bacpac'
const flavorLabels: Record<ToolInfo['flavor'], string> = { mysql: 'MySQL', mariadb: 'MariaDB', postgres: 'PostgreSQL', mssql: 'SQL Server' }
/** SQL Server: the new database to create. */
const database = ref('')

const newSchema = '\u0000new'
const sourceKind = ref<'folder' | 'file'>('folder')
const folderPath = ref('')
const filePath = ref('')
const target = ref(props.ws.defaultSchema)
const tool = ref<ToolInfo>()
const toolChecked = ref(false)
const logEl = ref<HTMLElement>()

const { job, start, cancel } = useToolJob((p) => {
  props.ws.log(p.error ? 'error' : 'ok', t('workspace.admin.import'), p.error ?? p.message ?? '')
  // even a failed import may have created objects
  props.ws.refreshAfterDdl()
})

async function chooseSource(): Promise<void> {
  const folder = sourceKind.value === 'folder'
  const path = await window.api.files.chooseOpen({
    title: folder ? t('admin.selectDumpFolder') : t('admin.import.selectFile'),
    folder,
    filters: folder
      ? undefined
      : bacpac
        ? [{ name: t('admin.bacpacFiles'), extensions: ['bacpac'] }]
        : [{ name: t('main.files.sqlFiles'), extensions: ['sql'] }, { name: t('main.files.allFiles'), extensions: ['*'] }]
  })
  if (!path) return
  if (folder) folderPath.value = path
  else filePath.value = path
  // "Sales_20261026.bacpac" → Sales_20261026
  if (bacpac && !database.value.trim()) database.value = path.split('/').pop()!.replace(/\.bacpac$/i, '')
}

let previousTarget = target.value
watch(target, async (value) => {
  if (value !== newSchema) {
    previousTarget = value
    return
  }
  const name = (await promptText(t('schema.createTitle'), t('schema.name')))?.trim()
  const r = name ? await props.ws.runStatements([`CREATE SCHEMA ${props.ws.dialect.quoteIdentifier(name)}`]) : undefined
  if (name && r?.ok) {
    props.ws.refreshAfterDdl()
    await props.ws.meta.loadSchemas()
  }
  target.value = name && r?.ok ? name : previousTarget
})

const sourcePath = computed(() => (sourceKind.value === 'folder' ? folderPath.value : filePath.value).trim())
const canStart = computed(() => !job.running && !!tool.value && !!sourcePath.value && (bacpac ? !!database.value.trim() : target.value !== newSchema))

function startImport(): void {
  const options: ImportOptions = bacpac
    ? { source: { kind: 'file', path: sourcePath.value }, defaultSchema: '', database: database.value.trim() }
    : { source: { kind: sourceKind.value, path: sourcePath.value }, defaultSchema: target.value }
  void start(() => window.api.tools.importDump(props.ws.sessionId, options))
}

watch(
  () => job.log,
  () => nextTick(() => logEl.value && (logEl.value.scrollTop = logEl.value.scrollHeight))
)

// File > Run SQL Script: a self-contained file, chosen right away
watch(
  () => runScriptRequests.has(props.ws.id),
  (requested) => {
    if (!requested) return
    runScriptRequests.delete(props.ws.id)
    sourceKind.value = 'file'
    void chooseSource()
  },
  { immediate: true }
)

onMounted(async () => {
  if (bacpac) sourceKind.value = 'file'
  else void props.ws.meta.loadSchemas()
  tool.value = (await window.api.tools.find(props.ws.sessionId)).client
  toolChecked.value = true
})
</script>

<template>
  <div class="page">
    <div class="page-header">
      {{ t('workspace.admin.import') }}
      <span class="spacer" />
      <span v-if="tool" class="tool muted" :title="tool.path">{{ tool.path.split('/').pop() }} {{ tool.version }} ({{ flavorLabels[tool.flavor] }})</span>
      <span v-else-if="toolChecked && !bacpac" class="tool error">{{ isPostgres ? t('admin.toolNotFound', { tool: 'psql' }) : t('admin.import.mysqlClientNotFound') }}</span>
    </div>
    <p v-if="toolChecked && !tool && bacpac" class="missing-tool error selectable">{{ t('admin.sqlpackageNotFound') }}</p>
    <div class="page-body import">
      <section v-if="bacpac">
        <h3>{{ t('admin.import.options') }}</h3>
        <label for="di-bacpac" class="label">{{ t('admin.import.fromBacpac') }}</label>
        <div class="path flush">
          <input id="di-bacpac" v-model="filePath" type="text" :placeholder="t('admin.filePath')" :aria-label="t('admin.bacpacFile')" />
          <button class="icon-btn" :title="t('admin.chooseFile')" @click="chooseSource"><FolderOpen :size="14" /></button>
        </div>
        <div class="row">
          <label for="di-database" class="label">{{ t('admin.import.newDatabase') }}</label>
          <input id="di-database" v-model="database" type="text" />
        </div>
        <p class="hint muted flush">{{ t('admin.import.bacpacHint') }}</p>
      </section>
      <section v-else>
        <h3>{{ t('admin.import.options') }}</h3>
        <div class="source">
          <label class="check"><input v-model="sourceKind" type="radio" value="folder" /> {{ t('admin.import.fromFolder') }}</label>
          <div class="path">
            <input v-model="folderPath" type="text" :placeholder="t('admin.folderPath')" :aria-label="t('admin.dumpFolder')" :disabled="sourceKind !== 'folder'" />
            <button class="icon-btn" :title="t('admin.chooseFolder')" :disabled="sourceKind !== 'folder'" @click="chooseSource"><FolderOpen :size="14" /></button>
          </div>
          <p v-if="isPostgres" class="hint muted">
            {{ t('admin.import.folderHintPostgres') }}
          </p>
          <p v-else class="hint muted">{{ t('admin.import.folderHintMysql') }}</p>
          <label class="check"><input v-model="sourceKind" type="radio" value="file" /> {{ t('admin.import.fromFile') }}</label>
          <div class="path">
            <input v-model="filePath" type="text" :placeholder="t('admin.filePath')" :aria-label="t('admin.selfContainedFile')" :disabled="sourceKind !== 'file'" />
            <button class="icon-btn" :title="t('admin.chooseFile')" :disabled="sourceKind !== 'file'" @click="chooseSource"><FolderOpen :size="14" /></button>
          </div>
          <p class="hint muted">{{ isPostgres ? t('admin.import.fileHintPostgres') : t('admin.import.fileHintMysql') }}</p>
        </div>
        <div class="row">
          <label for="di-target" class="label">{{ t('admin.import.targetSchema') }}</label>
          <select id="di-target" v-model="target">
            <option value="">{{ t('admin.users.none') }}</option>
            <option v-for="s in ws.visibleSchemas()" :key="s" :value="s">{{ s }}</option>
            <option :value="newSchema">{{ t('admin.import.newSchema') }}</option>
          </select>
        </div>
        <p v-if="isPostgres" class="hint muted flush">
          {{ t('admin.import.targetHintPostgres') }}
        </p>
        <p v-else class="hint muted flush">
          {{ t('admin.import.targetHintMysql') }}
        </p>
      </section>

      <section class="progress-section">
        <div class="row">
          <span class="status" :class="{ error: job.error }" :title="job.message">{{ job.message || t('admin.import.pressStart') }}</span>
          <button v-if="job.running" @click="cancel">{{ t('common.cancel') }}</button>
          <button class="primary" :disabled="!canStart" @click="startImport">{{ t('admin.import.start') }}</button>
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

.import {
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

.source {
  display: grid;
  gap: 4px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px 14px;
  flex-wrap: wrap;
}

.label {
  color: var(--text-muted);
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
  margin: 0 0 6px 22px;
  font-size: var(--fs-small);
}

.hint.flush {
  margin-left: 0;
}

.path.flush {
  margin-left: 0;
}

.missing-tool {
  margin: 0;
  padding: 6px 14px;
  border-bottom: 1px solid var(--border);
}

.progress-section {
  flex: 1;
  min-height: 160px;
}

progress {
  width: 100%;
  height: 8px;
  accent-color: var(--accent);
}

.log {
  flex: 1;
  min-height: 90px;
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
