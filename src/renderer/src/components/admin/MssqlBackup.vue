<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { fileListStatement, physicalPath, serverPath } from '@shared/sql/mssql-backup'
import type { MessageKey } from '@shared/i18n'
import { valueText } from '@shared/value-text'
import type { Workspace } from '@/workspace/workspace'
import { confirm } from '@/dialogs'
import { t } from '@/i18n'
import type { AdminTab } from './admin'
import { useToolJob } from './tool-job'

/**
 * SQL Server Backup / Restore of .bak files. The server reads and writes the
 * files on its own disk, so paths are typed, not chosen with a file dialog.
 */
const props = defineProps<{ ws: Workspace; tab: AdminTab }>()

/** The server's default folders (SQL Server 2019+; empty when unknown). */
const dirs = reactive({ backup: '', data: '', log: '' })
const dirsError = ref('')
const database = computed(() => props.ws.info?.database ?? '')
const backupPath = ref('')
/** The user typed the backup path: it no longer follows the database and the time. */
const pathEdited = ref(false)

interface BackupFile {
  logical: string
  /** D data, L log, S FILESTREAM, F full-text. */
  type: string
  /** Where the file was when the backup was made. */
  physical: string
  /** Destination typed by the user, instead of the computed one. */
  destination?: string
}

const restorePath = ref('')
const files = ref<BackupFile[]>([])
const filesError = ref('')
const reading = ref(false)
const restoreAs = ref('')
const replace = ref(false)
const logEl = ref<HTMLElement>()
/** The running job is a restore: an interrupted RESTORE leaves the database RESTORING, so it has no Cancel. */
const restoring = ref(false)
/** Counts the Read Files requests: a list read for a path changed meanwhile is dropped. */
let filesRun = 0

const typeLabels: Record<string, MessageKey> = { D: 'admin.mssqlBackup.fileType.data', L: 'admin.mssqlBackup.fileType.log' }

const { job, start, cancel } = useToolJob((p) => {
  props.ws.log(p.error ? 'error' : 'ok', t('workspace.admin.backup'), p.error ?? p.message ?? '')
  if (p.error) return
  if (restoring.value) props.ws.refreshAfterDdl()
  // a new name for the next backup: WITH INIT would overwrite this one
  else suggestBackupPath()
})

