<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { Cell } from '@shared/types'
import type { MenuItemSpec } from '@shared/types'
import { t } from '@/i18n'
import { confirmDiscardEdits } from '@/workspace/confirm'
import { cellFullText, cellText, isNumericColumn } from '@/workspace/format'
import {
  addRow,
  cellValue,
  deleteRows,
  FUNC_PREFIX,
  isModified,
  rowCount,
  setCell,
  type ResultTab
} from '@/workspace/results'
import type { Workspace } from '@/workspace/workspace'
import DataGrid, { type GridCell, type GridColumn } from '../grid/DataGrid.vue'
import { copyRows, editValue, type CopyKind } from './result-actions'

const props = defineProps<{ ws: Workspace; rt: ResultTab; filter: string }>()
const emit = defineEmits<{ 'active-row': [row: number]; 'view-count': [count: number] }>()

const grid = ref<InstanceType<typeof DataGrid>>()
const sort = ref<{ col: number; dir: 'asc' | 'desc' } | null>(null)
const editable = computed(() => !!props.rt.target)

const columns = computed<GridColumn[]>(() =>
  props.rt.columns.map((c) => ({ name: c.name, align: isNumericColumn(c) ? 'right' : 'left', title: t('results.columnTitle', { name: c.name, table: c.orgTable || t('results.expression') }) }))
)

/** Display order: filtered and sorted indexes into the result rows. */
const view = computed<number[]>(() => {
  void props.rt.version
  const rt = props.rt
  let idx = Array.from({ length: rowCount(rt) }, (_, i) => i)
  const f = props.filter.trim().toLowerCase()
  if (f) {
    idx = idx.filter((r) =>
      rt.columns.some((col, c) => {
        const v = cellValue(rt, r, c)
        return v !== null && v !== undefined && cellFullText(v, col).toLowerCase().includes(f)
      })
    )
  }
  const s = sort.value
  if (s) {
    const numeric = isNumericColumn(rt.columns[s.col])
    const key = (r: number): string | number | null => {
      const v = cellValue(rt, r, s.col)
      if (v === null || v === undefined) return null
      if (numeric) return Number(v instanceof Uint8Array ? cellFullText(v, rt.columns[s.col]) : v)
      return cellFullText(v, rt.columns[s.col])
    }
    const dir = s.dir === 'asc' ? 1 : -1
    idx.sort((a, b) => {
      const ka = key(a)
      const kb = key(b)
      if (ka === kb) return a - b
      if (ka === null) return -dir
      if (kb === null) return dir
      return (ka < kb ? -1 : 1) * dir
    })
  }
  return idx
})

watch(
  () => props.rt.id,
  () => (sort.value = null)
)

watch(
  () => view.value.length,
  (n) => emit('view-count', n),
  { immediate: true }
)

function cell(r: number, c: number): GridCell {
  const row = view.value[r]
  const v = cellValue(props.rt, row, c)
  const col = props.rt.columns[c]
  let cls = v === null ? 'null' : v instanceof Uint8Array && cellText(v, col) === 'BLOB' ? 'blob' : ''
  if (isModified(props.rt, row, c)) cls += ' modified'
  return { text: v === undefined ? '' : cellText(v, col), cls }
}

const editText = (r: number, c: number): string => {
  const v = cellValue(props.rt, view.value[r], c)
  return v === null || v === undefined ? '' : cellFullText(v, props.rt.columns[c])
}

function rowClass(r: number): string {
  const row = view.value[r]
  if (row >= props.rt.rows.length) return 'added'
  return props.rt.deleted.has(row) ? 'deleted' : ''
}

function onSort(col: number): void {
  const s = sort.value
  sort.value = !s || s.col !== col ? { col, dir: 'asc' } : s.dir === 'asc' ? { col, dir: 'desc' } : null
}

function onEdit(r: number, c: number, text: string): void {
  const row = view.value[r]
  const before = cellValue(props.rt, row, c)
  if (before !== undefined && before !== null && editText(r, c) === text) return
  if ((before === null || before === undefined) && text === '') return
  setCell(props.rt, row, c, text)
}

const selectedRows = (): number[] => (grid.value?.selectedRows() ?? []).map((r) => view.value[r])

async function openEditor(r: number, c: number): Promise<void> {
  const row = view.value[r]
  const value = await editValue(props.rt, row, c, !editable.value)
  if (value !== undefined && editable.value) setCell(props.rt, row, c, value)
}

async function addNewRow(): Promise<void> {
  const r = addRow(props.rt)
  // the grid clamps the selection to its row count: wait until it has the new row
  await nextTick()
  // new rows are appended after the current view
  const pos = view.value.indexOf(r)
  if (pos >= 0) grid.value?.select(pos, 0)
  // keyboard input must go to the new row, not to the toolbar button that added it
  grid.value?.focus()
}

