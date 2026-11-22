<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { ArrowRight, Check, CircleQuestionMark, Copy, Plus, X } from 'lucide-vue-next'
import type { AlignEnd, Alignment } from '@shared/types'
import type { Workspace } from '@/workspace/workspace'
import { alertError, confirm } from '@/dialogs'
import { formatLocale, t } from '@/i18n'
import { environmentLabel } from '@/stores/app'
import type { AdminTab } from './admin'
import AlignEditor from './AlignEditor.vue'
import { alignConnection, openSessionFor, type AlignSession } from './align-sessions'
import { kindLabels, noteText, runAlignment } from './align-run'
import { useToolJob } from './tool-job'

/**
 * Alignments (MySQL/MariaDB): the saved alignments with their runs, run again
 * from here; New, Edit and Compare open the editor in the page.
 */
const props = defineProps<{ ws: Workspace; tab: AdminTab }>()

const alignments = ref<Alignment[]>([])
const selectedId = ref('')
const selected = computed(() => alignments.value.find((a) => a.id === selectedId.value))
/** The editor in place of the list; `key` makes a new editor for each opening. */
const editing = ref<{ draft: Partial<Alignment>; compare: boolean; key: number }>()
let editorSeq = 0

const tool = useToolJob()
const { job } = tool
/** The alignment the last Run Now was for, whose progress the detail shows. */
const runFor = ref('')
const logEl = ref<HTMLElement>()
const editor = ref<InstanceType<typeof AlignEditor>>()
/** Sessions of the running Run Now, closed when it ends or the page closes. */
let runSessions: AlignSession[] = []

async function reload(): Promise<void> {
  try {
    alignments.value = await window.api.alignments.list()
  } catch (err) {
    await alertError(t('admin.align.listFailed'), (err as Error).message)
  }
  if (!selected.value) selectedId.value = alignments.value[0]?.id ?? ''
}

const connectionName = (end: AlignEnd): string => alignConnection(props.ws, end.connectionId)?.name ?? t('admin.align.connectionMissing')
const environmentOf = (end: AlignEnd) => alignConnection(props.ws, end.connectionId)?.environment
const when = (at: number): string => new Date(at).toLocaleString(formatLocale())

