<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { importStatements, serverFilledColumn } from '@shared/sql/import-rows'
import { columnLetters } from '@shared/spread-write'
import type { SpreadCell, SpreadSheetData } from '@shared/types'
import { t } from '@/i18n'
import type { ColumnMeta } from '@/workspace/metadata'
import type { Workspace } from '@/workspace/workspace'
import Modal from '../common/Modal.vue'

/**
 * Imports a CSV or spreadsheet file into an existing table: each column of the table takes a column of the
 * file or is skipped. The summary shown here (file, sheet, table, columns, row count) is the confirmation:
 * the INSERTs run without the review dialog, in one transaction when autocommit is on.
 */
const props = defineProps<{ ws: Workspace; schema: string; table: string }>()
const emit = defineEmits<{ close: [done?: boolean] }>()

const SKIP = -1
const previewRows = 10

const path = ref('')
const data = ref<SpreadSheetData | null>(null)
const sheet = ref(0)
/** Sheet names of the file: kept when reading another sheet fails, so another one can be chosen. */
const sheets = ref<string[]>([])
const header = ref(true)
const columns = ref<ColumnMeta[]>([])
/** For each column of the table, the index of the file column it takes, or SKIP. */
const mapping = ref<number[]>([])
const error = ref('')
const columnsError = ref('')
const running = ref(false)
const reading = ref(false)
/** Number of the latest read: a read that a later one has overtaken is dropped. */
let readSeq = 0

const fileName = computed(() => path.value.split(/[\\/]/).pop() ?? '')
const fileColumnCount = computed(() => (data.value?.rows ?? []).reduce((max, r) => Math.max(max, r.length), 0))
const fileColumns = computed(() =>
  Array.from({ length: fileColumnCount.value }, (_, i) => {
    const name = header.value ? data.value?.rows[0]?.[i] : null
    return name !== null && name !== undefined && name !== '' ? String(name) : t('importFile.column', { letter: columnLetters(i + 1) })
  })
)
const display = (c: SpreadCell | undefined): string => (c === null || c === undefined ? '' : String(c))
const isEmpty = (c: SpreadCell | undefined): boolean => display(c) === ''
/** The rows to import: those after the header, without the rows holding no value. */
const dataRows = computed(() => (data.value?.rows ?? []).slice(header.value ? 1 : 0).filter((r) => !r.every(isEmpty)))
const mapped = computed(() =>
  columns.value.map((c, i) => ({ name: c.name, type: c.type, source: mapping.value[i] ?? SKIP })).filter((m) => m.source !== SKIP)
)

onMounted(async () => {
  try {
    columns.value = await props.ws.meta.loadColumns(props.schema, props.table)
  } catch (e) {
    columnsError.value = (e as Error).message
  }
})

/**
 * Same name ignoring case and the header's outer spaces; otherwise the same position when the file has as many
 * columns as the table. Columns the server fills (identity, generated) start skipped.
 */
function matchColumns(): void {
  const names = header.value ? (data.value?.rows[0] ?? []).map((c) => display(c).trim().toLowerCase()) : []
  const samePositions = fileColumnCount.value === columns.value.length
  mapping.value = columns.value.map((c, i) => {
    if (serverFilledColumn(c.extra)) return SKIP
    const byName = names.indexOf(c.name.toLowerCase())
    return byName >= 0 ? byName : samePositions ? i : SKIP
  })
}
watch([data, header, columns], matchColumns)

/** Reads the file chosen: its active sheet, or `sheetIndex` of the same file. */
async function load(sheetIndex?: number): Promise<void> {
  const seq = ++readSeq
  error.value = ''
  data.value = null
  if (sheetIndex === undefined) sheets.value = []
  reading.value = true
  try {
    const read = await window.api.files.readSpread(path.value, sheetIndex)
    if (seq !== readSeq) return
    data.value = read
    sheets.value = read.sheets
    sheet.value = read.sheet
  } catch (e) {
    if (seq === readSeq) error.value = (e as Error).message
  } finally {
    if (seq === readSeq) reading.value = false
  }
}

