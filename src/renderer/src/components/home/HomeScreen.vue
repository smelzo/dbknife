<script setup lang="ts">
import { computed, ref } from 'vue'
import { ArrowLeft, CirclePlus, Database, Folder, Server, Trash2, User, Loader } from 'lucide-vue-next'
import type { ConnectionConfig } from '@shared/types'
import { csvExtensions, isCsvFile, isSqliteFile, sqliteExtensions } from '@shared/file-types'
import { alertError, openDialog, promptText } from '@/dialogs'
import { t } from '@/i18n'
import { connectionEndpoint, environmentLabel, newConnectionConfig, useApp } from '@/stores/app'
import ConnectionEditor from './ConnectionEditor.vue'
import RecentFiles from './RecentFiles.vue'
import EngineIcon from '../common/EngineIcon.vue'

const app = useApp()
const search = ref('')
const group = ref('')

/** "Group/Name" connection names are shown inside a folder tile. */
const split = (c: ConnectionConfig): { group: string; name: string } => {
  const i = c.name.indexOf('/')
  return i > 0 ? { group: c.name.slice(0, i), name: c.name.slice(i + 1) } : { group: '', name: c.name }
}

type Tile = { kind: 'group'; key: string; name: string; ids: string[] } | { kind: 'conn'; key: string; c: ConnectionConfig }

/** Tiles in the stored order; a group sits where its first connection is. */
const tiles = computed<Tile[]>(() => {
  const q = search.value.trim().toLowerCase()
  if (q) {
    return app.connections
      .filter((c) => [c.name, c.host, c.user, c.ssh.host].some((v) => v.toLowerCase().includes(q)))
      .map((c) => ({ kind: 'conn', key: c.id, c }))
  }
  const out: Tile[] = []
  const groups = new Map<string, string[]>()
  for (const c of app.connections) {
    const s = split(c)
    if (group.value) {
      if (s.group === group.value) out.push({ kind: 'conn', key: c.id, c })
    } else if (!s.group) out.push({ kind: 'conn', key: c.id, c })
    else if (groups.has(s.group)) groups.get(s.group)!.push(c.id)
    else {
      groups.set(s.group, [c.id])
      out.push({ kind: 'group', key: `group:${s.group}`, name: s.group, ids: groups.get(s.group)! })
    }
  }
  return out
})

// --- drag & drop reordering ---------------------------------------------------

const tileIds = (t: Tile): string[] => (t.kind === 'group' ? t.ids : [t.c.id])

const dragged = ref<Tile>()
const drop = ref<{ key: string; where: 'before' | 'after' | 'into' }>()

function onDragStart(e: DragEvent, t: Tile): void {
  dragged.value = t
  e.dataTransfer?.setData('text/plain', t.key)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}

function onDragOver(e: DragEvent, t: Tile): void {
  if (!dragged.value || dragged.value.key === t.key) return
  e.preventDefault()
  const box = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const x = (e.clientX - box.left) / box.width
  // a connection dropped in the middle of a folder joins that group
  const where = t.kind === 'group' && dragged.value.kind === 'conn' && x > 0.25 && x < 0.75 ? 'into' : x < 0.5 ? 'before' : 'after'
  drop.value = { key: t.key, where }
}

function onDragEnd(): void {
  dragged.value = undefined
  drop.value = undefined
}

async function onDrop(t: Tile): Promise<void> {
  const source = dragged.value
  const target = drop.value
  onDragEnd()
  if (!source || !target || target.key !== t.key) return
  const moving = tileIds(source)
  const rest = app.connections.map((c) => c.id).filter((id) => !moving.includes(id))
  const anchor = target.where === 'before' ? tileIds(t)[0] : tileIds(t).at(-1)!
  rest.splice(rest.indexOf(anchor) + (target.where === 'before' ? 0 : 1), 0, ...moving)
  if (target.where === 'into' && source.kind === 'conn' && t.kind === 'group') {
    // appended to the group, which keeps its place
    await window.api.connections.save({ ...JSON.parse(JSON.stringify(source.c)), name: `${t.name}/${split(source.c).name}` })
    await window.api.connections.reorder(rest)
    await app.loadConnections()
    return
  }
  const byId = new Map(app.connections.map((c) => [c.id, c]))
  app.connections = rest.map((id) => byId.get(id)!)
  await window.api.connections.reorder(rest)
}

