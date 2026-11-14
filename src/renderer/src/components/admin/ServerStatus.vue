<script setup lang="ts">
import { onMounted } from 'vue'
import { RefreshCw } from 'lucide-vue-next'
import type { Workspace } from '@/workspace/workspace'
import { t } from '@/i18n'
import StatusChart from './StatusChart.vue'
import { usePolling, type AdminTab } from './admin'
import { POINTS } from './status/common'
import { useMysqlStatus } from './status/mysql'
import { usePostgresStatus } from './status/postgres'
import { useMssqlStatus } from './status/mssql'

const props = defineProps<{ ws: Workspace; tab: AdminTab }>()

const sources = { mysql: useMysqlStatus, postgres: usePostgresStatus, mssql: useMssqlStatus }
const { error, serverRows, features, sections, charts, loadInfo, sample } = sources[props.ws.config.engine as keyof typeof sources](props.ws)

onMounted(loadInfo)
usePolling(props.ws, props.tab, () => 1000, sample)
</script>

<template>
  <div class="page">
    <div class="page-header">
      {{ t('workspace.admin.status') }}
      <span class="spacer" />
      <button class="icon-btn" :title="t('admin.status.refreshInfo')" @click="loadInfo"><RefreshCw :size="14" /></button>
    </div>
    <div v-if="error" class="error selectable">{{ error }}</div>
    <div class="page-body status-body">
      <div class="info">
        <table class="kv">
          <tbody>
            <tr v-for="[label, value] in serverRows" :key="label">
              <th>{{ label }}</th>
              <td class="selectable">{{ value }}</td>
            </tr>
          </tbody>
        </table>

        <h3>{{ t('admin.status.features') }}</h3>
        <table class="kv">
          <tbody>
            <tr v-for="f in features" :key="f.label">
              <th>{{ f.label }}</th>
              <td>
                <span class="dot" :class="{ on: f.on }" />{{ f.on ? t('admin.status.on') : t('admin.status.off') }}
                <span v-if="f.detail" class="muted"> — {{ f.detail }}</span>
              </td>
            </tr>
          </tbody>
        </table>

        <template v-for="s in sections" :key="s.title">
          <h3>{{ s.title }}</h3>
          <table class="kv">
            <tbody>
              <tr v-for="[label, value] in s.rows" :key="label">
                <th>{{ label }}</th>
                <td class="selectable">{{ value }}</td>
              </tr>
            </tbody>
          </table>
        </template>
      </div>
      <div class="charts">
        <StatusChart
          v-for="c in charts"
          :key="c.title"
          :title="c.title"
          :series="c.series"
          :points="POINTS"
          :max="c.max"
          :format="c.format"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.page-header .spacer {
  flex: 1;
}

.error {
  padding: 6px 14px;
  color: var(--danger);
  border-bottom: 1px solid var(--border);
}

.status-body {
  display: grid;
  grid-template-columns: minmax(300px, 420px) 1fr;
  align-items: start;
}

.info {
  padding: 10px 14px 16px;
  border-right: 1px solid var(--border);
  min-height: 100%;
}

h3 {
  margin: 16px 0 6px;
  font-size: var(--fs);
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

table.kv {
  border-collapse: collapse;
  width: 100%;
  table-layout: fixed;
}

table.kv th,
table.kv td {
  padding: 2px 0;
  text-align: left;
  vertical-align: top;
}

table.kv th {
  width: 140px;
  padding-right: 10px;
  font-weight: normal;
  color: var(--text-muted);
}

table.kv td {
  overflow-wrap: anywhere;
}

.dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 6px;
  border-radius: 50%;
  background: var(--text-faint);
}

.dot.on {
  background: var(--success);
}

.charts {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 10px;
  padding: 12px 14px;
}
</style>
