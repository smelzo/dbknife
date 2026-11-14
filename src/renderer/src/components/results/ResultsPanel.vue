<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, type Component } from 'vue'
import { Download, FileSearch, Network, NotepadText, Pin, PinOff, Plus, RefreshCw, ScrollText, Sheet, SquareMinus, Timer, X } from 'lucide-vue-next'
import type { MessageKey } from '@shared/i18n'
import { t } from '@/i18n'
import { moveTabFocus } from '@/tablist'
import { confirmDiscardEdits } from '@/workspace/confirm'
import { formatDuration } from '@/workspace/format'
import { hasEdits, rowCount, type ResultView } from '@/workspace/results'
import type { QueryTab, Workspace } from '@/workspace/workspace'
import ExplainView from './ExplainView.vue'
import FormView from './FormView.vue'
import ResultGrid from './ResultGrid.vue'
import { applyEdits, exportResult, revertEdits } from './result-actions'

const props = defineProps<{ ws: Workspace; tab: QueryTab }>()

// the input writes filterText; the grid filters on filter, 200 ms after the last key
const filterText = ref('')
const filter = ref('')
let filterTimer: ReturnType<typeof setTimeout> | undefined
watch(filterText, (text) => {
  clearTimeout(filterTimer)
  filterTimer = setTimeout(() => (filter.value = text), 200)
})
onBeforeUnmount(() => clearTimeout(filterTimer))
const formRow = ref(0)
const shown = ref(0)
const grid = ref<InstanceType<typeof ResultGrid>>()

const rt = computed(() => props.tab.results[props.tab.activeResult])

// each result set starts unfiltered
watch(
  () => rt.value?.id,
  () => {
    clearTimeout(filterTimer)
    filterText.value = filter.value = ''
  }
)
const editsPending = computed(() => {
  void rt.value?.version
  return !!rt.value && hasEdits(rt.value)
})
const total = computed(() => {
  void rt.value?.version
  return rt.value ? rowCount(rt.value) : 0
})

const views: { id: ResultView; label: MessageKey; icon: Component }[] = [
  { id: 'grid', label: 'results.view.grid', icon: Sheet },
  { id: 'form', label: 'results.view.form', icon: NotepadText },
  { id: 'fields', label: 'results.view.fields', icon: FileSearch },
  { id: 'stats', label: 'results.view.stats', icon: Timer },
  { id: 'plan', label: 'results.view.plan', icon: Network }
]

async function closeResult(i: number): Promise<void> {
  const result = props.tab.results[i]
  if (!(await confirmDiscardEdits([result]))) return
  // the list may have changed while the dialog was open
  const at = props.tab.results.indexOf(result)
  if (at < 0) return
  props.tab.results.splice(at, 1)
  props.tab.activeResult = Math.min(props.tab.activeResult, props.tab.results.length - 1)
}

async function refresh(): Promise<void> {
  const r = rt.value
  if (r && (await confirmDiscardEdits([r]))) await props.ws.refreshResult(r)
}

</script>