// --- SQLite files dropped from the Finder --------------------------------------

/** Nesting depth of the elements the file drag is over: enter and leave fire for each child. */
const fileDrag = ref(0)
const carriesFiles = (e: DragEvent): boolean => !!e.dataTransfer?.types.includes('Files')

function onFileDragOver(e: DragEvent): void {
  if (!carriesFiles(e)) return
  e.preventDefault()
  e.dataTransfer!.dropEffect = 'copy'
}

async function onFileDrop(e: DragEvent): Promise<void> {
  if (!carriesFiles(e)) return
  e.preventDefault()
  fileDrag.value = 0
  const paths = [...e.dataTransfer!.files].map((f) => window.api.files.pathForFile(f)).filter(Boolean)
  const openable = (p: string): boolean => isSqliteFile(p) || isCsvFile(p)
  for (const path of paths.filter(openable)) void app.openFile(path)
  const rejected = paths.filter((p) => !openable(p))
  if (rejected.length) {
    const extensions = [...sqliteExtensions, ...csvExtensions].map((x) => `.${x}`).join(', ')
    await alertError(t('home.dropUnsupported', { extensions }), rejected.join('\n'))
  }
}

const tileName = (c: ConnectionConfig): string => (group.value || !search.value ? split(c).name : c.name)

async function edit(config: ConnectionConfig, isNew: boolean): Promise<void> {
  const saved = await openDialog<ConnectionConfig>(ConnectionEditor, { config, isNew })
  if (!saved) return
  app.connectionSaved(saved)
  await app.loadConnections()
}

function newConnection(): void {
  const c = newConnectionConfig()
  if (group.value) c.name = `${group.value}/`
  void edit(c, true)
}

async function onContext(c: ConnectionConfig): Promise<void> {
  const choice = await window.api.ui.contextMenu([
    { id: 'open', label: t('home.menu.open') },
    { id: 'edit', label: t('home.menu.edit') },
    { id: 'duplicate', label: t('home.menu.duplicate') },
    { id: 'move', label: t('home.menu.move') },
    { type: 'separator' },
    { id: 'delete', label: t('home.menu.delete') }
  ])
  if (choice === 'open') void app.connect(c)
  else if (choice === 'edit') void edit(c, false)
  else if (choice === 'duplicate') {
    const copy = { ...JSON.parse(JSON.stringify(c)), id: crypto.randomUUID(), name: t('home.copyName', { name: c.name }), lastConnected: undefined }
    delete copy.workbenchKeychain
    await window.api.connections.save(copy)
    await app.loadConnections()
  } else if (choice === 'move') {
    const g = await promptText(t('home.move.title'), t('home.move.groupName'), split(c).group)
    if (g === undefined) return
    await window.api.connections.save({ ...JSON.parse(JSON.stringify(c)), name: g.trim() ? `${g.trim()}/${split(c).name}` : split(c).name })
    await app.loadConnections()
  } else if (choice === 'delete') await removeConnection(c)
}

async function removeConnection(c: ConnectionConfig): Promise<void> {
  const r = await window.api.ui.message({
    type: 'warning',
    message: t('home.delete.message', { name: c.name }),
    detail: t('home.delete.detail'),
    buttons: [t('common.delete'), t('common.cancel')],
    defaultId: 1,
    cancelId: 1
  })
  if (r === 0) {
    await window.api.connections.remove(c.id)
    await app.loadConnections()
  }
}

async function onBackgroundContext(): Promise<void> {
  const choice = await window.api.ui.contextMenu([{ id: 'new', label: t('home.menu.new') }])
  if (choice === 'new') newConnection()
}

