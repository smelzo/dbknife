<script setup lang="ts">
import type { Component } from 'vue'
import { Pane, Splitpanes } from 'splitpanes'
import {
  Database,
  DatabaseZap,
  FilePlus2,
  FolderOpen,
  FunctionSquare,
  Info,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Plug,
  Table2,
  Eye,
  Workflow,
  X,
  Circle,
  TextSearch
} from 'lucide-vue-next'
import type { Engine } from '@shared/types'
import { t } from '@/i18n'
import { shortcut } from '@/shortcut'
import { moveTabFocus } from '@/tablist'
import type { Workspace } from '@/workspace/workspace'
import { newDatabase, schemaDialog } from '@/workspace/object-actions'
import { useApp } from '@/stores/app'
import QueryEditor from '../editor/QueryEditor.vue'
import RoutineEditor from '../editors/RoutineEditor.vue'
import SearchData from '../editors/SearchData.vue'
import TableEditor from '../editors/TableEditor.vue'
import InspectorPage from '../editors/InspectorPage.vue'
import ServerStatus from '../admin/ServerStatus.vue'
import ClientConnections from '../admin/ClientConnections.vue'
import UsersPrivileges from '../admin/UsersPrivileges.vue'
import PostgresRoles from '../admin/PostgresRoles.vue'
import MssqlLogins from '../admin/MssqlLogins.vue'
import StatusVariables from '../admin/StatusVariables.vue'
import DataExport from '../admin/DataExport.vue'
import DataImport from '../admin/DataImport.vue'
import CopyDatabase from '../admin/CopyDatabase.vue'
import MssqlBackup from '../admin/MssqlBackup.vue'
import MssqlAgent from '../admin/MssqlAgent.vue'
import Navigator from './Navigator.vue'
import OutputPanel from './OutputPanel.vue'
import SnippetsPanel from './SnippetsPanel.vue'
import { sendToEditor } from '@/workspace/object-actions'

const props = defineProps<{ ws: Workspace }>()
const app = useApp()

// SQLite has no administration pages
const usersPages: Partial<Record<Engine, Component>> = { mysql: UsersPrivileges, postgres: PostgresRoles, mssql: MssqlLogins }

const adminComponents = {
  status: ServerStatus,
  connections: ClientConnections,
  users: usersPages[props.ws.config.engine],
  variables: StatusVariables,
  agent: MssqlAgent,
  export: DataExport,
  import: DataImport,
  backup: MssqlBackup,
  copy: CopyDatabase
}

const schemaForNew = (): string => props.ws.defaultSchema || props.ws.visibleSchemas()[0] || ''

function requireSchema(): string | undefined {
  const s = schemaForNew()
  if (!s) void window.api.ui.message({ type: 'info', message: t('workspace.selectSchemaFirst') })
  return s || undefined
}

function create(kind: 'table' | 'VIEW' | 'PROCEDURE' | 'FUNCTION'): void {
  const s = requireSchema()
  if (!s) return
  if (kind === 'table') props.ws.openTableEditor(s, null)
  else props.ws.openRoutineEditor(s, kind, null)
}

async function onTabContext(id: string): Promise<void> {
  const choice = await window.api.ui.contextMenu([
    { id: 'close', label: t('workspace.tabMenu.close') },
    { id: 'others', label: t('workspace.tabMenu.closeOthers') },
    { type: 'separator' },
    { id: 'new', label: t('workspace.tabMenu.newQuery') }
  ])
  if (choice === 'close') await props.ws.closeTab(id)
  else if (choice === 'others') {
    // stops at the first tab whose closing the user cancels
    for (const tab of [...props.ws.tabs]) if (tab.id !== id && !(await props.ws.closeTab(tab.id))) break
  } else if (choice === 'new') props.ws.newQueryTab()
}
</script>