/** The `dbknife` command is installed on macOS and Linux only. */
const showCommand = !navigator.userAgent.includes('Windows')
/** POSIX single quotes: the name pastes into sh/zsh as it is, quotes and spaces included. */
const shellQuote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`
const command = (a: Alignment): string => `dbknife --runjob ${shellQuote(a.name)}`
const copyCommand = (a: Alignment): Promise<void> => navigator.clipboard.writeText(command(a))
/** How to get the command in the PATH: the menu item on macOS, the .deb or a link to the AppImage on Linux. */
const commandHelp = (): Promise<number> =>
  window.api.ui.message({
    type: 'info',
    message: t('admin.align.commandHelpTitle'),
    detail: t(navigator.userAgent.includes('Macintosh') ? 'admin.align.commandHelpMac' : 'admin.align.commandHelpLinux'),
    buttons: [t('common.ok')]
  })

function edit(draft: Partial<Alignment>, compare = false): void {
  // a copy without the reactive proxies: the editor must not change the list
  editing.value = { draft: JSON.parse(JSON.stringify(draft)), compare, key: ++editorSeq }
}

async function onSaved(a: Alignment): Promise<void> {
  selectedId.value = a.id
  await reload()
}

async function closeEditor(): Promise<void> {
  editing.value = undefined
  await reload()
}

async function duplicate(a: Alignment): Promise<void> {
  const copy: Alignment = { ...(JSON.parse(JSON.stringify(a)) as Alignment), id: crypto.randomUUID(), name: t('admin.align.copyName', { name: a.name }), runs: [] }
  try {
    await window.api.alignments.save(copy)
    selectedId.value = copy.id
  } catch (err) {
    await alertError(t('admin.align.saveFailed', { name: copy.name }), (err as Error).message)
  }
  await reload()
}

async function remove(a: Alignment): Promise<void> {
  if (!(await confirm(t('admin.align.deleteConfirm', { name: a.name }), undefined, t('common.delete')))) return
  try {
    await window.api.alignments.remove(a.id)
    if (selectedId.value === a.id) selectedId.value = ''
  } catch (err) {
    await alertError(t('admin.align.deleteFailed', { name: a.name }), (err as Error).message)
  }
  await reload()
}

function closeRunSessions(): void {
  for (const s of runSessions) s.close()
  runSessions = []
}

async function runNow(shown: Alignment): Promise<void> {
  if (job.running) return
  // plain objects, as IPC takes them (not the reactive proxies of the list)
  const a = JSON.parse(JSON.stringify(shown)) as Alignment
  if (!alignConnection(props.ws, a.source.connectionId) || !alignConnection(props.ws, a.target.connectionId)) {
    await alertError(t('admin.align.connectionMissingFor', { name: a.name }))
    return
  }
  const source = await openSessionFor(props.ws, a.source.connectionId)
  if (!source) return
  runSessions.push(source)
  const target = a.target.connectionId === a.source.connectionId ? source : await openSessionFor(props.ws, a.target.connectionId)
  if (!target) return closeRunSessions()
  if (target !== source) runSessions.push(target)
  runFor.value = a.id
  try {
    await runAlignment(
      props.ws,
      {
        source: { sessionId: source.sessionId, schema: a.source.schema },
        target: { sessionId: target.sessionId, schema: a.target.schema },
        objects: a.objects,
        drop: a.drop,
        options: a.options,
        // the drops were chosen by who saved the alignment; recreations depend on the data of the moment
        confirmed: { recreate: [], drop: a.drop },
        alignmentId: a.id
      },
      a.target.connectionId,
      tool
    )
  } finally {
    closeRunSessions()
    await reload()
  }
}

watch(
  () => job.log,
  () => nextTick(() => logEl.value && (logEl.value.scrollTop = logEl.value.scrollHeight))
)

/** The draft the tab was opened with: the quick dialog's (compared at once) or a schema of the workspace. */
function openDraft(): void {
  if (props.tab.align) edit(props.tab.align, true)
  else if (props.tab.schema) edit({ source: { connectionId: props.ws.config.id, schema: props.tab.schema } })
}

onMounted(async () => {
  await reload()
  openDraft()
})

// opened again with the same draft, maybe after going back to the list; a running editor is left alone
watch(
  () => props.tab.reopened,
  () => {
    if (!editor.value?.busy) openDraft()
  }
)

onUnmounted(closeRunSessions)
</script>

<template>
  <AlignEditor v-if="editing" ref="editor" :key="editing.key" :ws="ws" :draft="editing.draft" :compare="editing.compare" @saved="onSaved" @close="closeEditor" />
  <div v-else class="page">
    <div class="page-header">{{ t('workspace.admin.align') }}</div>
    <div class="body">
      <div class="saved">
        <div class="new">
          <button class="primary" @click="edit({})"><Plus :size="12" /> {{ t('admin.align.newAlignment') }}</button>
        </div>
        <div class="items" role="listbox" :aria-label="t('workspace.admin.align')">
          <div
            v-for="a in alignments"
            :key="a.id"
            class="item"
            role="option"
            :aria-selected="a.id === selectedId"
            :class="{ selected: a.id === selectedId }"
            @click="selectedId = a.id"
          >
            <span class="name">{{ a.name }}</span>
            <span class="muted">{{ t('admin.align.route', { source: a.source.schema, connection: connectionName(a.target), target: a.target.schema }) }}</span>
            <span v-if="a.runs[0]" :class="a.runs[0].ok ? 'ok' : 'error'" class="last">
              <component :is="a.runs[0].ok ? Check : X" :size="12" /> {{ when(a.runs[0].at) }}
            </span>
            <span v-else class="muted last">{{ t('admin.align.neverRun') }}</span>
          </div>
          <div v-if="!alignments.length" class="empty-state">{{ t('admin.align.noAlignments') }}</div>
        </div>
      </div>

      <div v-if="selected" class="detail">
        <div class="row">
          <span class="title">{{ selected.name }}</span>
          <span class="spacer" />
          <button :disabled="job.running" @click="edit(selected)">{{ t('admin.align.edit') }}</button>
          <button :disabled="job.running" @click="duplicate(selected)">{{ t('admin.align.duplicate') }}</button>
          <button class="danger" :disabled="job.running" @click="remove(selected)">{{ t('common.delete') }}</button>
        </div>

        <div class="route">
          <template v-for="side in ['source', 'target'] as const" :key="side">
            <div class="end">
              <span class="label">{{ t(side === 'source' ? 'admin.align.source' : 'admin.align.target') }}</span>
              <span>
                <span v-if="environmentOf(selected[side])" class="env-badge" :class="`env-${environmentOf(selected[side])}`">{{ environmentLabel(environmentOf(selected[side])!) }}</span>
                {{ connectionName(selected[side]) }}
              </span>
              <span class="schema">{{ selected[side].schema }}</span>
            </div>
            <ArrowRight v-if="side === 'source'" :size="22" class="arrow" />
          </template>
        </div>

        <section>
          <h3>{{ selected.objects ? t('admin.align.objectsCount', { count: selected.objects.length }) : t('admin.align.allObjects') }}</h3>
          <div v-if="selected.objects?.length || selected.drop.length" class="chips">
            <span v-for="o in selected.objects ?? []" :key="`${o.kind}:${o.name}`" class="pill" :title="t(kindLabels[o.kind])">{{ o.name }}</span>
            <span v-for="o in selected.drop" :key="`drop:${o.kind}:${o.name}`" class="pill drop" :title="t(kindLabels[o.kind])">{{ t('admin.align.dropChip', { name: o.name }) }}</span>
          </div>
          <div class="chips options">
            <span v-if="selected.options.structure" class="pill">{{ t('admin.align.structure') }}</span>
            <span v-if="selected.options.data" class="pill">{{ t('admin.align.data') }}</span>
            <span v-if="selected.options.data && selected.options.deleteRows" class="pill">{{ t('admin.align.deleteRows') }}</span>
            <span v-if="selected.options.backup" class="pill">{{ t('admin.align.backup') }}</span>
            <span class="pill">{{ t(selected.options.definers === 'keep' ? 'admin.align.definersKeep' : 'admin.align.definersRemove') }}</span>
          </div>
        </section>

        <div class="row">
          <button class="primary" :disabled="job.running" @click="runNow(selected)">{{ t('admin.align.runNow') }}</button>
          <button :disabled="job.running" @click="edit(selected, true)">{{ t('admin.align.compare') }}</button>
        </div>

        <section v-if="showCommand">
          <h3>{{ t('admin.align.command') }}</h3>
          <div class="command">
            <code class="selectable">{{ command(selected) }}</code>
            <button class="icon-btn" :title="t('admin.align.copyCommand')" @click="copyCommand(selected)"><Copy :size="14" /></button>
            <button class="icon-btn" :title="t('admin.align.commandHelp')" @click="commandHelp"><CircleQuestionMark :size="14" /></button>
          </div>
          <p class="hint muted">{{ t('admin.align.commandHint') }}</p>
        </section>

        <section v-if="runFor === selected.id && job.message" class="progress-section">
          <div class="row">
            <span class="status" :class="{ error: job.error }" :title="job.message">{{ job.message }}</span>
            <button v-if="job.running" @click="tool.cancel">{{ t('common.cancel') }}</button>
          </div>
          <progress :value="job.progress >= 0 ? job.progress : undefined" max="1" />
          <ul v-if="job.preview?.warnings.length" class="warnings">
            <li v-for="(w, i) in job.preview.warnings" :key="i" class="selectable">{{ noteText(w) }}</li>
          </ul>
          <pre ref="logEl" class="log selectable">{{ job.log }}</pre>
        </section>

        <section class="runs">
          <h3>{{ t('admin.align.runs') }}</h3>
          <div class="box">
            <table class="list">
              <thead>
                <tr>
                  <th>{{ t('admin.align.runAt') }}</th>
                  <th>{{ t('admin.align.runVia') }}</th>
                  <th>{{ t('admin.align.runResult') }}</th>
                  <th>{{ t('admin.align.runMessage') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(r, i) in selected.runs" :key="i">
                  <td>{{ when(r.at) }}</td>
                  <td class="muted">{{ t(r.via === 'cli' ? 'admin.align.viaCli' : 'admin.align.viaApp') }}</td>
                  <td :class="r.ok ? 'ok' : 'error'">{{ t(r.ok ? 'admin.align.succeeded' : 'admin.align.failed') }}</td>
                  <td class="message selectable" :title="r.message">{{ r.message }}</td>
                </tr>
              </tbody>
            </table>
            <div v-if="!selected.runs.length" class="empty-state">{{ t('admin.align.noRuns') }}</div>
          </div>
        </section>
      </div>
      <div v-else class="detail empty-state">{{ t('admin.align.pressNew') }}</div>
    </div>
  </div>
</template>

<style scoped>
.spacer {
  flex: 1;
}

.ok {
  color: var(--success);
}

.error {
  color: var(--danger);
}

.body {
  flex: 1;
  display: flex;
  min-height: 0;
}

.saved {
  width: 260px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  background: var(--bg-panel);
}

.new {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}

.new button {
  width: 100%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
}

.items {
  position: relative;
  flex: 1;
  overflow: auto;
}

.item {
  display: grid;
  gap: 2px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}

.item.selected {
  background: var(--bg-selected);
}

.item .name {
  font-weight: 600;
}

.item .last {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--fs-small);
}

.items .empty-state {
  position: absolute;
  inset: 0;
  height: auto;
  padding: 0 12px;
  text-align: center;
}

.detail {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 14px 18px;
  overflow: auto;
}

.detail.empty-state {
  height: auto;
}

.row {
  display: flex;
  align-items: center;
  gap: 8px 14px;
  flex-wrap: wrap;
}

.title {
  font-size: 15px;
  font-weight: 600;
}

.route {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 14px;
}

.route .arrow {
  color: var(--text-muted);
}

.end {
  display: grid;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-panel);
}

.end .label {
  font-size: var(--fs-small);
  color: var(--text-muted);
}

.end .schema {
  font-size: 14px;
  font-weight: 600;
}

.env-badge {
  margin-right: 4px;
  padding: 0 5px;
  border-radius: 3px;
  background: var(--env);
  color: var(--env-text);
  font-size: var(--fs-small);
  font-weight: 600;
}

section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

h3 {
  margin: 0;
  font-size: var(--fs);
  font-weight: 600;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.pill {
  display: inline-block;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: var(--fs-small);
}

.pill.drop {
  border-color: var(--danger);
  color: var(--danger);
}

.options .pill {
  background: var(--bg-panel);
  color: var(--text-muted);
}

.status {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.command {
  display: flex;
  align-items: center;
  gap: 6px;
}

.command code {
  flex: 1;
  min-width: 0;
  padding: 4px 8px;
  overflow-x: auto;
  border: 1px solid var(--border);
  background: var(--bg-panel);
  font-family: var(--font-mono);
  font-size: var(--fs-small);
  white-space: nowrap;
}

.hint {
  margin: 0;
  font-size: var(--fs-small);
}

progress {
  width: 100%;
  height: 8px;
  accent-color: var(--accent);
}

.warnings {
  margin: 0;
  padding-left: 18px;
  color: var(--warning);
  font-size: var(--fs-small);
}

.log {
  height: 120px;
  margin: 0;
  padding: 6px 8px;
  overflow: auto;
  border: 1px solid var(--border);
  background: var(--bg-panel);
  font-family: var(--font-mono);
  font-size: var(--fs-small);
  white-space: pre-wrap;
}

.runs {
  flex: 1;
  min-height: 120px;
}

.box {
  position: relative;
  flex: 1;
  min-height: 80px;
  overflow: auto;
  border: 1px solid var(--border);
  background: var(--bg-content);
}

.box .empty-state {
  position: absolute;
  inset: 24px 0 0;
  height: auto;
}

td.message {
  max-width: 480px;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
