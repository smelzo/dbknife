<script setup lang="ts">
import { computed, ref } from 'vue'
import type { MessageKey } from '@shared/i18n'
import { t } from '@/i18n'
import type { Workspace } from '@/workspace/workspace'
import { connectionEndpoint } from '@/stores/app'

const props = defineProps<{ ws: Workspace }>()
const view = ref<'object' | 'session'>('object')

const sel = computed(() => props.ws.selection)
const columns = computed(() => {
  const s = sel.value
  if (!s?.schema || !s.name || !['table', 'view'].includes(s.kind)) return []
  return props.ws.meta.getColumns(s.schema, s.name) ?? []
})
const objects = computed(() => (sel.value?.kind === 'schema' && sel.value.schema ? props.ws.meta.objects[sel.value.schema] : undefined))

/** Selection kinds (navigator nodes) as shown in lower case, capitalized by CSS. */
const kindLabels: Record<string, MessageKey> = {
  table: 'info.kind.table',
  view: 'info.kind.view',
  procedure: 'info.kind.procedure',
  function: 'info.kind.function',
  trigger: 'info.kind.trigger',
  column: 'info.kind.column',
  index: 'info.kind.index',
  fk: 'info.kind.fk',
  tables: 'info.kind.tables',
  views: 'info.kind.views',
  procedures: 'info.kind.procedures',
  functions: 'info.kind.functions',
  columns: 'info.kind.columns',
  indexes: 'info.kind.indexes',
  fks: 'info.kind.fks',
  triggers: 'info.kind.triggers',
  sequence: 'info.kind.sequence',
  type: 'info.kind.type',
  extension: 'info.kind.extension',
  sequences: 'info.kind.sequences',
  types: 'info.kind.types',
  extensions: 'info.kind.extensions'
}
const kindLabel = (kind: string): string => (kindLabels[kind] ? t(kindLabels[kind]) : kind)
</script>

<template>
  <div class="info">
    <div class="switch">
      <button :class="{ active: view === 'object' }" @click="view = 'object'">{{ t('info.objectInfo') }}</button>
      <button :class="{ active: view === 'session' }" @click="view = 'session'">{{ t('info.session') }}</button>
    </div>
    <div v-if="view === 'object'" class="body selectable">
      <template v-if="!sel">
        <span class="muted">{{ t('info.noSelection') }}</span>
      </template>
      <template v-else-if="sel.kind === 'schema'">
        <div><b>{{ t('info.schema') }}</b> {{ sel.schema }}</div>
        <div v-if="objects" class="muted">
          {{ t('info.schemaCounts', { tables: objects.tables.length, views: objects.views.length, routines: objects.routines.length }) }}
        </div>
      </template>
      <template v-else-if="columns.length">
        <div>
          <b>{{ t(sel.kind === 'view' ? 'info.view' : 'info.table') }}</b> {{ sel.name }}
        </div>
        <div class="section">{{ t('info.columns') }}</div>
        <table class="cols">
          <tr v-for="c in columns" :key="c.name">
            <td :class="{ pk: c.key === 'PRI' }">{{ c.name }}</td>
            <td class="muted">{{ c.type }}{{ c.nullable ? '' : ' NN' }}{{ c.extra ? ' ' + c.extra : '' }}</td>
          </tr>
        </table>
      </template>
      <template v-else>
        <div>
          <b class="cap">{{ t('info.kindLabel', { kind: kindLabel(sel.kind) }) }}</b> {{ sel.name ?? sel.schema }}
        </div>
        <div v-if="sel.schema" class="muted">{{ t('info.schema') }} {{ sel.schema }}</div>
      </template>
    </div>
    <div v-else class="body selectable">
      <div class="kv"><span>{{ t('info.connection') }}</span>{{ ws.config.name }}</div>
      <div class="kv"><span>{{ t('info.host') }}</span>{{ connectionEndpoint(ws.config) }}</div>
      <div class="kv"><span>{{ t('info.server') }}</span>{{ ws.info?.version }}</div>
      <div class="kv"><span>{{ t('info.loginUser') }}</span>{{ ws.info?.user }}</div>
      <div class="kv"><span>{{ t('info.currentUser') }}</span>{{ ws.info?.currentUser }}</div>
      <div class="kv"><span>{{ t('info.connectionId') }}</span>{{ ws.info?.threadId }}</div>
      <div class="kv"><span>{{ t('info.ssl') }}</span>{{ ws.info?.ssl || t('info.sslNotInUse') }}</div>
      <div class="kv"><span>{{ t('info.defaultSchema') }}</span>{{ ws.defaultSchema || '—' }}</div>
    </div>
  </div>
</template>

<style scoped>
.info {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
}

.switch {
  display: flex;
  border-bottom: 1px solid var(--border);
}

.switch button {
  flex: 1;
  border: none;
  border-radius: 0;
  background: transparent;
  padding: 3px 0;
  color: var(--text-muted);
}

.switch button.active {
  color: var(--text);
  font-weight: 600;
  box-shadow: inset 0 -2px 0 var(--accent);
}

.body {
  flex: 1;
  overflow: auto;
  padding: 6px 10px;
  line-height: 1.5;
}

.section {
  margin-top: 4px;
  font-weight: 600;
}

.cols td {
  padding: 0 8px 0 0;
  white-space: nowrap;
}

.pk {
  font-weight: 700;
}

.cap {
  text-transform: capitalize;
}

.kv span {
  display: inline-block;
  min-width: 100px;
  color: var(--text-muted);
}
</style>
