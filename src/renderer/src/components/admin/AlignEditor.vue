<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { ArrowRight, X } from 'lucide-vue-next'
import type { AlignObjectDiff, AlignObjectRef, AlignOptions, AlignRequest, Alignment } from '@shared/types'
import type { Workspace } from '@/workspace/workspace'
import { alertError } from '@/dialogs'
import { t } from '@/i18n'
import { environmentLabel } from '@/stores/app'
import { alignConnection, alignConnections, alignSide, chooseSide, closeSide, defaultAlignOptions, saveNewAlignment, type AlignSide, type AlignmentFields } from './align-sessions'
import { actionLabels, kindLabels, noteText, recreatesTable, runAlignment, statusLabels } from './align-run'
import { useToolJob } from './tool-job'

/**
 * Editor of an alignment (MySQL/MariaDB): source and target, options, the
 * comparison of every object with the choice of those to align, Save and Apply.
 * `draft.objects`: a list = exactly those objects, null = all of them, absent =
 * a new alignment (the different objects and those only in the source are chosen).
 */
const props = defineProps<{ ws: Workspace; draft: Partial<Alignment>; compare?: boolean }>()
const emit = defineEmits<{ saved: [alignment: Alignment]; close: [] }>()

const connections = computed(() => alignConnections(props.ws))

// --- source and target --------------------------------------------------------

const source = alignSide(props.ws, props.draft.source)
const target = alignSide(props.ws, props.draft.target)
const choose = (side: AlignSide, connectionId: string): Promise<void> => chooseSide(props.ws, side, connectionId)

const configOf = (end: AlignSide) => alignConnection(props.ws, end.connectionId)
const ends = [
  { end: source, side: 'source' as const },
  { end: target, side: 'target' as const }
]

// --- options ------------------------------------------------------------------

const options = reactive<AlignOptions>({ ...defaultAlignOptions, ...props.draft.options })

// --- choice of the objects ----------------------------------------------------

interface Choice {
  ref: AlignObjectRef
  /** An object only in the target: checked, it is dropped. */
  drop: boolean
  on: boolean
}

const keyOf = (o: AlignObjectRef): string => `${o.kind}\u0000${o.name}`
/** Every object decided so far, also those of the draft that the comparison no longer shows. */
const choices = reactive(new Map<string, Choice>())
for (const o of props.draft.objects ?? []) choices.set(keyOf(o), { ref: { kind: o.kind, name: o.name }, drop: false, on: true })
for (const o of props.draft.drop ?? []) choices.set(keyOf(o), { ref: { kind: o.kind, name: o.name }, drop: true, on: true })
const allObjects = ref(props.draft.objects === null)

/** A new alignment chooses what differs; an alignment with a list keeps exactly its list. */
const chosenByDefault = (o: AlignObjectDiff): boolean => props.draft.objects === undefined && (o.status === 'different' || o.status === 'sourceOnly')

/** The objects of a comparison not decided yet get their default; the others keep the user's choice. */
function adopt(objects: AlignObjectDiff[]): void {
  for (const o of objects) {
    const c = choices.get(keyOf(o))
    const drop = o.status === 'targetOnly'
    // an object of the list gone from the source must not turn into a drop, nor a drop into a copy
    if (c && c.drop !== drop) Object.assign(c, { drop, on: false })
    else if (!c) choices.set(keyOf(o), { ref: { kind: o.kind, name: o.name }, drop, on: chosenByDefault(o) })
  }
}

/** "All objects" includes every object of the source; only those of the target are chosen one by one. */
const fixed = (o: AlignObjectDiff): boolean => allObjects.value && o.status !== 'targetOnly'
const isChecked = (o: AlignObjectDiff): boolean => fixed(o) || !!choices.get(keyOf(o))?.on

function setChecked(o: AlignObjectDiff, on: boolean): void {
  const c = choices.get(keyOf(o))
  if (c) c.on = on
}

