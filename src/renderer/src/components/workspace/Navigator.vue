<script setup lang="ts">
import { computed, ref } from 'vue'
import { Pane, Splitpanes } from 'splitpanes'
import { Activity, CalendarClock, Copy, DatabaseBackup, Download, RefreshCw, Settings2, Upload, Users, Variable, Cable } from 'lucide-vue-next'
import type { MessageKey } from '@shared/i18n'
import { t } from '@/i18n'
import type { AdminPage, Workspace } from '@/workspace/workspace'
import InfoPanel from './InfoPanel.vue'
import SchemaTree from './SchemaTree.vue'

const props = defineProps<{ ws: Workspace }>()

const view = ref<'schemas' | 'admin'>('schemas')
const filter = ref('')
const tree = ref<InstanceType<typeof SchemaTree>>()

const allAdminItems: { page: AdminPage; label: MessageKey; icon: unknown }[] = [
  { page: 'status', label: 'workspace.admin.status', icon: Activity },
  { page: 'connections', label: 'workspace.admin.connections', icon: Cable },
  { page: 'users', label: 'workspace.admin.users', icon: Users },
  { page: 'variables', label: 'workspace.admin.variables', icon: Variable },
  { page: 'agent', label: 'workspace.admin.agent', icon: CalendarClock },
  { page: 'export', label: 'workspace.admin.export', icon: Download },
  { page: 'import', label: 'navigator.importRestore', icon: Upload },
  { page: 'backup', label: 'workspace.admin.backup', icon: DatabaseBackup },
  { page: 'copy', label: 'workspace.admin.copy', icon: Copy }
]

const adminItems = computed(() => allAdminItems.filter((i) => props.ws.features.adminPages.includes(i.page)))

const activeAdmin = computed(() => {
  const tab = props.ws.activeEditorTab
  return tab?.kind === 'admin' ? tab.page : null
})
</script>

<template>
  <div class="navigator">
    <div class="head">
      <span class="title">{{ t('navigator.title') }}</span>
    </div>
    <div v-if="adminItems.length" class="switch">
      <button :class="{ active: view === 'admin' }" @click="view = 'admin'">{{ t('navigator.administration') }}</button>
      <button :class="{ active: view === 'schemas' }" @click="view = 'schemas'">{{ t('navigator.schemas') }}</button>
    </div>
    <Splitpanes horizontal class="split">
      <Pane :size="72" :min-size="20">
        <div v-if="view === 'schemas' || !adminItems.length" class="schemas">
          <div class="filter-row">
            <input v-model="filter" type="search" :placeholder="t('navigator.filter')" />
            <button class="icon-btn" :title="t('navigator.refreshAll')" @click="tree?.refresh()"><RefreshCw :size="13" /></button>
          </div>
          <SchemaTree ref="tree" class="tree" :ws="ws" :filter="filter" @filter="(f) => (filter = f)" />
        </div>
        <div v-else class="admin">
          <div class="section">{{ t('navigator.management') }}</div>
          <div
            v-for="item in adminItems"
            :key="item.page"
            class="admin-item"
            :class="{ selected: activeAdmin === item.page }"
            @click="ws.openAdmin(item.page)"
          >
            <component :is="item.icon" :size="14" class="icon" />
            <span>{{ t(item.label) }}</span>
          </div>
          <div class="section">{{ t('navigator.preferences') }}</div>
          <div class="admin-item muted"><Settings2 :size="14" class="icon" /> <span>{{ t('navigator.seePreferences') }}</span></div>
        </div>
      </Pane>
      <Pane :size="28" :min-size="10">
        <InfoPanel :ws="ws" />
      </Pane>
    </Splitpanes>
  </div>
</template>

<style scoped>
.navigator {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
}

.head {
  padding: 6px 10px 2px;
}

.title {
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  font-size: var(--fs-small);
  letter-spacing: 0.04em;
}

.switch {
  display: flex;
  margin: 4px 8px 6px;
  border: 1px solid var(--border-strong);
  border-radius: 5px;
  overflow: hidden;
}

.switch button {
  flex: 1;
  border: none;
  border-radius: 0;
  background: transparent;
  padding: 2px 0;
}

.switch button.active {
  background: var(--bg-selected);
  font-weight: 600;
}

.split {
  flex: 1;
  min-height: 0;
}

.schemas {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.filter-row {
  display: flex;
  gap: 2px;
  padding: 0 6px 4px;
}

.filter-row input {
  flex: 1;
  min-width: 0;
}

.tree {
  flex: 1;
  min-height: 0;
}

.admin {
  height: 100%;
  overflow: auto;
}

.section {
  padding: 8px 10px 3px;
  font-size: var(--fs-small);
  color: var(--text-muted);
  font-weight: 600;
}

.admin-item {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 3px 14px;
}

.admin-item:hover {
  background: var(--bg-hover);
}

.admin-item.selected {
  background: var(--bg-selected);
}

.icon {
  color: var(--accent);
}
</style>
