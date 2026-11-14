<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { CircleAlert, CircleCheck, CircleX, Info, Loader, Trash2 } from 'lucide-vue-next'
import type { Workspace } from '@/workspace/workspace'
import { formatLocale, t } from '@/i18n'

const props = defineProps<{ ws: Workspace }>()
const emit = defineEmits<{ 'insert-sql': [sql: string] }>()

const view = ref<'output' | 'history'>('output')
const selected = ref<number | null>(null)
const list = ref<HTMLElement>()

watch(
  () => props.ws.output.length,
  async () => {
    await nextTick()
    if (list.value) list.value.scrollTop = list.value.scrollHeight
  }
)

const time = (d: Date): string => d.toTimeString().slice(0, 8)

const historyByDay = computed(() => {
  const groups = new Map<string, typeof props.ws.history>()
  for (const h of [...props.ws.history].reverse()) {
    const day = new Date(h.time).toLocaleDateString(formatLocale())
    if (!groups.has(day)) groups.set(day, [])
    groups.get(day)!.push(h)
  }
  return [...groups]
})

async function onContext(n: number): Promise<void> {
  selected.value = n
  const entry = props.ws.output.find((e) => e.n === n)
  if (!entry) return
  const choice = await window.api.ui.contextMenu([
    { id: 'copy-action', label: t('output.menu.copyAction') },
    { id: 'copy-message', label: t('output.menu.copyMessage') },
    { id: 'copy-row', label: t('output.menu.copyRow') },
    { type: 'separator' },
    { id: 'clear', label: t('common.clear') }
  ])
  if (choice === 'copy-action') void navigator.clipboard.writeText(entry.action)
  else if (choice === 'copy-message') void navigator.clipboard.writeText(entry.message)
  else if (choice === 'copy-row')
    void navigator.clipboard.writeText([entry.n, time(entry.time), entry.action, entry.message, entry.duration].join('\t'))
  else if (choice === 'clear') props.ws.output.splice(0)
}

async function onHistoryContext(sql: string): Promise<void> {
  const choice = await window.api.ui.contextMenu([
    { id: 'append', label: t('output.menu.appendToEditor') },
    { id: 'copy', label: t('output.menu.copyRow') }
  ])
  if (choice === 'append') emit('insert-sql', sql)
  else if (choice === 'copy') void navigator.clipboard.writeText(sql)
}
</script>

<template>
  <div class="output">
    <div class="toolbar">
      <select v-model="view" class="view">
        <option value="output">{{ t('output.actionOutput') }}</option>
        <option value="history">{{ t('output.historyOutput') }}</option>
      </select>
      <span class="spacer" />
      <button v-if="view === 'output'" class="icon-btn" :title="t('output.clearTitle')" @click="ws.output.splice(0)"><Trash2 :size="14" /></button>
    </div>
    <div v-if="view === 'output'" ref="list" class="list">
      <table class="list">
        <thead>
          <tr>
            <th class="st" />
            <th class="n">#</th>
            <th class="time">{{ t('output.column.time') }}</th>
            <th>{{ t('output.column.action') }}</th>
            <th>{{ t('output.column.message') }}</th>
            <th class="dur">{{ t('output.column.duration') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="e in ws.output"
            :key="e.n"
            :class="{ selected: selected === e.n }"
            @mousedown="selected = e.n"
            @contextmenu.prevent="onContext(e.n)"
          >
            <td class="st">
              <CircleCheck v-if="e.status === 'ok'" class="ok" :size="13" />
              <CircleX v-else-if="e.status === 'error'" class="err" :size="13" />
              <CircleAlert v-else-if="e.status === 'warning'" class="warn" :size="13" />
              <Loader v-else-if="e.status === 'running'" class="run" :size="13" />
              <Info v-else class="info" :size="13" />
            </td>
            <td class="n">{{ e.n }}</td>
            <td class="time">{{ time(e.time) }}</td>
            <td class="action" :title="e.action">{{ e.action }}</td>
            <td class="message" :class="{ err: e.status === 'error' }" :title="e.message">{{ e.message }}</td>
            <td class="dur">{{ e.duration }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else class="list">
      <div v-for="[day, entries] in historyByDay" :key="day" class="day">
        <div class="day-title">{{ day }}</div>
        <div
          v-for="(h, i) in entries"
          :key="i"
          class="hist"
          :class="{ err: h.error }"
          :title="h.sql"
          @dblclick="emit('insert-sql', h.sql)"
          @contextmenu.prevent="onHistoryContext(h.sql)"
        >
          <span class="time">{{ new Date(h.time).toTimeString().slice(0, 8) }}</span>
          <span class="sql mono">{{ h.sql.replace(/\s+/g, ' ') }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.output {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-content);
}

.view {
  font-weight: 600;
}

.list {
  flex: 1;
  overflow: auto;
}

table.list {
  table-layout: fixed;
}

table.list td {
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 2px 6px;
}

.st {
  width: 26px;
}

.n {
  width: 40px;
}

.time {
  width: 70px;
}

.dur {
  width: 150px;
}

.action {
  width: 45%;
}

.ok {
  color: var(--success);
}

.err {
  color: var(--danger);
}

.warn {
  color: var(--warning);
}

.info,
.run {
  color: var(--accent);
}

.day-title {
  position: sticky;
  top: 0;
  background: var(--bg-header);
  padding: 3px 8px;
  font-weight: 600;
}

.hist {
  display: flex;
  gap: 10px;
  padding: 2px 8px;
  white-space: nowrap;
}

.hist:hover {
  background: var(--bg-hover);
}

.hist .time {
  color: var(--text-muted);
  flex: none;
}

.hist .sql {
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
