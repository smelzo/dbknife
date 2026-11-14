<script setup lang="ts">
import { computed, ref } from 'vue'
import { FileSpreadsheet, Loader } from 'lucide-vue-next'
import type { RecentFile } from '@shared/types'
import { isCsvFile } from '@shared/file-types'
import { confirm, openDialog } from '@/dialogs'
import { t } from '@/i18n'
import { newConnectionConfig, useApp } from '@/stores/app'
import ConnectionEditor from './ConnectionEditor.vue'
import EngineIcon from '../common/EngineIcon.vue'

/** SQLite and CSV files opened directly, beside the saved connections. */
const app = useApp()
const search = ref('')

const files = computed(() => {
  const q = search.value.trim().toLowerCase()
  return q ? app.recentFiles.filter((f) => f.path.toLowerCase().includes(q)) : app.recentFiles
})

const fileName = (path: string): string => path.split('/').pop() || path
const folder = (path: string): string => path.slice(0, path.lastIndexOf('/')) || '/'

async function remove(f: RecentFile): Promise<void> {
  await window.api.recentFiles.remove(f.path)
  await app.loadConnections()
}

async function open(f: RecentFile): Promise<void> {
  if (f.missing) {
    if (await confirm(t('home.recent.missing', { file: f.path }), undefined, t('home.recent.remove'))) await remove(f)
    return
  }
  await app.openFile(f.path)
}

/** The connection editor filled in for the file; once saved, the file is a tile and leaves this list. */
async function saveAsConnection(f: RecentFile): Promise<void> {
  const config = { ...newConnectionConfig(), engine: 'sqlite' as const, name: fileName(f.path), file: f.path }
  if (await openDialog(ConnectionEditor, { config, isNew: true })) await app.loadConnections()
}

async function onContext(f: RecentFile): Promise<void> {
  const choice = await window.api.ui.contextMenu([
    ...(isCsvFile(f.path) ? [] : [{ id: 'save', label: t('home.recent.saveConnection') }]),
    { id: 'reveal', label: t('home.recent.reveal'), enabled: !f.missing },
    { type: 'separator' as const },
    { id: 'remove', label: t('home.recent.remove') }
  ])
  if (choice === 'save') await saveAsConnection(f)
  else if (choice === 'reveal') await window.api.files.reveal(f.path)
  else if (choice === 'remove') await remove(f)
}
</script>

<template>
  <section class="recent-files">
    <div class="section-head">
      <h2>{{ t('home.recent.title') }}</h2>
      <span class="spacer" />
      <input v-model="search" type="search" class="search" :placeholder="t('home.recent.filter')" />
    </div>
    <ul v-if="files.length" class="list">
      <li
        v-for="f in files"
        :key="f.path"
        class="recent"
        :class="{ missing: f.missing }"
        :title="f.path"
        tabindex="0"
        @click="open(f)"
        @keydown.enter="open(f)"
        @contextmenu.prevent="onContext(f)"
      >
        <FileSpreadsheet v-if="isCsvFile(f.path)" class="kind csv" :size="18" :aria-label="t('app.csvFile')" />
        <EngineIcon v-else engine="sqlite" class="kind sqlite" />
        <div class="text">
          <div class="name">
            {{ fileName(f.path) }}
            <Loader v-if="app.connecting === `file:${f.path}`" :size="12" class="spin" />
          </div>
          <div class="folder">{{ folder(f.path) }}</div>
        </div>
      </li>
    </ul>
    <p v-else class="empty muted">{{ t(app.recentFiles.length ? 'home.recent.noMatch' : 'home.recent.empty') }}</p>
  </section>
</template>

<style scoped>
.section-head {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 14px;
}

h2 {
  font-size: 17px;
  font-weight: 400;
  margin: 0 8px 0 0;
}

.spacer {
  flex: 1;
}

.search {
  width: 160px;
  min-width: 0;
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.recent {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border-radius: 5px;
  cursor: pointer;
  outline: none;
}

.recent:hover,
.recent:focus-visible {
  background: var(--bg-hover);
}

.recent.missing {
  opacity: 0.5;
}

.kind {
  flex: none;
  width: 18px;
  height: 18px;
}

.kind.sqlite {
  color: var(--tile-sqlite);
}

.kind.csv {
  color: var(--accent);
}

.text {
  min-width: 0;
}

.name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}

.name,
.folder {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.folder {
  font-size: var(--fs-small);
  color: var(--text-muted);
}

.empty {
  margin: 0;
  padding: 30px 0;
  line-height: 1.5;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