/** The empty-list hint with the add icon in place of its placeholder; with a filter, that nothing matches. */
const emptyHint = computed(() => {
  const filter = search.value.trim()
  return filter ? [t('home.noMatches', { filter })] : t('home.empty').split(/(\{add\})/)
})

defineExpose({ newConnection })
</script>

<template>
  <div
    class="home-screen"
    :class="{ 'files-over': fileDrag > 0 }"
    @contextmenu.self.prevent="onBackgroundContext"
    @dragenter="carriesFiles($event) && fileDrag++"
    @dragleave="carriesFiles($event) && fileDrag > 0 && fileDrag--"
    @dragover="onFileDragOver"
    @drop="onFileDrop"
  >
    <div class="inner">
      <h1>{{ t('home.welcome') }}</h1>
      <p class="muted intro">{{ t('home.intro') }}</p>
      <div class="columns">
        <section class="connections">
          <div class="section-head">
            <h2>{{ t('home.connections') }}</h2>
            <button class="icon-btn" :title="t('home.add')" @click="newConnection"><CirclePlus :size="18" /></button>
            <span class="spacer" />
            <input v-model="search" type="search" class="search" :placeholder="t('home.filter')" />
          </div>
          <div class="tiles" @contextmenu.self.prevent="onBackgroundContext">
            <div v-if="group" class="tile back" @click="group = ''">
              <ArrowLeft :size="22" />
              <div class="name">{{ group }}</div>
            </div>
            <template v-for="tile in tiles" :key="tile.key">
              <div
                v-if="tile.kind === 'group'"
                class="tile folder"
                :class="drop?.key === tile.key && `drop-${drop.where}`"
                :data-key="tile.key"
                draggable="true"
                @click="group = tile.name"
                @dragstart="onDragStart($event, tile)"
                @dragover="onDragOver($event, tile)"
                @dragleave="drop?.key === tile.key && (drop = undefined)"
                @drop.prevent="onDrop(tile)"
                @dragend="onDragEnd"
              >
                <div class="name"><Folder :size="15" /> {{ tile.name }}</div>
                <div class="line">{{ t('home.groupCount', { count: tile.ids.length }) }}</div>
              </div>
              <div
                v-else
                class="tile"
                :class="[{ busy: app.connecting === tile.c.id }, drop?.key === tile.key && `drop-${drop.where}`,tile.c.engine]"
                :data-key="tile.key"
                tabindex="0"
                :draggable="!search.trim()"
                @click="$event.detail < 2 && app.connect(tile.c)"
                @keydown.enter="app.connect(tile.c)"
                @contextmenu.prevent="onContext(tile.c)"
                @dragstart="onDragStart($event, tile)"
                @dragover="onDragOver($event, tile)"
                @dragleave="drop?.key === tile.key && (drop = undefined)"
                @drop.prevent="onDrop(tile)"
                @dragend="onDragEnd"
              >
                <EngineIcon :engine="tile.c.engine" class="mark" />
                <div class="name">
                  <span class="text">{{ tileName(tile.c) }}</span>
                  <Loader v-if="app.connecting === tile.c.id" :size="13" class="spin" />
                  <span v-if="tile.c.environment" class="env-badge" :class="`env-${tile.c.environment}`">{{ environmentLabel(tile.c.environment) }}</span>
                </div>
                <div class="line">
                  <template v-if="tile.c.engine === 'sqlite'"><Database :size="12" /> SQLite</template>
                  <template v-else><User :size="12" /> {{ tile.c.user }}</template>
                </div>
                <div class="line"><Server :size="12" /> {{ connectionEndpoint(tile.c) }}</div>
                <button class="trash" :title="t('home.deleteConnection')" @click.stop="removeConnection(tile.c)"><Trash2 :size="13" /></button>
              </div>
            </template>
            <div v-if="!tiles.length" class="empty muted">
              <template v-for="(part, i) in emptyHint" :key="i">
                <CirclePlus v-if="part === '{add}'" :size="13" />
                <template v-else>{{ part }}</template>
              </template>
            </div>
          </div>
        </section>
        <RecentFiles />
      </div>
    </div>
  </div>
