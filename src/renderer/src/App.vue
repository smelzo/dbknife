<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { FileSpreadsheet, House, Save, X } from 'lucide-vue-next'
import { t } from './i18n'
import { environmentLabel, useApp } from './stores/app'
import { installCommands } from './commands'
import { moveTabFocus } from './tablist'
import HomeScreen from './components/home/HomeScreen.vue'
import ConnectionWorkspace from './components/workspace/ConnectionWorkspace.vue'
import DialogHost from './components/common/DialogHost.vue'
import EngineIcon from './components/common/EngineIcon.vue'

const app = useApp()
const home = ref<InstanceType<typeof HomeScreen>>()

onMounted(async () => {
  await app.init()
  installCommands({
    newConnection: () => {
      app.active = 'home'
      home.value?.newConnection()
    }
  })
  window.api.app.onOpenFile((path) => void app.openFile(path))
})
</script>

<template>
  <div class="app">
    <header class="titlebar">
      <div class="traffic" />
      <div class="main-tabs" role="tablist" @keydown="moveTabFocus">
        <div
          class="mtab home"
          :class="{ active: app.active === 'home' }"
          role="tab"
          :aria-selected="app.active === 'home'"
          :tabindex="app.active === 'home' ? 0 : -1"
          :title="t('app.homeTab')"
          @mousedown="app.active = 'home'"
          @keydown.enter.space.self.prevent="app.active = 'home'"
        >
          <House :size="15" />
        </div>
        <div
          v-for="ws in app.workspaces"
          :key="ws.id"
          class="mtab"
          :class="[{ active: app.active === ws.id }, ws.config.environment && `env env-${ws.config.environment}`]"
          role="tab"
          :aria-selected="app.active === ws.id"
          :tabindex="app.active === ws.id ? 0 : -1"
          :title="
            ws.config.environment
              ? t('app.tabWithEnvironment', { name: ws.config.name, environment: environmentLabel(ws.config.environment) })
              : (ws.config.csv ?? ws.config.name)
          "
          @mousedown="app.active = ws.id"
          @keydown.enter.space.self.prevent="app.active = ws.id"
        >
          <FileSpreadsheet v-if="ws.config.csv" class="engine" :aria-label="t('app.csvFile')" />
          <EngineIcon v-else :engine="ws.config.engine" class="engine" />
          <span class="label">{{ ws.title }}</span>
          <span v-if="ws.config.environment" class="env-label">{{ environmentLabel(ws.config.environment) }}</span>
          <button
            v-if="ws.csvStatus.changed"
            class="close"
            :title="t('app.saveCsv')"
            :aria-label="t('app.saveCsv')"
            :tabindex="app.active === ws.id ? 0 : -1"
            @mousedown.stop
            @click.stop="ws.saveCsv()"
          >
            <Save :size="11" />
          </button>
          <button
            class="close"
            :title="t('app.closeConnection')"
            :aria-label="t('app.closeConnection')"
            :tabindex="app.active === ws.id ? 0 : -1"
            @mousedown.stop
            @click.stop="app.closeWorkspace(ws.id)"
          >
            <X :size="11" />
          </button>
        </div>
      </div>
      <button v-if="app.updateReady" class="update-ready" @click="app.restart()">
        {{ t('app.update.restart', { version: app.updateReady }) }}
      </button>
    </header>
    <main class="content">
      <HomeScreen v-show="app.active === 'home'" ref="home" />
      <ConnectionWorkspace v-for="ws in app.workspaces" v-show="app.active === ws.id" :key="ws.id" :ws="ws" />
    </main>
    <DialogHost />
  </div>
</template>

<style scoped>
.app {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.titlebar {
  height: 38px;
  flex: none;
  display: flex;
  align-items: flex-end;
  background: var(--bg-chrome);
  border-bottom: 1px solid var(--border);
  -webkit-app-region: drag;
}

.traffic {
  width: 80px;
  flex: none;
}

.main-tabs {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  overflow-x: auto;
  scrollbar-width: none;
  padding-right: 8px;
}

.mtab {
  -webkit-app-region: no-drag;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 30px;
  padding: 0 12px;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 7px 7px 0 0;
  color: var(--text-muted);
  white-space: nowrap;
  max-width: 260px;
}

.mtab:hover {
  background: var(--bg-hover);
}

.mtab.active {
  background: var(--bg-panel);
  border-color: var(--border);
  color: var(--text);
  margin-bottom: -1px;
  height: 31px;
}

/* after .mtab.active, whose border colour it overrides */
.mtab.env {
  border-top: 3px solid var(--env);
}

.mtab .engine {
  width: 14px;
  height: 14px;
  flex: none;
}

.mtab .label {
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 500;
}

/* the tile's environment badge, smaller */
.mtab .env-label {
  flex: none;
  padding: 0 4px;
  border-radius: 3px;
  background: var(--env);
  color: var(--env-text);
  font-size: 10px;
  line-height: 14px;
}

.mtab .close {
  display: inline-flex;
  border: none;
  background: transparent;
  border-radius: 3px;
  padding: 1px;
  opacity: 0.6;
}

.mtab .close:hover {
  background: var(--bg-hover);
  opacity: 1;
}

.update-ready {
  -webkit-app-region: no-drag;
  flex: none;
  align-self: center;
  margin-left: auto;
  margin-right: 10px;
  color: var(--accent);
  border-color: var(--accent);
}

.content {
  flex: 1;
  min-height: 0;
  position: relative;
}

.content > * {
  position: absolute;
  inset: 0;
}
</style>
