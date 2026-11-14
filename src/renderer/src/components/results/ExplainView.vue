<script setup lang="ts">
import { ref, watch } from 'vue'
import type { ExecResult, ResultSet } from '@shared/types'
import { statementKind } from '@shared/sql/analyze'
import { t } from '@/i18n'
import type { ResultTab } from '@/workspace/results'
import type { Workspace } from '@/workspace/workspace'
import MysqlPlan from './plans/MysqlPlan.vue'
import SqlitePlan from './plans/SqlitePlan.vue'
import PostgresPlan from './plans/PostgresPlan.vue'
import MssqlPlan from './plans/MssqlPlan.vue'

/** Execution plan of a result's statement, drawn by the engine's plan view. */
const props = defineProps<{ ws: Workspace; rt: ResultTab }>()

const plan = ref<ResultSet | null>(null)
const error = ref('')
const loading = ref(false)

async function load(): Promise<void> {
  error.value = ''
  plan.value = null
  const dialect = props.ws.dialect
  const prefix = dialect.explainPrefix?.trim().toUpperCase()
  // a result of Explain, or of an EXPLAIN statement run as a query
  if (props.rt.plan || (prefix && props.rt.sql.trim().toUpperCase().startsWith(prefix))) {
    plan.value = { columns: props.rt.columns, rows: props.rt.rows }
    return
  }
  if (!['SELECT', 'WITH', 'UPDATE', 'DELETE', 'INSERT', 'REPLACE'].includes(statementKind(props.rt.sql, dialect.rules))) {
    error.value = t('plan.unsupported')
    return
  }
  if (props.ws.busy) {
    error.value = t('plan.busy')
    return
  }
  loading.value = true
  // the plan takes the user connection: no editor statement or Apply until it is back
  props.ws.busy = true
  let r: ExecResult
  try {
    // the user connection has the editor's default schema, so unqualified names resolve
    r = await window.api.db.explain(props.ws.sessionId, props.rt.sql)
  } finally {
    props.ws.busy = false
    loading.value = false
  }
  if (r.error) error.value = r.error.message
  else plan.value = r.resultSets[0] ?? null
}

watch(() => props.rt.id, load, { immediate: true })
</script>

<template>
  <div class="plan">
    <div v-if="loading" class="empty-state">{{ t('plan.loading') }}</div>
    <div v-else-if="error" class="empty-state selectable">{{ error }}</div>
    <template v-else-if="plan">
      <MysqlPlan v-if="ws.dialect.engine === 'mysql'" :plan="plan" />
      <SqlitePlan v-else-if="ws.dialect.engine === 'sqlite'" :plan="plan" />
      <PostgresPlan v-else-if="ws.dialect.engine === 'postgres'" :plan="plan" />
      <MssqlPlan v-else-if="ws.dialect.engine === 'mssql'" :plan="plan" />
    </template>
  </div>
</template>

<style scoped>
.plan {
  height: 100%;
  overflow: auto;
  background: var(--bg-content);
  padding: 16px;
}
</style>
