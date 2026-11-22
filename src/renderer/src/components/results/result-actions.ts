import type { Cell } from '@shared/types'
import type { MessageKey } from '@shared/i18n'
import { alertError, openDialog, prompt } from '@/dialogs'
import { t } from '@/i18n'
import { spreadWriteLines } from '@shared/spread-write'
import { cellFullText, exportFormats, exportRows, isNumericColumn, type ExportFormat } from '@/workspace/format'
import { cellValue, discardEdits, editStatements, hasEdits, rowCount, type ResultTab } from '@/workspace/results'
import { reviewAndApply } from '@/workspace/review'
import type { Workspace } from '@/workspace/workspace'
import ValueEditorDialog from './ValueEditorDialog.vue'

/** Applies pending grid edits after the review dialog, then reloads the result. */
export async function applyEdits(ws: Workspace, rt: ResultTab): Promise<void> {
  const statements = editStatements(rt)
  if (!statements.length) return
  const applied = ws.settings.confirmDataChanges
    ? await reviewAndApply(ws, statements)
    : (await ws.runStatements(statements)).ok
  if (applied) await ws.refreshResult(rt)
}

export function revertEdits(rt: ResultTab): void {
  if (hasEdits(rt)) discardEdits(rt)
}

/** Format names that are not product names (CSV, JSON, HTML stay as they are). */
const formatLabels: Partial<Record<ExportFormat, MessageKey>> = {
  'csv-semicolon': 'results.exportFormat.csvSemicolon',
  tsv: 'results.exportFormat.tsv',
  sql: 'results.exportFormat.sql'
}

export async function exportResult(rt: ResultTab): Promise<void> {
  // XLSX only where d-spread-write is there for this platform
  const xlsx = await window.api.files.spreadAvailable()
  const formats = exportFormats.filter((f) => f.id !== 'xlsx' || xlsx)
  const labels = formats.map((f) => (formatLabels[f.id] ? t(formatLabels[f.id]!) : f.label))
  const r = await prompt({
    title: t('results.exportTitle'),
    message: rt.limited ? t('results.exportLimited', { count: rt.rows.length }) : undefined,
    fields: [{ key: 'format', label: t('results.exportFormat'), type: 'select', options: labels, value: labels[0] }],
    okLabel: t('results.exportContinue')
  })
  if (!r) return
  // the select returns the label: find its format by position, not by text
  const i = labels.indexOf(String(r.format))
  const format = formats[i]
  const path = await window.api.files.chooseSave({
    title: t('results.exportTitle'),
    defaultPath: `${rt.title.replace(/\s+\d+$/, '')}.${format.ext}`,
    filters: [{ name: labels[i], extensions: [format.ext] }]
  })
  if (!path) return
  const rows: Cell[][] = []
  for (let i = 0; i < rowCount(rt); i++) {
    if (rt.deleted.has(i)) continue
    rows.push(rt.columns.map((_, c) => cellValue(rt, i, c) ?? null))
  }
  const target = rt.target ? { schema: rt.target.schema, table: rt.target.table } : undefined
  try {
    if (format.id === 'xlsx') {
      // the cells as in the CSV export, numbers as they are; the column type decides what is a number
      const columns = rt.columns.map((c) => ({ name: c.name, numeric: isNumericColumn(c) }))
      const cells = rows.map((r) => r.map((v, c) => (v === null || typeof v === 'number' ? v : cellFullText(v, rt.columns[c]))))
      await window.api.files.writeXlsx(path, spreadWriteLines(columns, cells, rt.title))
    } else await window.api.files.write(path, exportRows(format.id, rt.columns, rows, rt.dialect, target))
  } catch (e) {
    await alertError(t('results.exportFailed'), (e as Error).message)
  }
}

/** Opens the value editor; resolves with the new value or undefined when unchanged. */
export function editValue(rt: ResultTab, row: number, col: number, readOnly: boolean): Promise<Cell | undefined> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- type of a .vue import, not read by typescript-eslint
  return openDialog<Cell>(ValueEditorDialog, {
    value: cellValue(rt, row, col) ?? null,
    column: rt.columns[col],
    readOnly
  })
}

const rowValues = (rt: ResultTab, row: number): Cell[] => rt.columns.map((_, c) => cellValue(rt, row, c) ?? null)

export type CopyKind = 'row' | 'row-names' | 'row-unquoted' | 'row-tab' | 'field' | 'field-unquoted' | 'insert'

export function copyRows(rt: ResultTab, rows: number[], kind: CopyKind, col = 0): void {
  const d = rt.dialect
  const lines: string[] = []
  if (kind === 'row-names') lines.push(rt.columns.map((c) => c.name).join(', '))
  for (const row of rows) {
    const values = rowValues(rt, row)
    switch (kind) {
      case 'row':
      case 'row-names':
        lines.push(values.map((v, i) => d.literal(v, rt.columns[i])).join(', '))
        break
      case 'row-unquoted':
        lines.push(values.map((v, i) => (v === null ? 'NULL' : cellFullText(v, rt.columns[i]))).join(', '))
        break
      case 'row-tab':
        lines.push(values.map((v, i) => (v === null ? 'NULL' : cellFullText(v, rt.columns[i]))).join('\t'))
        break
      case 'field':
        lines.push(d.literal(values[col], rt.columns[col]))
        break
      case 'field-unquoted':
        lines.push(values[col] === null ? 'NULL' : cellFullText(values[col], rt.columns[col]))
        break
      case 'insert': {
        const table = rt.target ? d.qualified(rt.target.schema, rt.target.table) : d.quoteIdentifier(rt.columns[0]?.orgTable || 'table')
        const cols = rt.columns.map((c) => d.quoteIdentifier(c.orgName || c.name)).join(', ')
        lines.push(`INSERT INTO ${table} (${cols}) VALUES (${values.map((v, i) => d.literal(v, rt.columns[i])).join(', ')});`)
        break
      }
    }
  }
  void navigator.clipboard.writeText(lines.join('\n'))
}