</template>

<style scoped>
.home-screen {
  height: 100%;
  overflow: auto;
  background: var(--bg-content);
}

.home-screen.files-over {
  outline: 2px dashed var(--accent);
  outline-offset: -6px;
}

.inner {
  margin: 0 auto;
  padding: 36px 40px;
}

h1 {
  font-weight: 300;
  font-size: 30px;
  margin: 0 0 8px;
}

.intro {
  margin: 0 0 30px;
  max-width: 640px;
  line-height: 1.5;
}

/* connections 2/3, recent files 1/3; one under the other in a narrow window */
.columns {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
  gap: 40px;
  align-items: start;
}

@media (max-width: 860px) {
  .columns {
    grid-template-columns: minmax(0, 1fr);
  }
}

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
  width: 220px;
}

.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 14px;
  min-height: 200px;
  align-content: start;
}

.tile {
  background: var(--tile);
  color: #fff;
  border-radius: 6px;
  padding: 12px 14px;
  min-height: 86px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  outline: none;
  cursor: pointer;
  position: relative;
  overflow: hidden;
  isolation: isolate;
  box-shadow: 0 2px 6px var(--tile-shadow);
  transition: box-shadow 0.12s ease-out;
}

/* the engine's mark, cropped by the tile's corner behind the text */
.mark {
  position: absolute;
  right: -12px;
  bottom: -16px;
  width: 76px;
  height: 76px;
  color: #fff;
  opacity: 0.16;
  z-index: -1;
  pointer-events: none;
}

.tile:hover .mark,
.tile:focus-visible .mark {
  opacity: 0.28;
}

.tile:hover,
.tile:focus-visible {
  background: var(--tile-hover);
  box-shadow: 0 1px 3px var(--tile-shadow);
}

.tile:active {
  box-shadow: none;
}

/* shown while the pointer is on the tile, or the keyboard focus on it or on the button */
.trash {
  position: absolute;
  right: 8px;
  bottom: 6px;
  display: inline-flex;
  padding: 3px;
  border: none;
  border-radius: 4px;
  background: none;
  color: #fff;
  opacity: 0;
  cursor: pointer;
}

.tile:hover .trash,
.tile:focus-visible .trash,
.trash:focus-visible {
  opacity: 0.75;
}

.tile .trash:hover {
  opacity: 1;
  background: rgba(255, 255, 255, 0.18);
}
.tile.sqlite {
  background: var(--tile-sqlite);
}
.tile.sqlite:hover,
.tile.sqlite:focus-visible {
  background: var(--tile-sqlite-hover);
}
.tile.postgres {
  background: var(--tile-postgres);
}
.tile.postgres:hover,
.tile.postgres:focus-visible {
  background: var(--tile-postgres-hover);
}
.tile.mssql {
  background: var(--tile-mssql);
}
.tile.mssql:hover,
.tile.mssql:focus-visible {
  background: var(--tile-mssql-hover);
}
.tile.busy {
  opacity: 0.7;
}

.tile.folder {
  background: color-mix(in srgb, var(--tile) 70%, #8a6d2b);
}

.tile.drop-before {
  box-shadow: -4px 0 0 var(--accent);
}

.tile.drop-after {
  box-shadow: 4px 0 0 var(--accent);
}

.tile.drop-into {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.tile.back {
  box-shadow: none;
  background: var(--bg-panel);
  color: var(--text);
  border: 1px dashed var(--border-strong);
  align-items: center;
  justify-content: center;
}

.name {
  font-weight: 600;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.name .text {
  overflow: hidden;
  text-overflow: ellipsis;
}

/* the connection's environment, at the top right */
.env-badge {
  flex: none;
  margin-left: auto;
  padding: 0 5px;
  border-radius: 3px;
  background: var(--env);
  color: var(--env-text);
  font-size: var(--fs-small);
}

.line {
  font-size: var(--fs-small);
  opacity: 0.85;
  display: flex;
  align-items: center;
  gap: 5px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.empty {
  grid-column: 1 / -1;
  padding: 30px 0;
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