/** Plain objects, as IPC takes them (not the reactive proxies of `choices`). */
const chosenRefs = (drop: boolean): AlignObjectRef[] =>
  [...choices.values()].filter((c) => c.on && c.drop === drop).map((c) => ({ kind: c.ref.kind, name: c.ref.name }))
const objects = computed<AlignObjectRef[] | null>(() => (allObjects.value ? null : chosenRefs(false)))
const drop = computed<AlignObjectRef[]>(() => chosenRefs(true))

// --- comparison ---------------------------------------------------------------

const compareTool = useToolJob()
const applyTool = useToolJob()
const preview = computed(() => compareTool.job.preview)
/** The job whose state the footer shows: the latest one started. */
const shown = ref<'compare' | 'apply'>('compare')
const shownJob = computed(() => (shown.value === 'compare' ? compareTool.job : applyTool.job))
const busy = computed(() => compareTool.job.running || applyTool.job.running)
const hideSame = ref(true)
const selected = ref('')
const logEl = ref<HTMLElement>()

/** What the comparison depends on: a change makes it out of date for Apply. */
const basis = computed(() => JSON.stringify([source.connectionId, source.schema, target.connectionId, target.schema, options]))
const comparedBasis = ref('')
const stale = computed(() => !!preview.value && comparedBasis.value !== basis.value)

const ready = computed(() => !!source.session && !!target.session && !!source.schema && !!target.schema)

const request = (objects: AlignObjectRef[] | null, drop: AlignObjectRef[]): AlignRequest => ({
  source: { sessionId: source.session!.sessionId, schema: source.schema },
  target: { sessionId: target.session!.sessionId, schema: target.schema },
  objects,
  drop,
  options: { ...options }
})

async function compare(): Promise<void> {
  if (!ready.value || busy.value) return
  shown.value = 'compare'
  const at = basis.value
  await compareTool.start(() => window.api.tools.alignCompare(request(null, [])))
  if (!compareTool.job.preview) return
  comparedBasis.value = at
  adopt(compareTool.job.preview.objects)
  if (!rows.value.some((o) => keyOf(o) === selected.value)) selected.value = rows.value[0] ? keyOf(rows.value[0]) : ''
}

const rows = computed(() => (preview.value?.objects ?? []).filter((o) => !hideSame.value || o.status !== 'same'))
const sameCount = computed(() => (preview.value?.objects ?? []).filter((o) => o.status === 'same').length)
const selectedDiff = computed(() => preview.value?.objects.find((o) => keyOf(o) === selected.value))

const choosable = computed(() => rows.value.filter((o) => !fixed(o)))
const allChecked = computed(() => choosable.value.length > 0 && choosable.value.every(isChecked))
function checkAll(on: boolean): void {
  for (const o of choosable.value) setChecked(o, on)
}

/** The action Apply takes on a row, or none when the row is not chosen. */
function rowAction(o: AlignObjectDiff): string {
  if (!isChecked(o)) return t('admin.align.notChosen')
  if (o.status === 'targetOnly') return t(actionLabels[options.structure ? 'drop' : 'skip'])
  return t(actionLabels[o.action])
}

/** recreate and replaceRows count all the rows of the two sides. */
const replacesRows = (o: AlignObjectDiff): boolean => o.action === 'recreate' || o.action === 'replaceRows'

const acting = (o: AlignObjectDiff): boolean =>
  isChecked(o) && (o.status === 'targetOnly' ? options.structure : o.status !== 'same' && o.action !== 'none' && o.action !== 'skip')
const totals = computed(() => {
  const list = (preview.value?.objects ?? []).filter(acting)
  const sum = (k: 'insert' | 'update' | 'delete'): number => list.reduce((n, o) => n + (o.action === 'syncRows' ? (o.rows?.[k] ?? 0) : 0), 0)
  return { count: list.length, insert: sum('insert'), update: sum('update'), delete: sum('delete') }
})

// --- detail of the selected object --------------------------------------------

