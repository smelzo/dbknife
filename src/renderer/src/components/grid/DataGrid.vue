<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

export interface GridColumn {
  name: string
  align?: 'left' | 'right'
  width?: number
  title?: string
}

export interface GridCell {
  text: string
  cls?: string
}

export interface CellRange {
  r1: number
  r2: number
  c1: number
  c2: number
}

/**
 * Virtualized grid (rows and columns) with cell range selection, keyboard
 * navigation, column resizing and inline editing. Data is pulled through
 * `cell(row, col)`; bump `version` to repaint after data changes.
 */
const props = withDefaults(
  defineProps<{
    columns: GridColumn[]
    rowCount: number
    cell: (row: number, col: number) => GridCell
    rowClass?: (row: number) => string
    version?: number
    editable?: boolean
    editText?: (row: number, col: number) => string
    sort?: { col: number; dir: 'asc' | 'desc' } | null
    rowNumbers?: boolean
  }>(),
  { version: 0, editable: false, sort: null, rowNumbers: true, rowClass: undefined, editText: undefined }
)

const emit = defineEmits<{
  edit: [row: number, col: number, text: string]
  sort: [col: number]
  activate: [row: number, col: number]
  contextmenu: [event: MouseEvent, row: number, col: number]
  'header-contextmenu': [event: MouseEvent, col: number]
  'delete-key': []
  'selection-change': [row: number, col: number]
}>()

const ROW_H = 22
const HEADER_H = 24
const gutterWidth = computed(() => (props.rowNumbers ? Math.max(36, String(props.rowCount).length * 8 + 16) : 0))

const scroller = ref<HTMLElement>()
const root = ref<HTMLElement>()
const scrollTop = ref(0)
const scrollLeft = ref(0)
const viewH = ref(300)
const viewW = ref(600)
const widths = ref<number[]>([])

// --- column widths ------------------------------------------------------------

let measureCtx: CanvasRenderingContext2D | null = null
function textWidth(text: string): number {
  measureCtx ??= document.createElement('canvas').getContext('2d')
  if (!measureCtx) return text.length * 7
  measureCtx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif'
  return measureCtx.measureText(text).width
}

function autoWidths(): void {
  const sample = Math.min(props.rowCount, 60)
  widths.value = props.columns.map((col, c) => {
    if (col.width) return col.width
    let w = textWidth(col.name) + 28
    for (let r = 0; r < sample; r++) w = Math.max(w, textWidth(props.cell(r, c).text.slice(0, 80)) + 16)
    return Math.round(Math.min(Math.max(w, 44), 340))
  })
}

watch(() => props.columns, autoWidths, { immediate: true })
watch(
  () => props.rowCount,
  (n, old) => {
    if (old === 0 && n > 0) autoWidths()
  }
)

const lefts = computed(() => {
  const out: number[] = []
  let x = 0
  for (const w of widths.value) {
    out.push(x)
    x += w
  }
  out.push(x)
  return out
})
const totalWidth = computed(() => gutterWidth.value + lefts.value[lefts.value.length - 1])

// --- virtual window -------------------------------------------------------------

const firstRow = computed(() => Math.max(0, Math.floor(scrollTop.value / ROW_H) - 5))
const lastRow = computed(() => Math.min(props.rowCount, Math.ceil((scrollTop.value + viewH.value) / ROW_H) + 5))
const visibleRows = computed(() => {
  void props.version
  const out: number[] = []
  for (let r = firstRow.value; r < lastRow.value; r++) out.push(r)
  return out
})

const colRange = computed(() => {
  const l = lefts.value
  const left = scrollLeft.value
  const right = left + viewW.value
  let first = 0
  while (first < props.columns.length - 1 && l[first + 1] < left) first++
  let last = first
  while (last < props.columns.length && l[last] < right) last++
  return { first, last }
})
const visibleCols = computed(() => {
  const out: number[] = []
  for (let c = colRange.value.first; c < colRange.value.last; c++) out.push(c)
  return out
})
const padLeft = computed(() => lefts.value[colRange.value.first] ?? 0)

function onScroll(): void {
  const el = scroller.value!
  scrollTop.value = el.scrollTop
  scrollLeft.value = el.scrollLeft
}

let resizeObserver: ResizeObserver | undefined
onMounted(() => {
  resizeObserver = new ResizeObserver(() => {
    viewH.value = scroller.value!.clientHeight
    viewW.value = scroller.value!.clientWidth
  })
  resizeObserver.observe(scroller.value!)
})
onBeforeUnmount(() => resizeObserver?.disconnect())

// --- selection --------------------------------------------------------------------

