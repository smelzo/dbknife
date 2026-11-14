<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Plus, Replace, Trash2, TextCursor } from 'lucide-vue-next'
import type { Snippet } from '@shared/types'
import { prompt } from '@/dialogs'
import { t } from '@/i18n'
import { sendToEditor } from '@/workspace/object-actions'
import type { Workspace } from '@/workspace/workspace'

/** The "SQL Additions" snippets list: the snippets of the connection's engine, shared by its connections. */
const props = defineProps<{ ws: Workspace }>()

/** Every engine's snippets: saving writes them all back. */
const snippets = ref<Snippet[]>([])
const engine = computed(() => props.ws.config.engine)
const engineSnippets = computed(() => snippets.value.filter((s) => s.engine === engine.value))
const category = ref('My Snippets')
const selected = ref<string>('')

onMounted(async () => {
  snippets.value = await window.api.snippets.load()
  if (!categories.value.includes(category.value)) category.value = categories.value[0] ?? 'My Snippets'
})

const categories = computed(() => {
  const set = new Set(engineSnippets.value.map((s) => s.category))
  set.add('My Snippets')
  return [...set].sort()
})
const visible = computed(() => engineSnippets.value.filter((s) => s.category === category.value))
const current = computed(() => snippets.value.find((s) => s.id === selected.value))

const save = (): Promise<void> => window.api.snippets.save(JSON.parse(JSON.stringify(snippets.value)))

function insert(): void {
  if (current.value) sendToEditor(props.ws, current.value.sql)
}

function replaceEditor(): void {
  const tab = props.ws.activeQueryTab
  if (current.value && tab) tab.model.setValue(current.value.sql)
}

async function addFromEditor(): Promise<void> {
  const tab = props.ws.activeQueryTab
  const editor = tab?.editor
  if (!editor) return
  const sel = editor.getSelection()
  const sql = sel && !sel.isEmpty() ? editor.getModel()!.getValueInRange(sel) : editor.getModel()!.getValue()
  const r = await prompt({
    title: t('snippets.new'),
    fields: [
      { key: 'title', label: t('snippets.field.title'), value: sql.split('\n')[0].slice(0, 60) },
      { key: 'sql', label: 'SQL', type: 'textarea', value: sql }
    ]
  })
  if (!r) return
  const s: Snippet = { id: crypto.randomUUID(), engine: engine.value, category: category.value, title: String(r.title), sql: String(r.sql) }
  snippets.value.push(s)
  selected.value = s.id
  await save()
}

async function edit(s: Snippet): Promise<void> {
  const r = await prompt({
    title: t('snippets.edit'),
    fields: [
      { key: 'title', label: t('snippets.field.title'), value: s.title },
      { key: 'sql', label: 'SQL', type: 'textarea', value: s.sql }
    ]
  })
  if (!r) return
  s.title = String(r.title)
  s.sql = String(r.sql)
  await save()
}

async function remove(): Promise<void> {
  if (!current.value) return
  snippets.value = snippets.value.filter((s) => s.id !== selected.value)
  selected.value = ''
  await save()
}
</script>

<template>
  <div class="snippets">
    <div class="head">{{ t('snippets.title') }}</div>
    <div class="toolbar">
      <select v-model="category" class="cat">
        <option v-for="c in categories" :key="c" :value="c">{{ c }}</option>
      </select>
    </div>
    <div class="toolbar">
      <button class="icon-btn" :title="t('snippets.insert')" :disabled="!current" @click="insert"><TextCursor :size="14" /></button>
      <button class="icon-btn" :title="t('snippets.replace')" :disabled="!current" @click="replaceEditor">
        <Replace :size="14" />
      </button>
      <button class="icon-btn" :title="t('snippets.add')" @click="addFromEditor"><Plus :size="14" /></button>
      <button class="icon-btn" :title="t('snippets.delete')" :disabled="!current" @click="remove"><Trash2 :size="14" /></button>
    </div>
    <div class="list">
      <div
        v-for="s in visible"
        :key="s.id"
        class="item"
        :class="{ selected: s.id === selected }"
        :title="s.sql"
        @click="selected = s.id"
        @dblclick="edit(s)"
      >
        <div class="t">{{ s.title }}</div>
        <div class="sql mono">{{ s.sql.split('\n').slice(0, 2).join(' ') }}</div>
      </div>
      <div v-if="!visible.length" class="muted pad">{{ t('snippets.empty') }}</div>
    </div>
  </div>
</template>

<style scoped>
.snippets {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
}

.head {
  padding: 6px 10px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  font-size: var(--fs-small);
}

.cat {
  flex: 1;
}

.list {
  flex: 1;
  overflow: auto;
}

.item {
  padding: 4px 10px;
  border-bottom: 1px solid var(--border);
}

.item.selected {
  background: var(--bg-selected);
}

.t {
  font-weight: 600;
}

.sql {
  font-size: var(--fs-small);
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pad {
  padding: 10px;
}
</style>