<template>
  <div class="workspace">
    <div class="toolbar main-toolbar">
      <button class="icon-btn" :title="t('workspace.toolbar.newQuery', { shortcut: shortcut('Cmd+T') })" @click="ws.newQueryTab()"><FilePlus2 :size="16" /></button>
      <button class="icon-btn" :title="t('workspace.toolbar.openScript', { shortcut: shortcut('Cmd+Shift+O') })" @click="ws.openScript()"><FolderOpen :size="16" /></button>
      <span class="sep" />
      <button
        class="icon-btn"
        :title="t('workspace.toolbar.inspector')"
        :disabled="!ws.selection?.schema || ws.selection.kind === 'extension'"
        @click="ws.openInspector(ws.selection!.schema!, ws.selection?.kind === 'table' ? ws.selection.name : undefined)"
      >
        <Info :size="16" />
      </button>
      <span class="sep" />
      <button v-if="ws.features.newDatabase" class="icon-btn" :title="t('workspace.toolbar.newDatabase')" @click="newDatabase(ws)"><Database :size="16" /></button>
      <button v-if="ws.features.schemaEditor" class="icon-btn" :title="t('workspace.toolbar.newSchema')" @click="schemaDialog(ws, null)"><DatabaseZap :size="16" /></button>
      <button class="icon-btn" :title="t('workspace.toolbar.newTable')" @click="create('table')"><Table2 :size="16" /></button>
      <button class="icon-btn" :title="t('workspace.toolbar.newView')" @click="create('VIEW')"><Eye :size="16" /></button>
      <template v-if="ws.features.routines">
        <button class="icon-btn" :title="t('workspace.toolbar.newProcedure')" @click="create('PROCEDURE')"><Workflow :size="16" /></button>
        <button class="icon-btn" :title="t('workspace.toolbar.newFunction')" @click="create('FUNCTION')"><FunctionSquare :size="16" /></button>
      </template>
      <span class="sep" />
      <button class="icon-btn" :title="t('workspace.toolbar.search')" @click="ws.openSearch()"><TextSearch :size="16" /></button>
      <button v-if="ws.features.reconnect" class="icon-btn" :title="t('workspace.toolbar.reconnect')" @click="ws.reconnect()"><Plug :size="16" /></button>
      <span class="spacer" />
      <span class="conn muted">{{ ws.info?.version }} · {{ ws.defaultSchema || t('workspace.noDefaultSchema') }}</span>
      <button class="icon-btn" :class="{ active: ws.sidebarVisible }" :title="t('workspace.toolbar.toggleSidebar')" @click="ws.sidebarVisible = !ws.sidebarVisible">
        <PanelLeft :size="16" />
      </button>
      <button class="icon-btn" :class="{ active: ws.outputVisible }" :title="t('workspace.toolbar.toggleOutput')" @click="ws.outputVisible = !ws.outputVisible">
        <PanelBottom :size="16" />
      </button>
      <button
        v-if="ws.features.snippets"
        class="icon-btn"
        :class="{ active: ws.secondaryVisible }"
        :title="t('workspace.toolbar.toggleSecondary')"
        @click="ws.secondaryVisible = !ws.secondaryVisible"
      >
        <PanelRight :size="16" />
      </button>
    </div>
    <Splitpanes class="body">
      <Pane v-if="ws.sidebarVisible" :size="20" :min-size="12" :max-size="45">
        <Navigator :ws="ws" />
      </Pane>
      <Pane :size="100 - (ws.sidebarVisible ? 20 : 0) - (ws.secondaryVisible ? 18 : 0)" :min-size="30">
        <Splitpanes horizontal>
          <Pane :size="78" :min-size="20">
            <div class="editors">
              <div class="tabbar" role="tablist" @keydown="moveTabFocus">
                <div
                  v-for="tab in ws.tabs"
                  :key="tab.id"
                  class="tab"
                  :class="{ active: tab.id === ws.activeTab }"
                  role="tab"
                  :aria-selected="tab.id === ws.activeTab"
                  :tabindex="tab.id === ws.activeTab ? 0 : -1"
                  :title="tab.kind === 'query' && tab.filePath ? tab.filePath : tab.title"
                  @mousedown="ws.activeTab = tab.id"
                  @keydown.enter.space.self.prevent="ws.activeTab = tab.id"
                  @contextmenu.prevent="onTabContext(tab.id)"
                >
                  <span class="label">{{ tab.title }}</span>
                  <Circle v-if="(tab.kind === 'query' || tab.kind === 'table' || tab.kind === 'routine') && tab.dirty" :size="7" fill="currentColor" class="dirty" />
                  <button class="close" :title="t('workspace.closeTab')" :aria-label="t('workspace.closeTab')" @mousedown.stop @click.stop="ws.closeTab(tab.id)">
                    <X :size="11" />
                  </button>
                </div>
                <div class="tab add" :title="t('workspace.tabMenu.newQuery')" @mousedown="ws.newQueryTab()">+</div>
              </div>
              <div class="editor-area">
                <template v-for="tab in ws.tabs" :key="tab.id">
                  <div v-show="tab.id === ws.activeTab" class="editor-page">
                    <QueryEditor v-if="tab.kind === 'query'" :ws="ws" :tab="tab" />
                    <TableEditor v-else-if="tab.kind === 'table'" :ws="ws" :tab="tab" />
                    <RoutineEditor v-else-if="tab.kind === 'routine'" :ws="ws" :tab="tab" />
                    <InspectorPage v-else-if="tab.kind === 'inspector'" :ws="ws" :tab="tab" />
                    <SearchData v-else-if="tab.kind === 'search'" :ws="ws" />
                    <component :is="adminComponents[tab.page]" v-else-if="tab.kind === 'admin'" :ws="ws" :tab="tab" />
                  </div>
                </template>
                <div v-if="!ws.tabs.length" class="empty-state">{{ t('workspace.empty', { shortcut: shortcut('Cmd+T') }) }}</div>
              </div>
            </div>
          </Pane>
          <Pane v-if="ws.outputVisible" :size="22" :min-size="8">
            <OutputPanel :ws="ws" @insert-sql="(sql) => sendToEditor(ws, sql)" />
          </Pane>
        </Splitpanes>
      </Pane>
      <Pane v-if="ws.secondaryVisible" :size="18" :min-size="12" :max-size="40">
        <SnippetsPanel :ws="ws" />
      </Pane>
    </Splitpanes>
    <span v-if="app.connecting" hidden />
  </div>
</template>

<style scoped>
.workspace {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.main-toolbar {
  min-height: 34px;
}

.conn {
  font-size: var(--fs-small);
  margin-right: 8px;
}

.body {
  flex: 1;
  min-height: 0;
}

.editors {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-content);
}

.editor-area {
  flex: 1;
  min-height: 0;
  position: relative;
}

.editor-page {
  position: absolute;
  inset: 0;
}

.tab.add {
  color: var(--text-muted);
  font-size: 15px;
  border-right: none;
}

.dirty {
  color: var(--text-muted);
}
</style>