const active = ref<{ r: number; c: number } | null>(null)
const anchor = ref<{ r: number; c: number } | null>(null)

const range = computed<CellRange | null>(() => {
  if (!active.value || !anchor.value) return null
  return {
    r1: Math.min(active.value.r, anchor.value.r),
    r2: Math.max(active.value.r, anchor.value.r),
    c1: Math.min(active.value.c, anchor.value.c),
    c2: Math.max(active.value.c, anchor.value.c)
  }
})

watch(
  () => props.rowCount,
  (n) => {
    if (active.value && active.value.r >= n) {
      active.value = anchor.value = n ? { r: n - 1, c: active.value.c } : null
    }
  }
)

const inRange = (r: number, c: number): boolean => {
  const g = range.value
  return !!g && r >= g.r1 && r <= g.r2 && c >= g.c1 && c <= g.c2
}
const rowInRange = (r: number): boolean => !!range.value && r >= range.value.r1 && r <= range.value.r2

function select(r: number, c: number, extend = false): void {
  if (!props.rowCount || !props.columns.length) return
  r = Math.max(0, Math.min(props.rowCount - 1, r))
  c = Math.max(0, Math.min(props.columns.length - 1, c))
  active.value = { r, c }
  if (!extend || !anchor.value) anchor.value = { r, c }
  emit('selection-change', r, c)
  scrollIntoView(r, c)
}

function selectRows(r1: number, r2: number): void {
  anchor.value = { r: r1, c: 0 }
  active.value = { r: r2, c: props.columns.length - 1 }
  emit('selection-change', r2, 0)
}

function scrollIntoView(r: number, c: number): void {
  const el = scroller.value
  if (!el) return
  const top = r * ROW_H
  const bodyH = el.clientHeight - HEADER_H
  if (top < el.scrollTop) el.scrollTop = top
  else if (top + ROW_H > el.scrollTop + bodyH) el.scrollTop = top + ROW_H - bodyH
  const left = lefts.value[c]
  const right = lefts.value[c + 1]
  const bodyW = el.clientWidth - gutterWidth.value
  if (left < el.scrollLeft) el.scrollLeft = left
  else if (right > el.scrollLeft + bodyW) el.scrollLeft = right - bodyW
}

let dragging = false
function onCellDown(e: MouseEvent, r: number, c: number): void {
  if (e.button !== 0) return
  commitEdit()
  root.value?.focus()
  select(r, c, e.shiftKey)
  dragging = true
  const up = (): void => {
    dragging = false
    window.removeEventListener('mouseup', up)
  }
  window.addEventListener('mouseup', up)
}

function onCellEnter(r: number, c: number): void {
  if (dragging) select(r, c, true)
}

function onGutterDown(e: MouseEvent, r: number): void {
  if (e.button !== 0) return
  commitEdit()
  root.value?.focus()
  if (e.shiftKey && anchor.value) selectRows(anchor.value.r, r)
  else selectRows(r, r)
}

function onCornerClick(): void {
  if (props.rowCount) selectRows(0, props.rowCount - 1)
}

function onContext(e: MouseEvent, r: number, c: number): void {
  e.preventDefault()
  if (!inRange(r, c)) select(r, c)
  emit('contextmenu', e, r, c)
}

function onDblClick(r: number, c: number): void {
  if (props.editable) startEdit(r, c)
  else emit('activate', r, c)
}

// --- editing -------------------------------------------------------------------------

const editing = ref<{ r: number; c: number; text: string } | null>(null)
const editor = ref<HTMLTextAreaElement>()

async function startEdit(r: number, c: number, initial?: string): Promise<void> {
  if (!props.editable) return
  select(r, c)
  editing.value = { r, c, text: initial ?? props.editText?.(r, c) ?? props.cell(r, c).text }
  await nextTick()
  editor.value?.focus()
  if (initial === undefined) editor.value?.select()
}

function commitEdit(): void {
  const e = editing.value
  if (!e) return
  editing.value = null
  emit('edit', e.r, e.c, e.text)
  root.value?.focus()
}

function cancelEdit(): void {
  editing.value = null
  root.value?.focus()
}

function onEditorKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault()
    cancelEdit()
  } else if (e.key === 'Enter' && !e.altKey && !e.shiftKey) {
    e.preventDefault()
    const { r, c } = editing.value!
    commitEdit()
    select(r + 1, c)
  } else if (e.key === 'Tab') {
    e.preventDefault()
    const { r, c } = editing.value!
    commitEdit()
    select(r, c + (e.shiftKey ? -1 : 1))
  }
  e.stopPropagation()
}