<template>
  <div class="results">
    <div v-if="!tab.results.length && tab.lastError && !tab.running" class="error selectable">
      <h4>{{ t('results.lastError') }}</h4>
      <div class="message">{{ tab.lastError }}</div>
    </div>
    <div v-else-if="!tab.results.length" class="empty-state">
      {{ tab.running ? t('editor.executing') : t('results.empty') }}
    </div>
    <template v-else>
      <div class="tabbar" role="tablist" @keydown="moveTabFocus">
        <div
          v-for="(r, i) in tab.results"
          :key="r.id"
          class="tab"
          :class="{ active: i === tab.activeResult }"
          role="tab"
          :aria-selected="i === tab.activeResult"
          :tabindex="i === tab.activeResult ? 0 : -1"
          @mousedown="tab.activeResult = i"
          @keydown.enter.space.self.prevent="tab.activeResult = i"
        >
          <span class="label">{{ r.title }}</span>
          <button
            class="close"
            :title="r.pinned ? t('results.unpin') : t('results.pin')"
            :aria-label="r.pinned ? t('results.unpin') : t('results.pin')"
            @mousedown.stop
            @click.stop="r.pinned = !r.pinned"
          >
            <PinOff v-if="r.pinned" :size="11" /><Pin v-else :size="11" />
          </button>
          <button class="close" :title="t('workspace.closeTab')" :aria-label="t('workspace.closeTab')" @mousedown.stop @click.stop="closeResult(i)">
            <X :size="11" />
          </button>
        </div>
      </div>
      <div v-if="rt" class="toolbar">
        <template v-if="rt.view === 'grid'">
          <span class="muted">{{ t('results.filterRows') }}</span>
          <input v-model="filterText" type="search" class="filter" :placeholder="t('results.search')" />
          <span class="sep" />
          <button
            class="icon-btn"
            :title="t('results.addRow')"
            :aria-label="t('results.addRow')"
            :disabled="!rt.target"
            @click="grid?.addNewRow()"
          >
            <Plus :size="15" />
          </button>
          <button
            class="icon-btn"
            :title="t('results.deleteRows')"
            :aria-label="t('results.deleteRows')"
            :disabled="!rt.target"
            @click="grid?.deleteSelected()"
          >
            <SquareMinus :size="15" />
          </button>
          <span class="sep" />
        </template>
        <button class="icon-btn" :title="t('results.export')" :aria-label="t('results.export')" @click="exportResult(rt)"><Download :size="15" /></button>
        <button class="icon-btn" :title="t('results.refresh')" :aria-label="t('results.refresh')" :disabled="ws.busy" @click="refresh">
          <RefreshCw :size="14" />
        </button>
        <span class="spacer" />
        <span class="muted status">{{ rt.readOnlyReason }}</span>
        <template v-if="editsPending">
          <button class="primary" :disabled="ws.busy" @click="applyEdits(ws, rt)">{{ t('common.apply') }}</button>
          <button @click="revertEdits(rt)">{{ t('results.revert') }}</button>
        </template>
      </div>
      <div v-if="rt" class="body">
        <div class="content">
          <ResultGrid v-if="rt.view === 'grid'" ref="grid" :ws="ws" :rt="rt" :filter="filter" @active-row="(r) => (formRow = r)" @view-count="(n) => (shown = n)" />
          <FormView v-else-if="rt.view === 'form'" v-model:row="formRow" :rt="rt" />
          <div v-else-if="rt.view === 'fields'" class="scroll">
            <table class="list selectable">
              <thead>
                <tr>
                  <th>#</th>
                  <th>{{ t('results.fields.field') }}</th>
                  <th>{{ t('results.fields.schema') }}</th>
                  <th>{{ t('results.fields.table') }}</th>
                  <th>{{ t('results.fields.type') }}</th>
                  <th>{{ t('results.fields.charset') }}</th>
                  <th>{{ t('results.fields.displaySize') }}</th>
                  <th>{{ t('results.fields.decimals') }}</th>
                  <th>{{ t('results.fields.flags') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(c, i) in rt.columns" :key="i">
                  <td>{{ i + 1 }}</td>
                  <td>{{ c.name }}</td>
                  <td>{{ c.schema }}</td>
                  <td>{{ c.orgTable || c.table }}</td>
                  <td>{{ c.type }}</td>
                  <td>{{ c.charset }}</td>
                  <td>{{ c.length }}</td>
                  <td>{{ c.decimals }}</td>
                  <td class="muted">{{ c.attributes }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-else-if="rt.view === 'stats'" class="scroll stats selectable">
            <h4>{{ t('results.stats.timing') }}</h4>
            <div class="form-grid">
              <label>{{ t('results.stats.queryDuration') }}</label><span>{{ formatDuration(rt.exec.durationMs) }}</span>
              <label>{{ t('results.stats.fetchDuration') }}</label><span>{{ formatDuration(rt.exec.fetchMs) }}</span>
            </div>
            <h4>{{ t('results.stats.rows') }}</h4>
            <div class="form-grid">
              <label>{{ t('results.stats.rowsReturned') }}</label><span>{{ rt.rows.length }}</span>
              <label>{{ t('results.stats.columns') }}</label><span>{{ rt.columns.length }}</span>
              <label>{{ t('results.stats.warnings') }}</label><span>{{ rt.exec.warnings.length }}</span>
            </div>
            <h4>{{ t('results.stats.statement') }}</h4>
            <pre class="mono">{{ rt.sql }}</pre>
          </div>
          <ExplainView v-else-if="rt.view === 'plan'" :ws="ws" :rt="rt" />
          <pre v-else-if="rt.view === 'text'" class="scroll text mono selectable">{{ rt.text }}</pre>
        </div>
        <div class="views">
          <button
            v-for="v in views"
            :key="v.id"
            class="view-btn"
            :class="{ active: rt.view === v.id }"
            :title="t(v.label)"
            @click="rt.view = v.id"
          >
            <component :is="v.icon" :size="22" :stroke-width="1.5" />
            <span>{{ t(v.label) }}</span>
          </button>
          <button v-if="rt.text" class="view-btn" :class="{ active: rt.view === 'text' }" @click="rt.view = 'text'">
            <ScrollText :size="22" :stroke-width="1.5" />
            <span>{{ t('results.view.text') }}</span>
          </button>
        </div>
      </div>
      <div class="footer muted">
        <span v-if="rt">{{
          rt.view === 'grid' && filter.trim()
            ? t(rt.limited ? 'results.footer.filteredLimited' : 'results.footer.filtered', { shown, count: total })
            : t(rt.limited ? 'results.footer.limited' : 'results.footer.rows', { count: total })
        }}</span>
        <span v-if="tab.lastError" class="failed">{{ t('results.footer.failed') }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.results {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg-content);
}

.filter {
  width: 180px;
  height: 22px;
}

.status {
  margin-right: 8px;
  font-size: var(--fs-small);
}

.body {
  flex: 1;
  min-height: 0;
  display: flex;
}

.content {
  flex: 1;
  min-width: 0;
  position: relative;
}

.views {
  width: 74px;
  border-left: 1px solid var(--border);
  background: var(--bg-panel);
  display: flex;
  flex-direction: column;
  padding: 4px;
  gap: 4px;
  overflow-y: auto;
}

.view-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 6px 2px;
  font-size: 10px;
  border: 1px solid transparent;
  background: transparent;
  border-radius: 5px;
  text-align: center;
  line-height: 1.15;
}

.view-btn.active {
  background: var(--bg-selected);
  border-color: var(--border);
}

.scroll {
  position: absolute;
  inset: 0;
  overflow: auto;
}

.stats {
  padding: 4px 16px;
}

.stats .form-grid {
  justify-content: start;
}

.text {
  margin: 0;
  padding: 8px;
  font-size: 12px;
}

.error {
  flex: 1;
  overflow: auto;
  padding: 8px 14px;
}

.error h4 {
  margin: 0 0 6px;
}

.error .message {
  color: var(--danger);
  white-space: pre-wrap;
}

.footer {
  height: 20px;
  padding: 0 8px;
  border-top: 1px solid var(--border);
  font-size: var(--fs-small);
  display: flex;
  align-items: center;
  background: var(--bg-panel);
}

.failed {
  margin-left: auto;
  color: var(--danger);
}
</style>
