<script setup lang="ts">
import { Pane, Splitpanes } from 'splitpanes'
import {
  ArrowLeftRight,
  CircleCheck,
  FolderOpen,
  Network,
  OctagonAlert,
  Pilcrow,
  Save,
  Search,
  Sparkles,
  Square,
  TextCursorInput,
  Undo2,
  WrapText,
  Zap
} from 'lucide-vue-next'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { t } from '@/i18n'
import { shortcut } from '@/shortcut'
import { monaco } from '@/editor/monaco'
import { registerModelOwner } from '@/editor/completion'
import { beautify } from '@/editor/sql-actions'
import { useApp } from '@/stores/app'
import { formatSeconds } from '@/workspace/format'
import type { QueryTab, Workspace } from '@/workspace/workspace'
import ResultsPanel from '../results/ResultsPanel.vue'
import MonacoEditor from './MonacoEditor.vue'

const props = defineProps<{ ws: Workspace; tab: QueryTab }>()
const app = useApp()

const limitOptions = [0, 10, 50, 100, 200, 300, 400, 500, 1000, 2000, 5000, 10000, 50000]
const limit = computed({
  get: () => app.settings.limitRows,
  set: (v: number) => void app.updateSettings({ limitRows: v })
})

// time since the execution started, refreshed every second while it runs
const elapsed = ref(0)
let ticker: ReturnType<typeof setInterval> | undefined
watch(
  () => props.tab.running,
  (running) => {
    clearInterval(ticker)
    if (!running) return
    const start = Date.now()
    elapsed.value = 0
    ticker = setInterval(() => (elapsed.value = Date.now() - start), 1000)
  },
  { immediate: true }
)
onBeforeUnmount(() => clearInterval(ticker))

function onReady(editor: monaco.editor.IStandaloneCodeEditor): void {
  // eslint-disable-next-line vue/no-mutating-props
  props.tab.editor = editor
  registerModelOwner(props.tab.model, props.ws)
  const { KeyMod, KeyCode } = monaco
  // addAction, not addCommand: a command's key binding is global and runs on the last editor created
  const bind = (id: string, label: string, keybinding: number, run: () => void): void =>
    void editor.addAction({ id: `dbm.${id}`, label, keybindings: [keybinding], run })
  bind('executeCurrent', t('editor.action.executeCurrent'), KeyMod.CtrlCmd | KeyCode.Enter, () => void props.ws.execute(props.tab, 'current'))
  bind('executeAll', t('editor.action.executeAll'), KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.Enter, () => void props.ws.execute(props.tab, 'all'))
  bind('executeVertical', t('editor.action.executeVertical'), KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.Enter, () => void props.ws.execute(props.tab, 'vertical'))
  bind('explain', t('editor.action.explain'), KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyX, () => void props.ws.execute(props.tab, 'explain'))
  bind('beautify', t('editor.action.beautify'), KeyMod.CtrlCmd | KeyCode.KeyB, () => beautify(editor, props.ws.dialect, props.ws.info))
  bind('findReplace', t('editor.action.findReplace'), KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyF, () => void editor.getAction('editor.action.startFindReplaceAction')?.run())
  editor.focus()
}

const run = (mode: 'all' | 'current' | 'explain'): void => void props.ws.execute(props.tab, mode)
const action = (id: string): void => void props.tab.editor?.getAction(id)?.run()
</script>