function deleteSelected(): void {
  const rows = selectedRows()
  if (rows.length) deleteRows(props.rt, rows)
}

async function onContext(_e: MouseEvent, r: number, c: number): Promise<void> {
  const ro = !editable.value
  const items: MenuItemSpec[] = [
    { id: 'open', label: t('results.menu.openValue') },
    { id: 'null', label: t('results.menu.setNull'), enabled: !ro },
    { id: 'func', label: t('results.menu.markFunction'), enabled: !ro },
    { id: 'load', label: t('results.menu.loadValue'), enabled: !ro },
    { id: 'save', label: t('results.menu.saveValue') },
    { type: 'separator' },
    { id: 'copy:row', label: t('results.menu.copyRow') },
    { id: 'copy:row-names', label: t('results.menu.copyRowNames') },
    { id: 'copy:row-unquoted', label: t('results.menu.copyRowUnquoted') },
    { id: 'copy:row-tab', label: t('results.menu.copyRowTab') },
    { id: 'copy:field', label: t('results.menu.copyField') },
    { id: 'copy:field-unquoted', label: t('results.menu.copyFieldUnquoted') },
    { id: 'copy:insert', label: t('results.menu.copyInsert') },
    { id: 'copy:selection', label: t('results.menu.copySelection') },
    { type: 'separator' },
    { id: 'add', label: t('results.menu.addRow'), enabled: !ro },
    { id: 'delete', label: t('results.menu.deleteRows'), enabled: !ro },
    { type: 'separator' },
    { id: 'refresh', label: t('results.menu.refresh') }
  ]
  const choice = await window.api.ui.contextMenu(items)
  if (!choice) return
  const row = view.value[r]
  if (choice.startsWith('copy:')) {
    if (choice === 'copy:selection') grid.value?.copyRange()
    else copyRows(props.rt, selectedRows(), choice.slice(5) as CopyKind, c)
    return
  }
  switch (choice) {
    case 'open':
      await openEditor(r, c)
      break
    case 'null':
      setCell(props.rt, row, c, null)
      break
    case 'func': {
      const v = cellValue(props.rt, row, c)
      const s = typeof v === 'string' ? v : ''
      setCell(props.rt, row, c, s.startsWith(FUNC_PREFIX) ? s.slice(FUNC_PREFIX.length) : FUNC_PREFIX + s)
      break
    }
    case 'load': {
      const path = await window.api.files.chooseOpen({ title: t('results.loadValueTitle') })
      if (path) setCell(props.rt, row, c, (await window.api.files.readBinary(path)) as Cell)
      break
    }
    case 'save': {
      const path = await window.api.files.chooseSave({ title: t('results.saveValueTitle') })
      const v = cellValue(props.rt, row, c)
      if (path && v !== null && v !== undefined) {
        await window.api.files.write(path, v instanceof Uint8Array ? v : String(v))
      }
      break
    }
    case 'add':
      await addNewRow()
      break
    case 'delete':
      deleteSelected()
      break
    case 'refresh':
      if (await confirmDiscardEdits([props.rt])) await props.ws.refreshResult(props.rt)
      break
  }
}

/** Column header menu. */
async function onHeaderContext(_e: MouseEvent, c: number): Promise<void> {
  const choice = await window.api.ui.contextMenu([
    { id: 'copy-name', label: t('results.menu.copyFieldName') },
    { id: 'copy-names', label: t('results.menu.copyFieldNames') },
    { type: 'separator' },
    { id: 'reset-sort', label: t('results.menu.resetSorting'), enabled: !!sort.value },
    { id: 'reset-widths', label: t('results.menu.resetWidths') }
  ])
  if (choice === 'copy-name') await navigator.clipboard.writeText(props.rt.columns[c].name)
  else if (choice === 'copy-names') await navigator.clipboard.writeText(props.rt.columns.map((col) => col.name).join(', '))
  else if (choice === 'reset-sort') sort.value = null
  else if (choice === 'reset-widths') grid.value?.resetWidths()
}

defineExpose({ addNewRow, deleteSelected, focus: () => grid.value?.focus() })
</script>

<template>
  <DataGrid
    ref="grid"
    :columns="columns"
    :row-count="view.length"
    :cell="cell"
    :row-class="rowClass"
    :version="rt.version + view.length"
    :editable="editable"
    :edit-text="editText"
    :sort="sort"
    @sort="onSort"
    @edit="onEdit"
    @activate="openEditor"
    @contextmenu="onContext"
    @header-contextmenu="onHeaderContext"
    @delete-key="deleteSelected"
    @selection-change="(r) => emit('active-row', view[r])"
  />
</template>