/** Lines of `text` missing from `other`, marked in the side-by-side definitions. */
type SampleRow = NonNullable<AlignObjectDiff['sample']>['rows'][number]
const values = (r: SampleRow, side: 'source' | 'target'): (string | null)[] | undefined => (side === 'source' ? r.source : r.target)
/** A cell of the sample; a row the side lacks (an insert on the target, a delete on the source) is empty. */
const cellText = (v: (string | null)[] | undefined, k: number): string => (v ? (v[k] ?? 'NULL') : '')

function lines(text: string | undefined, other: string | undefined): { text: string; marked: boolean }[] {
  if (text === undefined) return []
  const theirs = new Set((other ?? '').split('\n'))
  return text.split('\n').map((l) => ({ text: l, marked: !theirs.has(l) }))
}

// --- save and apply -------------------------------------------------------------

const savedId = ref(props.draft.id)
const savedName = ref(props.draft.name ?? '')
const canSave = computed(() => !!source.connectionId && !!source.schema && !!target.connectionId && !!target.schema && (allObjects.value || objects.value!.length + drop.value.length > 0))
/** The job's progress and errors and the outcome of Apply; after a comparison, the totals of what is chosen. */
const statusText = computed(() => {
  const j = shownJob.value
  if (j.running || j.error || (shown.value === 'apply' && j.message)) return j.message
  return preview.value ? t('admin.align.totals', totals.value) : t('admin.align.pressCompare')
})
const canApply = computed(() => ready.value && !busy.value && !!preview.value && !stale.value && totals.value.count > 0)

const fields = (): AlignmentFields => ({
  source: { connectionId: source.connectionId, schema: source.schema },
  target: { connectionId: target.connectionId, schema: target.schema },
  objects: objects.value,
  drop: drop.value,
  options: { ...options }
})

function saved(a: Alignment): void {
  savedId.value = a.id
  savedName.value = a.name
  emit('saved', a)
}

async function save(): Promise<void> {
  if (!savedId.value) {
    const a = await saveNewAlignment(fields())
    if (a) saved(a)
    return
  }
  const id = savedId.value
  const name = savedName.value
  try {
    // the runs recorded by the main since the editor opened are kept
    const stored = (await window.api.alignments.list()).find((a) => a.id === id)
    const alignment: Alignment = { ...fields(), id, name, runs: stored?.runs ?? [] }
    await window.api.alignments.save(alignment)
    saved(alignment)
  } catch (err) {
    await alertError(t('admin.align.saveFailed', { name }), (err as Error).message)
  }
}

async function apply(): Promise<void> {
  if (!canApply.value) return
  const seen = preview.value!.objects
  const recreated = seen.filter((o) => o.action === 'recreate' && isChecked(o))
  // the comparison ran without drops: a checked object only in the target is dropped when Structure is chosen
  const dropped = seen.filter((o) => o.status === 'targetOnly' && isChecked(o))
  const r: AlignRequest = {
    ...request(objects.value, drop.value),
    // confirmed by the question of runAlignment, asked before the job starts
    confirmed: {
      recreate: recreated.map((o) => ({ kind: o.kind, name: o.name })),
      drop: dropped.map((o) => ({ kind: o.kind, name: o.name }))
    },
    alignmentId: savedId.value
  }
  const ask = { recreate: recreated.filter(recreatesTable), drop: options.structure ? dropped : [] }
  shown.value = 'apply'
  const end = await runAlignment(props.ws, r, target.connectionId, applyTool, ask)
  // the target changed: the comparison no longer describes it
  if (end && !end.error) comparedBasis.value = ''
}

function cancel(): void {
  void (shown.value === 'compare' ? compareTool : applyTool).cancel()
}

watch(
  () => shownJob.value.log,
  () => nextTick(() => logEl.value && (logEl.value.scrollTop = logEl.value.scrollHeight))
)

defineExpose({ busy })

