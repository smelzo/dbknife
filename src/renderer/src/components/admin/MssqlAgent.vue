<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { agentDateTime } from '@shared/sql/mssql-backup'
import type { MessageKey } from '@shared/i18n'
import type { Row } from '@shared/types'
import type { Workspace } from '@/workspace/workspace'
import { t } from '@/i18n'
import type { AdminTab } from './admin'

/** SQL Server Agent: its service and jobs, read only. */
const props = defineProps<{ ws: Workspace; tab: AdminTab }>()

const jobsSql = `SELECT j.job_id, j.name, j.enabled, c.name AS category,
       h.run_date, h.run_time, h.run_status,
       s.next_run_date, s.next_run_time
FROM msdb.dbo.sysjobs j
LEFT JOIN msdb.dbo.syscategories c ON c.category_id = j.category_id
OUTER APPLY (SELECT TOP (1) run_date, run_time, run_status FROM msdb.dbo.sysjobhistory
             WHERE job_id = j.job_id AND step_id = 0 ORDER BY instance_id DESC) h
OUTER APPLY (SELECT TOP (1) next_run_date, next_run_time FROM msdb.dbo.sysjobschedules
             WHERE job_id = j.job_id AND next_run_date > 0 ORDER BY next_run_date, next_run_time) s
ORDER BY j.name`

const stepsSql = 'SELECT step_id, step_name, subsystem, last_run_outcome FROM msdb.dbo.sysjobsteps WHERE job_id = @p1 ORDER BY step_id'

/** run_status of sysjobhistory and last_run_outcome of sysjobsteps (5: never ran). */
const outcomes: Record<number, MessageKey> = {
  0: 'admin.mssqlAgent.outcome.failed',
  1: 'admin.mssqlAgent.outcome.succeeded',
  2: 'admin.mssqlAgent.outcome.retry',
  3: 'admin.mssqlAgent.outcome.canceled',
  4: 'admin.mssqlAgent.outcome.inProgress',
  5: 'admin.mssqlAgent.outcome.unknown'
}
const outcome = (v: unknown): string => (v === null || v === undefined ? '' : outcomes[Number(v)] ? t(outcomes[Number(v)]) : String(v))

/** The service and the jobs were read (the edition was not Express). */
const loaded = ref(false)
const express = ref(false)
const service = ref('')
const jobs = ref<Row[]>([])
const error = ref('')
const selected = ref<Row | null>(null)
const steps = ref<Row[]>([])
const stepsError = ref('')
const loading = ref(false)
let stepsRun = 0

async function select(job: Row): Promise<void> {
  selected.value = job
  const n = ++stepsRun
  const r = await window.api.db.query(props.ws.sessionId, stepsSql, [job.job_id])
  if (n !== stepsRun) return
  steps.value = r.rows
  stepsError.value = r.error?.message ?? ''
}

async function load(): Promise<void> {
  loading.value = true
  try {
    await read()
  } finally {
    loading.value = false
  }
}

async function read(): Promise<void> {
  const edition = await window.api.db.query(props.ws.sessionId, "SELECT CAST(SERVERPROPERTY('EngineEdition') AS int) AS edition")
  if (edition.error) {
    error.value = edition.error.message
    return
  }
  if (Number(edition.rows[0]?.edition) === 4) {
    express.value = true
    return
  }
  // reading the service needs VIEW SERVER STATE: without it the state is unknown
  const s = await window.api.db.query(props.ws.sessionId, "SELECT status_desc FROM sys.dm_server_services WHERE servicename LIKE 'SQL Server Agent%'")
  service.value = s.error || !s.rows.length ? t('admin.mssqlAgent.serviceUnknown') : String(s.rows[0].status_desc)
  const r = await window.api.db.query(props.ws.sessionId, jobsSql)
  jobs.value = r.rows
  error.value = r.error?.message ?? ''
  loaded.value = true
}