const editorStyle = computed(() => {
  const e = editing.value
  if (!e) return {}
  return {
    top: `${HEADER_H + e.r * ROW_H - scrollTop.value}px`,
    left: `${gutterWidth.value + lefts.value[e.c] - scrollLeft.value}px`,
    width: `${Math.max(widths.value[e.c], 120)}px`,
    height: e.text.includes('\n') ? `${ROW_H * 5}px` : `${ROW_H}px`
  }
})

// --- keyboard ----------------------------------------------------------------------------

function copyRange(): void {
  const g = range.value
  if (!g) return
  const lines: string[] = []
  for (let r = g.r1; r <= g.r2; r++) {
    const cells: string[] = []
    for (let c = g.c1; c <= g.c2; c++) cells.push(props.editText?.(r, c) ?? props.cell(r, c).text)
    lines.push(cells.join('\t'))
  }
  void navigator.clipboard.writeText(lines.join('\n'))
}

function onKey(e: KeyboardEvent): void {
  if (editing.value) return
  const a = active.value
  const meta = e.metaKey || e.ctrlKey
  if (meta && e.key.toLowerCase() === 'c') {
    e.preventDefault()
    copyRange()
    return
  }
  if (meta && e.key.toLowerCase() === 'a') {
    e.preventDefault()
    if (props.rowCount) {
      anchor.value = { r: 0, c: 0 }
      active.value = { r: props.rowCount - 1, c: props.columns.length - 1 }
    }
    return
  }
  if (!a) {
    if (['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(e.key)) select(0, 0)
    return
  }
  const page = Math.max(1, Math.floor((viewH.value - HEADER_H) / ROW_H) - 1)
  const moves: Record<string, [number, number]> = {
    ArrowDown: [meta ? props.rowCount : a.r + 1, a.c],
    ArrowUp: [meta ? 0 : a.r - 1, a.c],
    ArrowLeft: [a.r, meta ? 0 : a.c - 1],
    ArrowRight: [a.r, meta ? props.columns.length : a.c + 1],
    PageDown: [a.r + page, a.c],
    PageUp: [a.r - page, a.c],
    Home: [a.r, 0],
    End: [a.r, props.columns.length]
  }
  if (moves[e.key]) {
    e.preventDefault()
    select(moves[e.key][0], moves[e.key][1], e.shiftKey)
  } else if (e.key === 'Enter' || e.key === 'F2') {
    e.preventDefault()
    if (props.editable) void startEdit(a.r, a.c)
    else emit('activate', a.r, a.c)
  } else if (e.key === 'Tab') {
    e.preventDefault()
    select(a.r, a.c + (e.shiftKey ? -1 : 1))
  } else if ((e.key === 'Delete' || e.key === 'Backspace') && meta) {
    e.preventDefault()
    emit('delete-key')
  } else if (props.editable && e.key.length === 1 && !meta && !e.altKey) {
    e.preventDefault()
    void startEdit(a.r, a.c, e.key)
  }
}

// --- column resize ---------------------------------------------------------------------

function onResizeDown(e: MouseEvent, c: number): void {
  e.preventDefault()
  e.stopPropagation()
  const startX = e.clientX
  const startW = widths.value[c]
  const move = (ev: MouseEvent): void => {
    const next = [...widths.value]
    next[c] = Math.max(30, startW + ev.clientX - startX)
    widths.value = next
  }
  const up = (): void => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

function onHeaderClick(e: MouseEvent, c: number): void {
  if ((e.target as HTMLElement).classList.contains('resize')) return
  emit('sort', c)
}

defineExpose({
  range: (): CellRange | null => range.value,
  /** Rows touched by the selection (all rows of the range). */
  selectedRows: (): number[] => {
    const g = range.value
    if (!g) return []
    return Array.from({ length: g.r2 - g.r1 + 1 }, (_, i) => g.r1 + i)
  },
  active: () => active.value,
  select,
  startEdit,
  copyRange,
  resetWidths: autoWidths,
  focus: () => root.value?.focus(),
  scrollToTop: () => {
    if (scroller.value) scroller.value.scrollTop = 0
  }
})
</script>

<template>
  <div ref="root" class="grid" tabindex="0" @keydown="onKey">
    <div ref="scroller" class="scroller" @scroll="onScroll">
      <div class="canvas" :style="{ width: `${totalWidth}px`, height: `${HEADER_H + rowCount * ROW_H}px` }">
        <div class="hrow" :style="{ height: `${HEADER_H}px` }">
          <div v-if="rowNumbers" class="gutter corner" :style="{ width: `${gutterWidth}px` }" @click="onCornerClick" />
          <div :style="{ width: `${padLeft}px`, flex: 'none' }" />
          <div
            v-for="c in visibleCols"
            :key="c"
            class="hcell"
            :class="{ right: columns[c].align === 'right' }"
            :style="{ width: `${widths[c]}px` }"
            :title="columns[c].title ?? columns[c].name"
            @click="onHeaderClick($event, c)"
            @contextmenu.prevent="emit('header-contextmenu', $event, c)"
          >
            <span class="hname">{{ columns[c].name }}</span>
            <span v-if="sort && sort.col === c" class="sort">{{ sort.dir === 'asc' ? '▲' : '▼' }}</span>
            <span class="resize" @mousedown="onResizeDown($event, c)" />
          </div>
        </div>
        <div
          v-for="r in visibleRows"
          :key="r"
          class="row"
          :class="[rowClass?.(r), { odd: r % 2 === 1 }]"
          :style="{ transform: `translateY(${r * ROW_H}px)`, height: `${ROW_H}px` }"
        >
          <div
            v-if="rowNumbers"
            class="gutter"
            :class="{ sel: rowInRange(r) }"
            :style="{ width: `${gutterWidth}px` }"
            @mousedown="onGutterDown($event, r)"
          >
            {{ r + 1 }}
          </div>
          <div :style="{ width: `${padLeft}px`, flex: 'none' }" />
          <div
            v-for="c in visibleCols"
            :key="c"
            class="cell"
            :class="[
              props.cell(r, c).cls,
              {
                right: columns[c].align === 'right',
                sel: inRange(r, c),
                active: active && active.r === r && active.c === c
              }
            ]"
            :style="{ width: `${widths[c]}px` }"
            @mousedown="onCellDown($event, r, c)"
            @mouseenter="onCellEnter(r, c)"
            @dblclick="onDblClick(r, c)"
            @contextmenu="onContext($event, r, c)"
          >
            {{ props.cell(r, c).text }}
          </div>
        </div>
      </div>
    </div>
    <textarea
      v-if="editing"
      ref="editor"
      v-model="editing.text"
      class="cell-editor"
      :style="editorStyle"
      spellcheck="false"
      @keydown="onEditorKey"
      @blur="commitEdit"
    />
  </div>
</template>

<style scoped>
.grid {
  position: relative;
  height: 100%;
  width: 100%;
  outline: none;
  background: var(--bg-content);
  overflow: hidden;
}

.scroller {
  position: absolute;
  inset: 0;
  overflow: auto;
}

.canvas {
  position: relative;
}

.hrow {
  position: sticky;
  top: 0;
  z-index: 3;
  display: flex;
  background: var(--bg-header);
  border-bottom: 1px solid var(--border-strong);
}

.hcell {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 6px;
  font-weight: 600;
  border-right: 1px solid var(--border);
  overflow: hidden;
  white-space: nowrap;
}

.hcell.right {
  justify-content: flex-end;
}

.hname {
  overflow: hidden;
  text-overflow: ellipsis;
}

.sort {
  font-size: 8px;
  color: var(--text-muted);
}

.resize {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 5px;
  cursor: col-resize;
}

.row {
  position: absolute;
  top: 24px;
  left: 0;
  display: flex;
  min-width: 100%;
}

.row.odd {
  background: var(--bg-alt-row);
}

.gutter {
  position: sticky;
  left: 0;
  z-index: 2;
  flex: none;
  background: var(--bg-header);
  border-right: 1px solid var(--border);
  color: var(--text-muted);
  font-size: var(--fs-small);
  text-align: right;
  padding: 0 6px;
  line-height: 22px;
}

.gutter.corner {
  z-index: 4;
  height: 100%;
}

.gutter.sel {
  background: var(--bg-selected);
  color: var(--text);
}

.cell {
  flex: none;
  padding: 0 6px;
  line-height: 21px;
  border-right: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--border) 45%, transparent);
  white-space: pre;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cell.right {
  text-align: right;
}

.cell.null {
  color: var(--null);
  font-style: italic;
}

.cell.blob {
  color: var(--text-muted);
}

.cell.modified {
  background: var(--modified);
}

.row.added .cell {
  background: var(--added);
}

.row.deleted .cell {
  background: var(--deleted);
  text-decoration: line-through;
}

.cell.sel {
  background: var(--bg-selected);
}

.cell.active {
  box-shadow: inset 0 0 0 2px var(--accent);
}

.cell-editor {
  position: absolute;
  z-index: 10;
  margin: 0;
  padding: 2px 5px;
  border: 2px solid var(--accent);
  border-radius: 0;
  font-family: var(--font-ui);
  font-size: var(--fs);
  resize: none;
  box-shadow: var(--shadow);
}
</style>