async function chooseFile(): Promise<void> {
  const file = await window.api.files.chooseImportFile()
  if (!file) return
  path.value = file
  await load()
}

async function importRows(): Promise<void> {
  const ws = props.ws
  const d = ws.dialect
  const targets = mapped.value
  const rows = dataRows.value.map((r) => targets.map((m) => r[m.source] ?? null))
  const inserts = importStatements(d, props.schema, props.table, targets, rows)
  // with autocommit off the transaction is the user's: the rows join it
  const autocommit = ws.autocommit
  error.value = ''
  running.value = true
  try {
    // the INSERTs stay out of the history (500 rows each): the Output keeps them, and the summary below
    const r = await ws.runStatements(autocommit ? [d.beginTransaction, ...inserts, 'COMMIT'] : inserts, { history: false, transaction: true })
    if (!r.ok) {
      // failedAt 0: the transaction did not start (or nothing ran because the connection is busy);
      // after a reconnection there is no transaction left to roll back
      if (autocommit && (r.failedAt ?? 0) > 0 && !r.result?.reconnected) await ws.runStatements(['ROLLBACK'], { history: false })
      error.value = r.error ?? ''
      return
    }
    ws.log('ok', t('importFile.title', { table: props.table }), t('importFile.done', { count: rows.length, table: props.table }))
    emit('close', true)
  } finally {
    running.value = false
  }
}

function cancel(): void {
  if (!running.value) emit('close')
}
</script>

<template>
  <Modal :title="t('importFile.title', { table })" width="720px" @cancel="cancel">
    <div class="form-grid">
      <button autofocus :disabled="running || reading" @click="chooseFile">{{ t('importFile.chooseFile') }}</button>
      <span class="file selectable" :class="{ muted: !path }">{{ path ? fileName : t('importFile.noFile') }}</span>
      <template v-if="sheets.length > 1">
        <label for="if-sheet">{{ t('importFile.sheet') }}</label>
        <select id="if-sheet" v-model.number="sheet" :disabled="running || reading" @change="load(sheet)">
          <option v-for="(s, i) in sheets" :key="i" :value="i">{{ s }}</option>
        </select>
      </template>
    </div>
    <template v-if="data">
      <label class="check option"><input id="if-header" v-model="header" type="checkbox" :disabled="running" /> {{ t('importFile.firstRowHeader') }}</label>
      <div class="section">{{ t('importFile.preview') }}</div>
      <div class="preview">
        <table class="list">
          <thead>
            <tr>
              <th v-for="(c, i) in fileColumns" :key="i">{{ c }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, n) in dataRows.slice(0, previewRows)" :key="n">
              <td v-for="(_c, i) in fileColumns" :key="i">{{ display(r[i]) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="section">{{ t('importFile.mapping') }}</div>
      <div class="form-grid">
        <template v-for="(c, i) in columns" :key="c.name">
          <label :for="`if-col-${i}`">{{ c.name }}</label>
          <select :id="`if-col-${i}`" v-model.number="mapping[i]" :disabled="running">
            <option :value="SKIP">{{ t('importFile.skip') }}</option>
            <option v-for="(f, j) in fileColumns" :key="j" :value="j">{{ f }}</option>
          </select>
        </template>
      </div>
    </template>
    <p v-if="columnsError" class="error selectable">{{ columnsError }}</p>
    <p v-if="error" class="error selectable">{{ error }}</p>
    <template #footer>
      <button :disabled="running" @click="cancel">{{ t('common.cancel') }}</button>
      <button class="primary" :disabled="running || reading || !data || !dataRows.length || !mapped.length" @click="importRows">
        {{ t('importFile.import', { count: dataRows.length }) }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.file {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.option {
  margin-top: 10px;
}

.section {
  margin: 12px 0 6px;
  font-weight: 600;
}

.preview {
  max-height: 220px;
  overflow: auto;
  border: 1px solid var(--border);
}

.error {
  color: var(--danger);
  white-space: pre-wrap;
}
</style>