/** Reads the jobs again and keeps the selected job, if it still exists. */
async function refresh(): Promise<void> {
  await load()
  const job = jobs.value.find((j) => j.job_id === selected.value?.job_id)
  if (job) return select(job)
  stepsRun++
  selected.value = null
  steps.value = []
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="page-header">
      {{ t('workspace.admin.agent') }}
      <span class="spacer" />
      <button v-if="!express" :disabled="loading" @click="refresh">{{ t('admin.refresh') }}</button>
    </div>
    <div class="page-body agent">
      <p v-if="express" class="express">{{ t('admin.mssqlAgent.express') }}</p>
      <template v-else-if="loaded">
        <p v-if="service" class="service">{{ t('admin.mssqlAgent.service', { status: service }) }}</p>
        <p v-if="error" class="error selectable">{{ error }}</p>
        <section class="jobs">
          <h3>{{ t('admin.mssqlAgent.jobs') }}</h3>
          <div class="box">
            <table class="list">
              <thead>
                <tr>
                  <th>{{ t('admin.mssqlAgent.name') }}</th>
                  <th>{{ t('admin.mssqlAgent.enabled') }}</th>
                  <th>{{ t('admin.mssqlAgent.category') }}</th>
                  <th>{{ t('admin.mssqlAgent.lastRun') }}</th>
                  <th>{{ t('admin.mssqlAgent.lastOutcome') }}</th>
                  <th>{{ t('admin.mssqlAgent.nextRun') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="j in jobs" :key="String(j.job_id)" :class="{ selected: selected?.job_id === j.job_id }" @mousedown="select(j)">
                  <td>{{ j.name }}</td>
                  <td>{{ j.enabled ? t('admin.status.yes') : t('admin.status.no') }}</td>
                  <td>{{ j.category ?? '' }}</td>
                  <td>{{ agentDateTime(Number(j.run_date ?? 0), Number(j.run_time ?? 0)) }}</td>
                  <td>{{ outcome(j.run_status) }}</td>
                  <td>{{ agentDateTime(Number(j.next_run_date ?? 0), Number(j.next_run_time ?? 0)) }}</td>
                </tr>
                <tr v-if="!jobs.length && !error">
                  <td colspan="6" class="muted">{{ t('admin.mssqlAgent.noJobs') }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
        <section v-if="selected" class="steps">
          <h3>{{ t('admin.mssqlAgent.steps', { job: String(selected.name) }) }}</h3>
          <p v-if="stepsError" class="error selectable">{{ stepsError }}</p>
          <div class="box">
            <table class="list">
              <thead>
                <tr>
                  <th>{{ t('admin.mssqlAgent.stepId') }}</th>
                  <th>{{ t('admin.mssqlAgent.stepName') }}</th>
                  <th>{{ t('admin.mssqlAgent.subsystem') }}</th>
                  <th>{{ t('admin.mssqlAgent.lastOutcome') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="s in steps" :key="String(s.step_id)">
                  <td>{{ s.step_id }}</td>
                  <td>{{ s.step_name }}</td>
                  <td>{{ s.subsystem }}</td>
                  <td>{{ outcome(s.last_run_outcome) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </template>
      <p v-else-if="error" class="error selectable">{{ error }}</p>
    </div>
  </div>
</template>

<style scoped>
.page-header .spacer {
  flex: 1;
}

.page-header button {
  font-size: var(--fs);
  font-weight: normal;
}

.agent {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 14px;
}

p {
  margin: 0;
}

.error {
  color: var(--danger);
}

section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
}

h3 {
  margin: 0;
  font-size: var(--fs);
  font-weight: 600;
}

.jobs {
  flex: 1;
}

.steps {
  flex: 0 1 35%;
}

.box {
  flex: 1;
  min-height: 80px;
  overflow: auto;
  border: 1px solid var(--border);
  background: var(--bg-content);
}
</style>