onMounted(async () => {
  await Promise.all([choose(source, source.connectionId), choose(target, target.connectionId)])
  if (props.compare) await compare()
})

onUnmounted(() => {
  closeSide(source)
  closeSide(target)
})
</script>

<template>
  <div class="page align-editor">
    <div class="page-header">
      {{ savedName || t('admin.align.newAlignment') }}
      <span class="spacer" />
      <button class="icon-btn" :title="t('admin.align.backToList')" :aria-label="t('admin.align.backToList')" :disabled="busy" @click="emit('close')"><X :size="14" /></button>
    </div>

    <div class="bar">
      <div class="ends">
        <span v-for="{ end, side } in ends" :key="side" class="end">
          <span class="label">{{ t(side === 'source' ? 'admin.align.source' : 'admin.align.target') }}</span>
          <span v-if="configOf(end)?.environment" class="env-badge" :class="`env-${configOf(end)!.environment}`">{{ environmentLabel(configOf(end)!.environment!) }}</span>
          <select :value="end.connectionId" :aria-label="t(side === 'source' ? 'admin.align.sourceConnection' : 'admin.align.targetConnection')" :disabled="busy" @change="choose(end, ($event.target as HTMLSelectElement).value)">
            <option value="">{{ t('admin.copy.chooseConnection') }}</option>
            <option v-for="c in connections" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
          <select v-model="end.schema" :aria-label="t(side === 'source' ? 'admin.align.sourceSchema' : 'admin.align.targetSchema')" :disabled="busy">
            <option value="" disabled>{{ t('admin.align.chooseSchema') }}</option>
            <option v-for="s in end.schemas" :key="s" :value="s">{{ s }}</option>
          </select>
          <ArrowRight v-if="side === 'source'" :size="16" class="arrow" />
        </span>
      </div>
      <div class="row">
        <label class="check"><input v-model="options.structure" type="checkbox" /> {{ t('admin.align.structure') }}</label>
        <label class="check"><input v-model="options.data" type="checkbox" /> {{ t('admin.align.data') }}</label>
        <label class="check"><input v-model="options.deleteRows" type="checkbox" :disabled="!options.data" /> {{ t('admin.align.deleteRows') }}</label>
        <label class="check"><input v-model="options.backup" type="checkbox" /> {{ t('admin.align.backup') }}</label>
        <label for="al-definers" class="label">{{ t('admin.copy.definers') }}</label>
        <select id="al-definers" v-model="options.definers">
          <option value="keep">{{ t('admin.copy.keepDefiners') }}</option>
          <option value="remove">{{ t('admin.copy.removeDefiners') }}</option>
        </select>
        <span class="spacer" />
        <button class="primary" :disabled="!ready || busy" @click="compare">{{ preview ? t('admin.align.compareAgain') : t('admin.align.compare') }}</button>
      </div>
    </div>

    <div v-if="!preview" class="empty-state">{{ compareTool.job.running ? compareTool.job.message : t('admin.align.chooseThenCompare') }}</div>
    <template v-else>
      <div class="row filters">
        <label class="check"><input v-model="hideSame" type="checkbox" /> {{ t('admin.align.hideSame', { count: sameCount }) }}</label>
        <label class="check"><input v-model="allObjects" type="checkbox" /> {{ t('admin.align.allObjects') }}</label>
        <span v-if="stale" class="warning">{{ t('admin.align.stale') }}</span>
      </div>
      <ul v-if="preview.warnings.length" class="warnings">
        <li v-for="(w, i) in preview.warnings" :key="i" class="warning selectable">{{ noteText(w) }}</li>
      </ul>
      <div class="box objects">
        <table class="list">
          <thead>
            <tr>
              <th class="check-col">
                <input type="checkbox" :checked="allChecked" :disabled="!choosable.length" :aria-label="t('admin.align.chooseAll')" @change="checkAll(($event.target as HTMLInputElement).checked)" />
              </th>
              <th>{{ t('admin.align.object') }}</th>
              <th>{{ t('admin.align.type') }}</th>
              <th>{{ t('admin.align.status') }}</th>
              <th>{{ t('admin.align.action') }}</th>
              <th class="notes-col">{{ t('admin.align.structureNotes') }}</th>
              <th class="num">{{ t('admin.align.newRows') }}</th>
              <th class="num">{{ t('admin.align.changedRows') }}</th>
              <th class="num">{{ t('admin.align.onlyInTarget') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="o in rows" :key="keyOf(o)" :class="{ selected: keyOf(o) === selected }" @click="selected = keyOf(o)">
              <td class="check-col">
                <input
                  type="checkbox"
                  :checked="isChecked(o)"
                  :disabled="fixed(o)"
                  :aria-label="t(o.status === 'targetOnly' ? 'admin.align.dropObject' : 'admin.align.alignObject', { name: o.name })"
                  @click.stop
                  @change="setChecked(o, ($event.target as HTMLInputElement).checked)"
                />
              </td>
              <td>{{ o.name }}</td>
              <td class="muted">{{ t(kindLabels[o.kind]) }}</td>
              <td><span class="pill" :class="`st-${o.status}`">{{ t(statusLabels[o.status]) }}</span></td>
              <td :class="{ muted: !isChecked(o) }">{{ rowAction(o) }}</td>
              <td class="notes-col" :class="o.notes.length ? 'warning' : 'muted'" :title="o.notes.map(noteText).join('\n')">
                {{ o.notes.length ? o.notes.map(noteText).join('; ') : '—' }}
              </td>
              <td v-if="o.rows && replacesRows(o)" colspan="3" class="num muted">{{ t('admin.align.rowsReplaced', { source: o.rows.insert, target: o.rows.delete }) }}</td>
              <template v-else>
                <td class="num"><span v-if="o.rows?.insert" class="added">+{{ o.rows.insert }}</span></td>
                <td class="num"><span v-if="o.rows?.update" class="changed">~{{ o.rows.update }}</span></td>
                <td class="num"><span v-if="o.rows?.delete" :class="options.deleteRows ? 'deleted' : 'muted'">{{ o.rows.delete }}</span></td>
              </template>
            </tr>
          </tbody>
        </table>
        <div v-if="!rows.length" class="empty-state">{{ t('admin.align.nothingDiffers') }}</div>
      </div>

      <div v-if="selectedDiff" class="detail">
        <div v-for="side in ['source', 'target'] as const" :key="side" class="side">
          <h3>{{ t(side === 'source' ? 'admin.align.detailSource' : 'admin.align.detailTarget', { name: selectedDiff.name }) }}</h3>
          <table v-if="selectedDiff.sample" class="list sample selectable">
            <thead>
              <tr>
                <th v-for="c in selectedDiff.sample.columns" :key="c">{{ c }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in selectedDiff.sample.rows" :key="i" :class="{ added: side === 'source' && r.kind === 'insert', deleted: side === 'target' && r.kind === 'delete' }">
                <td v-for="(c, k) in selectedDiff.sample.columns" :key="c" :class="{ changed: r.changed?.includes(k), null: values(r, side)?.[k] === null }">
                  {{ cellText(values(r, side), k) }}
                </td>
              </tr>
            </tbody>
          </table>
          <pre v-else-if="selectedDiff.ddl?.[side] !== undefined" class="ddl selectable"><span
              v-for="(l, i) in lines(selectedDiff.ddl[side], selectedDiff.ddl[side === 'source' ? 'target' : 'source'])"
              :key="i"
              :class="{ added: l.marked && side === 'source', deleted: l.marked && side === 'target' }"
              class="line"
            >{{ l.text }}
</span></pre>
          <p v-else class="hint muted">{{ t('admin.align.noDetail') }}</p>
        </div>
      </div>
    </template>

    <div class="foot">
      <div class="row">
        <span class="status" :class="{ error: shownJob.error }" :title="statusText">{{ statusText }}</span>
        <button v-if="busy" @click="cancel">{{ t('common.cancel') }}</button>
        <button :disabled="!canSave || busy" @click="save">{{ t('common.save') }}</button>
        <button class="primary" :disabled="!canApply" @click="apply">{{ t('admin.align.apply') }}</button>
      </div>
      <progress v-if="shownJob.running" :value="shownJob.progress >= 0 ? shownJob.progress : undefined" max="1" />
      <pre v-if="shown === 'apply' && shownJob.log" ref="logEl" class="log selectable">{{ shownJob.log }}</pre>
    </div>
  </div>
</template>

<style scoped>
.spacer {
  flex: 1;
}

.error {
  color: var(--danger);
}

.warning {
  color: var(--warning);
}

.bar {
  display: grid;
  gap: 8px;
  padding: 8px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}

.ends {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
}

.end {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.arrow {
  margin-left: 8px;
  color: var(--text-muted);
}

.row {
  display: flex;
  align-items: center;
  gap: 8px 14px;
  flex-wrap: wrap;
}

.label {
  color: var(--text-muted);
}

.env-badge {
  padding: 0 5px;
  border-radius: 3px;
  background: var(--env);
  color: var(--env-text);
  font-size: var(--fs-small);
  font-weight: 600;
}

.filters {
  padding: 4px 14px;
  border-bottom: 1px solid var(--border);
}

.warnings {
  margin: 0;
  padding: 4px 14px 4px 30px;
  border-bottom: 1px solid var(--border);
  font-size: var(--fs-small);
}

.box {
  position: relative;
  overflow: auto;
  background: var(--bg-content);
}

.objects {
  flex: 1;
  min-height: 120px;
  border-bottom: 1px solid var(--border);
}

.box .empty-state {
  position: absolute;
  inset: 32px 0 0;
  height: auto;
}

.check-col {
  width: 24px;
}

table.list td.check-col,
table.list th.check-col {
  padding-right: 0;
}

table.list tbody tr {
  cursor: default;
}

table.list tbody tr:hover:not(.selected) td {
  background: var(--bg-hover);
}

table.list .num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.notes-col {
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pill {
  display: inline-block;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 8px;
  font-size: var(--fs-small);
}

.pill.st-different {
  border-color: var(--warning);
  color: var(--warning);
}

.pill.st-sourceOnly {
  border-color: var(--success);
  color: var(--success);
}

.pill.st-targetOnly {
  border-color: var(--danger);
  color: var(--danger);
}

span.added {
  color: var(--success);
}

span.changed {
  color: var(--warning);
}

span.deleted {
  color: var(--danger);
}

.detail {
  display: grid;
  grid-template-columns: 1fr 1fr;
  height: 200px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--border);
}

.side {
  min-width: 0;
  overflow: auto;
  padding: 6px 10px;
}

.side + .side {
  border-left: 1px solid var(--border);
}

h3 {
  margin: 0 0 6px;
  font-size: var(--fs);
  font-weight: 600;
}

.ddl {
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-small);
}

.ddl .line {
  display: block;
}

.ddl .line.added,
.sample tr.added td {
  background: var(--added);
}

.ddl .line.deleted,
.sample tr.deleted td {
  background: var(--deleted);
}

.sample td.changed {
  background: var(--modified);
}

.sample td.null {
  color: var(--null);
}

.hint {
  margin: 0;
  font-size: var(--fs-small);
}

.foot {
  display: grid;
  gap: 6px;
  padding: 8px 14px;
  background: var(--bg-panel);
  flex-shrink: 0;
}

.status {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

progress {
  width: 100%;
  height: 8px;
  accent-color: var(--accent);
}

.log {
  height: 100px;
  margin: 0;
  padding: 6px 8px;
  overflow: auto;
  border: 1px solid var(--border);
  background: var(--bg-content);
  font-family: var(--font-mono);
  font-size: var(--fs-small);
  white-space: pre-wrap;
}
</style>