const pad = (n: number): string => String(n).padStart(2, '0')
/** yyyyMMdd_HHmm of the local time. */
const stamp = (d: Date): string => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`

/** `<backup folder>/<database>_<yyyyMMdd_HHmm>.bak`, unless the user typed a path. */
function suggestBackupPath(): void {
  if (pathEdited.value) return
  backupPath.value = dirs.backup && database.value ? serverPath(dirs.backup, `${database.value}_${stamp(new Date())}.bak`) : ''
}

function editBackupPath(value: string): void {
  backupPath.value = value
  pathEdited.value = !!value.trim()
}

/** Files go to the server's default folders under the new name: logs to the log folder, the others to the data folder. */
function defaultDestination(f: BackupFile): string {
  const dir = f.type === 'L' ? dirs.log : dirs.data
  const name = restoreAs.value.trim()
  return dir && name ? physicalPath(dir, name, f.logical, f.type) : ''
}

/** A destination emptied by the user goes back to the computed one. */
const destination = (f: BackupFile): string => f.destination || defaultDestination(f)

const canBackUp = computed(() => !job.running && !!database.value && !!backupPath.value.trim())
const canRestore = computed(
  () => !job.running && !!restorePath.value.trim() && !!restoreAs.value.trim() && files.value.length > 0 && files.value.every((f) => destination(f).trim())
)

// a list read from another file would move the wrong files
watch(restorePath, () => {
  filesRun++
  reading.value = false
  files.value = []
  filesError.value = ''
})

watch(database, suggestBackupPath)

async function readFiles(): Promise<void> {
  const n = ++filesRun
  reading.value = true
  filesError.value = ''
  const r = await window.api.db.query(props.ws.sessionId, fileListStatement(restorePath.value.trim()))
  if (n !== filesRun) return
  reading.value = false
  files.value = r.error ? [] : r.rows.map((row) => ({ logical: String(row.LogicalName), type: String(row.Type).trim(), physical: String(row.PhysicalName) }))
  filesError.value = r.error?.message ?? ''
}

function backUp(): void {
  restoring.value = false
  void start(() => window.api.tools.mssqlBackup(props.ws.sessionId, { database: database.value, path: backupPath.value.trim() }))
}

async function restore(): Promise<void> {
  const name = restoreAs.value.trim()
  if (replace.value && !(await confirm(t('admin.mssqlBackup.replaceConfirm', { database: name }), undefined, t('admin.mssqlBackup.restore')))) return
  restoring.value = true
  const moves = files.value.map((f) => ({ logical: f.logical, physical: destination(f).trim() }))
  void start(() => window.api.tools.mssqlRestore(props.ws.sessionId, { path: restorePath.value.trim(), database: name, replace: replace.value, moves }))
}

watch(
  () => job.log,
  () => nextTick(() => logEl.value && (logEl.value.scrollTop = logEl.value.scrollHeight))
)

onMounted(async () => {
  // aliases avoid BACKUP, a reserved word
  const r = await window.api.db.query(
    props.ws.sessionId,
    `SELECT CAST(SERVERPROPERTY('InstanceDefaultBackupPath') AS nvarchar(4000)) AS backup_dir,
            CAST(SERVERPROPERTY('InstanceDefaultDataPath') AS nvarchar(4000)) AS data_dir,
            CAST(SERVERPROPERTY('InstanceDefaultLogPath') AS nvarchar(4000)) AS log_dir`
  )
  if (r.error) {
    dirsError.value = r.error.message
    return
  }
  const row = r.rows[0] ?? {}
  Object.assign(dirs, { backup: valueText(row.backup_dir), data: valueText(row.data_dir), log: valueText(row.log_dir) })
  suggestBackupPath()
})
</script>

<template>
  <div class="page">
    <div class="page-header">{{ t('workspace.admin.backup') }}</div>
    <p class="note muted">{{ t('admin.mssqlBackup.serverPathNote') }}</p>
    <p v-if="dirsError" class="note error selectable">{{ dirsError }}</p>
    <div class="page-body backup">
      <section>
        <h3>{{ t('admin.mssqlBackup.backupTitle') }}</h3>
        <div class="form-grid">
          <label for="mb-database">{{ t('admin.mssqlBackup.database') }}</label>
          <input id="mb-database" :value="database" type="text" readonly />
          <label for="mb-backup-path">{{ t('admin.mssqlBackup.file') }}</label>
          <input
            id="mb-backup-path"
            :value="backupPath"
            type="text"
            :placeholder="t('admin.filePath')"
            @input="editBackupPath(($event.target as HTMLInputElement).value)"
          />
        </div>
        <div class="row">
          <button class="primary" :disabled="!canBackUp" @click="backUp">{{ t('admin.mssqlBackup.backUp') }}</button>
        </div>
      </section>

      <section>
        <h3>{{ t('admin.mssqlBackup.restoreTitle') }}</h3>
        <div class="form-grid">
          <label for="mb-restore-path">{{ t('admin.mssqlBackup.file') }}</label>
          <div class="path">
            <input id="mb-restore-path" v-model="restorePath" type="text" :placeholder="t('admin.filePath')" />
            <button :disabled="!restorePath.trim() || reading" @click="readFiles">{{ t('admin.mssqlBackup.readFiles') }}</button>
          </div>
          <label for="mb-restore-as">{{ t('admin.mssqlBackup.restoreAs') }}</label>
          <input id="mb-restore-as" v-model="restoreAs" type="text" />
        </div>
        <p v-if="filesError" class="error selectable flush">{{ filesError }}</p>
        <div v-if="files.length" class="box">
          <table class="list files">
            <thead>
              <tr>
                <th>{{ t('admin.mssqlBackup.logicalName') }}</th>
                <th>{{ t('admin.mssqlBackup.type') }}</th>
                <th class="wide">{{ t('admin.mssqlBackup.destination') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="f in files" :key="f.logical">
                <td :title="f.physical">{{ f.logical }}</td>
                <td>{{ typeLabels[f.type] ? t(typeLabels[f.type]) : f.type }}</td>
                <td class="wide">
                  <input
                    type="text"
                    :value="destination(f)"
                    :aria-label="t('admin.mssqlBackup.destinationFor', { name: f.logical })"
                    @input="f.destination = ($event.target as HTMLInputElement).value"
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <label class="check"><input id="mb-replace" v-model="replace" type="checkbox" /> {{ t('admin.mssqlBackup.replace') }}</label>
        <div class="row">
          <button class="primary" :disabled="!canRestore" @click="restore">{{ t('admin.mssqlBackup.restore') }}</button>
        </div>
      </section>

      <section class="progress-section">
        <div class="row">
          <span class="status" :class="{ error: job.error }" :title="job.message">{{ job.message }}</span>
          <button v-if="job.running && !restoring" @click="cancel">{{ t('common.cancel') }}</button>
        </div>
        <progress :value="job.progress >= 0 ? job.progress : undefined" max="1" />
        <pre ref="logEl" class="log selectable">{{ job.log }}</pre>
      </section>
    </div>
  </div>
</template>

<style scoped>
.error {
  color: var(--danger);
}

.note {
  margin: 0;
  padding: 6px 14px;
  border-bottom: 1px solid var(--border);
}

.status {
  flex: 1;
  min-width: 0;
  min-height: 1.4em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.backup {
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

.form-grid {
  max-width: 720px;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px 14px;
  flex-wrap: wrap;
}

.path {
  display: flex;
  align-items: center;
  gap: 4px;
}

.path input {
  flex: 1;
}

.flush {
  margin: 0;
}

.box {
  max-height: 200px;
  overflow: auto;
  border: 1px solid var(--border);
}

.files td.wide {
  width: 100%;
}

.files td.wide input {
  width: 100%;
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