<template>
  <div class="query-editor">
    <div class="toolbar">
      <button
        class="icon-btn"
        :title="t('editor.toolbar.open')"
        :aria-label="t('editor.toolbar.open')"
        @click="ws.openScript()"
      >
        <FolderOpen :size="15" />
      </button>
      <button class="icon-btn" :title="t('editor.toolbar.save')" :aria-label="t('editor.toolbar.save')" @click="ws.saveTab(tab)"><Save :size="15" /></button>
      <span class="sep" />
      <button
        class="icon-btn"
        :title="t('editor.toolbar.executeAll', { shortcut: shortcut('Cmd+Shift+Enter') })"
        :aria-label="t('editor.toolbar.executeAll', { shortcut: shortcut('Cmd+Shift+Enter') })"
        :disabled="ws.busy"
        @click="run('all')"
      >
        <Zap :size="15" />
      </button>
      <button
        class="icon-btn"
        :title="t('editor.toolbar.executeCurrent', { shortcut: shortcut('Cmd+Enter') })"
        :aria-label="t('editor.toolbar.executeCurrent', { shortcut: shortcut('Cmd+Enter') })"
        :disabled="ws.busy"
        @click="run('current')"
      >
        <TextCursorInput :size="15" />
      </button>
      <button
        class="icon-btn"
        :title="t('editor.toolbar.explain', { shortcut: shortcut('Cmd+Alt+X') })"
        :aria-label="t('editor.toolbar.explain', { shortcut: shortcut('Cmd+Alt+X') })"
        :disabled="ws.busy"
        @click="run('explain')"
      >
        <Network :size="15" />
      </button>
      <button class="icon-btn" :title="t('editor.toolbar.stop')" :aria-label="t('editor.toolbar.stop')" :disabled="!ws.busy" @click="ws.cancel()">
        <Square :size="14" />
      </button>
      <button
        class="icon-btn"
        :class="{ active: app.settings.stopOnError }"
        :title="t('editor.toolbar.stopOnError')"
        :aria-label="t('editor.toolbar.stopOnError')"
        @click="app.updateSettings({ stopOnError: !app.settings.stopOnError })"
      >
        <OctagonAlert :size="15" />
      </button>
      <span class="sep" />
      <button
        class="icon-btn"
        :title="t('editor.toolbar.commit')"
        :aria-label="t('editor.toolbar.commit')"
        :disabled="ws.autocommit || ws.busy"
        @click="ws.commit()"
      >
        <CircleCheck :size="15" />
      </button>
      <button
        class="icon-btn"
        :title="t('editor.toolbar.rollback')"
        :aria-label="t('editor.toolbar.rollback')"
        :disabled="ws.autocommit || ws.busy"
        @click="ws.rollback()"
      >
        <Undo2 :size="15" />
      </button>
      <button
        class="icon-btn"
        :class="{ active: ws.autocommit }"
        :title="t(ws.autocommit ? 'editor.toolbar.autocommitOn' : 'editor.toolbar.autocommitOff')"
        :aria-label="t(ws.autocommit ? 'editor.toolbar.autocommitOn' : 'editor.toolbar.autocommitOff')"
        :disabled="ws.busy"
        @click="ws.setAutocommit(!ws.autocommit)"
      >
        <ArrowLeftRight :size="15" />
      </button>
      <span v-if="!ws.autocommit" class="manual-commit">{{ t('editor.toolbar.manualCommit') }}</span>
      <span class="sep" />
      <select v-model.number="limit" :title="t('editor.toolbar.limit')">
        <option v-for="n in limitOptions" :key="n" :value="n">{{ n === 0 ? t('menu.query.dontLimit') : t('menu.query.limitTo', { count: n }) }}</option>
      </select>
      <span class="sep" />
      <button
        class="icon-btn"
        :title="t('editor.toolbar.beautify', { shortcut: shortcut('Cmd+B') })"
        :aria-label="t('editor.toolbar.beautify', { shortcut: shortcut('Cmd+B') })"
        @click="tab.editor && beautify(tab.editor, ws.dialect, ws.info)"
      >
        <Sparkles :size="15" />
      </button>
      <button
        class="icon-btn"
        :title="t('editor.toolbar.find', { shortcut: shortcut('Cmd+F') })"
        :aria-label="t('editor.toolbar.find', { shortcut: shortcut('Cmd+F') })"
        @click="action('actions.find')"
      >
        <Search :size="15" />
      </button>
      <button
        class="icon-btn"
        :class="{ active: app.settings.showInvisibles }"
        :title="t('editor.toolbar.invisibles')"
        :aria-label="t('editor.toolbar.invisibles')"
        @click="app.updateSettings({ showInvisibles: !app.settings.showInvisibles })"
      >
        <Pilcrow :size="15" />
      </button>
      <button
        class="icon-btn"
        :class="{ active: app.settings.wordWrap }"
        :title="t('editor.toolbar.wordWrap')"
        :aria-label="t('editor.toolbar.wordWrap')"
        @click="app.updateSettings({ wordWrap: !app.settings.wordWrap })"
      >
        <WrapText :size="15" />
      </button>
      <span class="spacer" />
      <span v-if="tab.running" class="running">{{ t('editor.executingFor', { time: formatSeconds(elapsed) }) }}</span>
    </div>
    <Splitpanes horizontal class="split">
      <Pane :size="48" :min-size="10">
        <MonacoEditor :model="tab.model" @ready="onReady" />
      </Pane>
      <Pane :size="52" :min-size="10">
        <ResultsPanel :ws="ws" :tab="tab" />
      </Pane>
    </Splitpanes>
  </div>
</template>

<style scoped>
.query-editor {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.split {
  flex: 1;
  min-height: 0;
}

.running {
  color: var(--accent);
  font-size: var(--fs-small);
  padding-right: 6px;
}

.manual-commit {
  color: var(--warning);
  font-size: var(--fs-small);
}
</style>
