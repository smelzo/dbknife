<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { ChevronDown, ChevronRight, Database, File, Folder } from 'lucide-vue-next'
import type { Channel, RemoteListing } from '@shared/types'
import { isSqliteFile } from '@shared/file-types'
import { alertError } from '@/dialogs'
import { t } from '@/i18n'
import { withChannelCredentials } from '@/stores/app'
import { formatBytes } from '@/workspace/format'
import Modal from '../common/Modal.vue'

/**
 * Chooses a database file on the machine of a channel, from the tree of its folders opened on
 * the folder of `start` (the home folder without one). Resolves with the absolute path of the file.
 */
const props = defineProps<{ channel: Channel; start: string }>()
const emit = defineEmits<{ close: [path?: string] }>()

interface Node {
  /** Absolute, joined with '/': the machine is Linux or macOS whatever system the app runs on. */
  path: string
  name: string
  dir: boolean
  size: number
  depth: number
  /** The entries of a folder, once listed. */
  children?: Node[]
  open: boolean
  loading: boolean
  /** Why the folder could not be listed. */
  error: string
}

const newNode = (parent: Node | undefined, name: string, dir: boolean, size = 0): Node =>
  reactive({
    path: parent ? `${parent.path === '/' ? '' : parent.path}/${name}` : '/',
    name,
    dir,
    size,
    depth: parent ? parent.depth + 1 : 0,
    open: false,
    loading: false,
    error: ''
  })

const root = newNode(undefined, '/', true)
const connecting = ref(true)
const allFiles = ref(false)
const selected = ref('')
const list = ref<HTMLElement>()

/** The tree as the rows shown: the entries of the open folders, files limited to databases unless "All files". */
const rows = computed(() => {
  const out: Node[] = []
  const walk = (n: Node): void => {
    out.push(n)
    if (!n.open) return
    for (const child of n.children ?? []) if (child.dir || allFiles.value || isSqliteFile(child.name)) walk(child)
  }
  walk(root)
  return out
})

/** The file OK returns: the selected row, when it is a file. */
const chosen = computed(() => rows.value.find((n) => !n.dir && n.path === selected.value))

let browseId = ''
/** The dialog has closed, perhaps while the browsing session was still opening. */
let gone = false

function fill(n: Node, entries: RemoteListing['entries']): void {
  n.error = ''
  n.children = entries.map((e) => newNode(n, e.name, e.dir, e.size))
}

/** Lists a folder; a failure (permission denied) is shown on the folder and tried again when it is expanded again. */
async function load(n: Node): Promise<void> {
  n.loading = true
  const listing = await window.api.channels.browseList(browseId, n.path)
  n.loading = false
  if (listing.error) n.error = listing.error
  else fill(n, listing.entries)
}

function toggle(n: Node): void {
  if (!n.dir) return
  n.open = !n.open
  if (n.open && !n.children) void load(n)
}

/** Opens the tree down to the folder of `start`, or to the home folder when that one cannot be listed. */
async function openStart(): Promise<void> {
  const slash = props.start.lastIndexOf('/')
  const folder = slash < 0 ? '' : props.start.slice(0, slash) || '/'
  let listing = await window.api.channels.browseList(browseId, folder)
  if (listing.error && folder) listing = await window.api.channels.browseList(browseId, '')
  let at = root
  if (listing.error) await load(at)
  else {
    for (const name of listing.path.split('/').filter(Boolean)) {
      await load(at)
      at.open = true
      let child = at.children?.find((n) => n.name === name)
      if (!child) {
        // a folder that cannot be listed (/home on a shared host) still leads to the one below it
        child = newNode(at, name, true)
        at.children = [...(at.children ?? []), child]
      }
      at = child
    }
    fill(at, listing.entries)
  }
  at.open = true
  selected.value = at.path
}

const rowOf = (path: string): Element | null | undefined => list.value?.querySelector(`[data-path="${CSS.escape(path)}"]`)

onMounted(async () => {
  const r = await withChannelCredentials(props.channel, async (creds) => {
    const opened = await window.api.channels.browseOpen(props.channel.id, creds)
    if (!gone) return opened
    // closed while connecting: the session is not left open, and no secret is asked any more
    if (opened.browseId) void window.api.channels.browseClose(opened.browseId)
    return { ok: false }
  })
  if (gone) return
  if (!r?.ok) {
    if (r) await alertError(t('remoteFile.openFailed', { channel: props.channel.name }), r.error?.message)
    emit('close')
    return
  }
  browseId = r.browseId!
  await openStart()
  connecting.value = false
  await nextTick()
  rowOf(selected.value)?.scrollIntoView({ block: 'start' })
})

// every way out (OK, Cancel, Esc, a failure) unmounts the dialog
onBeforeUnmount(() => {
  gone = true
  if (browseId) void window.api.channels.browseClose(browseId)
})

function activate(n: Node): void {
  if (n.dir) toggle(n)
  else emit('close', n.path)
}

function onKey(e: KeyboardEvent): void {
  const i = rows.value.findIndex((n) => n.path === selected.value)
  const node = rows.value[i]
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const next = rows.value[Math.max(0, Math.min(rows.value.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
    if (next) {
      selected.value = next.path
      rowOf(next.path)?.scrollIntoView({ block: 'nearest' })
    }
  } else if (node && e.key === 'ArrowRight' && node.dir && !node.open) toggle(node)
  else if (node && e.key === 'ArrowLeft' && node.open) toggle(node)
  else if (node && e.key === 'Enter' && !e.repeat) activate(node)
}
</script>

<template>
  <Modal :title="t('remoteFile.title', { channel: channel.name })" width="560px" height="520px" @cancel="emit('close')">
    <div ref="list" class="tree" role="tree" tabindex="0" autofocus @keydown="onKey">
      <div v-if="connecting" class="muted pad">{{ t('remoteFile.connecting') }}</div>
      <template v-else>
        <div
          v-for="n in rows"
          :key="n.path"
          :data-path="n.path"
          class="node"
          :class="{ selected: selected === n.path }"
          :style="{ paddingLeft: `${4 + n.depth * 14}px` }"
          role="treeitem"
          :aria-expanded="n.dir ? n.open : undefined"
          :aria-level="n.depth + 1"
          :aria-selected="selected === n.path"
          @mousedown="selected = n.path"
          @dblclick="activate(n)"
        >
          <span class="twisty" @mousedown.stop="toggle(n)" @dblclick.stop>
            <template v-if="n.dir">
              <ChevronDown v-if="n.open" :size="12" />
              <ChevronRight v-else :size="12" />
            </template>
          </span>
          <component :is="n.dir ? Folder : isSqliteFile(n.name) ? Database : File" :size="13" class="icon" />
          <span class="label">{{ n.name }}</span>
          <span v-if="n.loading" class="detail">…</span>
          <span v-else-if="n.error" class="detail error" :title="n.error">{{ n.error }}</span>
          <span v-else-if="!n.dir" class="detail">{{ formatBytes(n.size) }}</span>
        </div>
      </template>
    </div>
    <template #footer>
      <label class="check all"><input id="rf-all" v-model="allFiles" type="checkbox" /> {{ t('remoteFile.allFiles') }}</label>
      <button id="rf-cancel" @click="emit('close')">{{ t('common.cancel') }}</button>
      <button id="rf-ok" class="primary" :disabled="!chosen" @click="chosen && activate(chosen)">{{ t('common.ok') }}</button>
    </template>
  </Modal>
</template>

<style scoped>
/* the rows follow the navigator's tree (SchemaTree.vue) */
.tree {
  height: 100%;
  overflow: auto;
  padding: 2px 0;
  background: var(--bg-content);
  border: 1px solid var(--border);
}

.pad {
  padding: 6px 10px;
}

.node {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  white-space: nowrap;
  padding-right: 6px;
}

.node:hover {
  background: var(--bg-hover);
}

.node.selected {
  background: var(--bg-selected);
}

.twisty {
  width: 14px;
  display: inline-flex;
  justify-content: center;
  color: var(--text-muted);
  flex: none;
}

.icon {
  flex: none;
  color: var(--text-muted);
}

.label {
  flex: none;
}

.detail {
  color: var(--text-faint);
  font-size: var(--fs-small);
  overflow: hidden;
  text-overflow: ellipsis;
}

.detail.error {
  color: var(--danger);
}

.all {
  margin-right: auto;
}
</style>
