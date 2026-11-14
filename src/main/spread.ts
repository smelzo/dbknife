import { app } from 'electron'
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { decodeCsv, detectDelimiter, parseCsv } from '@shared/csv'
import { t } from '@shared/i18n'
import { excelSerialToIso } from '@shared/spread-dates'
import type { SpreadCell, SpreadSheetData } from '@shared/types'

/**
 * Path of a d-spread program (reads and writes spreadsheets, run as a separate process), when present.
 * Packaged: Resources/bin (electron-builder.yml); otherwise bin/<platform>-<arch> of the repo, found from
 * the main bundle (out/main), so that it works also when Electron is started on out/main/index.js, not on the repo root.
 */
export function spreadTool(name: 'd-spread' | 'd-spread-write'): string | undefined {
  const file = name + (process.platform === 'win32' ? '.exe' : '')
  const path = app.isPackaged
    ? join(process.resourcesPath, 'bin', file)
    : join(__dirname, '../../bin', `${process.platform}-${process.arch}`, file)
  return existsSync(path) ? path : undefined
}

export const spreadAvailable = (): boolean => !!spreadTool('d-spread') && !!spreadTool('d-spread-write')

/**
 * Writes `lines` (protocol of d-spread-write, see src/shared/spread-write.ts) to d-spread-write and its output to
 * `path`, through `path.part`: a failed export leaves no file and doesn't touch the one already there.
 */
export async function writeXlsx(path: string, lines: string[]): Promise<void> {
  const tool = spreadTool('d-spread-write')
  if (!tool) throw new Error(t('main.spread.unavailable'))
  const part = path + '.part'
  const child = spawn(tool, [], { stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (s: string) => (stderr += s))
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal }))
  })
  const [exit, written, sent] = await Promise.allSettled([
    exited,
    pipeline(child.stdout, createWriteStream(part)),
    pipeline(Readable.from(lines.map((l) => l + '\n')), child.stdin)
  ])
  try {
    if (exit.status === 'rejected') throw exit.reason
    // a file that can't be written (EACCES, ENOSPC) is the cause: d-spread-write only sees a broken pipe
    if (written.status === 'rejected') throw written.reason
    if (exit.value.code !== 0) {
      // its own message (`d-spread-write: line 3: …`) explains more than a broken pipe on its stdin
      const lastError = stderr.trim().split('\n').pop()
      const code = String(exit.value.code ?? exit.value.signal)
      throw new Error(lastError || t('tools.job.exitCode', { tool: 'd-spread-write', code }))
    }
    if (sent.status === 'rejected') throw sent.reason
    // fails when the file is open elsewhere (Windows) or is a folder
    await rename(part, path)
  } catch (e) {
    await rm(part, { force: true })
    throw e
  }
}

/** A cell of d-spread's output (docs/protocol.md of d-spread): a plain value, or an object with the keys it needs. */
type ProtocolCell = SpreadCell | { v?: SpreadCell; n?: number; e?: string }

function cellValue(cell: ProtocolCell, formats: { date?: boolean }[]): SpreadCell {
  if (cell === null || typeof cell !== 'object') return cell
  if (cell.e !== undefined) return null
  if (typeof cell.v === 'number' && cell.n !== undefined && formats[cell.n]?.date) return excelSerialToIso(cell.v)
  return cell.v ?? null
}

/** A CSV file read with the app's own CSV reader: every cell is text, empty ones null. */
async function readCsvSheet(path: string): Promise<SpreadSheetData> {
  const { text } = decodeCsv(await readFile(path))
  const rows = parseCsv(text, detectDelimiter(text)).map((record) => record.map((c) => (c === '' ? null : c)))
  return { format: 'csv', sheets: [], sheet: 0, rows }
}

/**
 * Sheet `sheet` (0-based; the active one when missing) of a spreadsheet or CSV file.
 * A .csv, .txt or .tsv file is always read by the app's CSV reader, which keeps every value as the file's text
 * (d-spread types CSV values: +39123456 and 1.10 would become numbers); the other files by d-spread, or as CSV
 * without it.
 */
export async function readSpread(path: string, sheet?: number): Promise<SpreadSheetData> {
  const tool = spreadTool('d-spread')
  if (!tool || /\.(csv|txt|tsv)$/i.test(path)) return readCsvSheet(path)
  const child = spawn(tool, [...(sheet === undefined ? [] : ['--sheet', String(sheet)]), path], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (s: string) => (stderr += s))
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal }))
  })
  // a failed spawn rejects while the output is being read: it is awaited after the loop
  exited.catch(() => {})
  let header: { protocol?: unknown; format?: string; sheets?: string[]; sheet?: number; cols?: number; formats?: { date?: boolean }[] } | undefined
  let ended = false
  const rows: SpreadCell[][] = []
  try {
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      if (!line) continue
      const value = JSON.parse(line)
      if (!header) {
        if (value?.protocol !== 1) throw new Error(t('main.spread.badOutput'))
        header = value
      } else if (Array.isArray(value)) {
        const [n, cells] = value as [number, ProtocolCell[]]
        // rows without data are left out of the output: an empty one keeps rows[n - 1] on row n
        while (rows.length < n - 1) rows.push([])
        const row = cells.map((c) => cellValue(c, header!.formats ?? []))
        // trailing empty cells are left out too
        while (row.length < (header.cols ?? 0)) row.push(null)
        rows.push(row)
      } else if (value?.end) ended = true
    }
  } catch (e) {
    child.kill()
    throw e
  }
  const exit = await exited
  if (exit.code !== 0) {
    const lastError = stderr.trim().split('\n').pop()
    throw new Error(lastError || t('tools.job.exitCode', { tool: 'd-spread', code: String(exit.code ?? exit.signal) }))
  }
  // without the closing line the output is truncated
  if (!header || !ended) throw new Error(t('main.spread.badOutput'))
  return { format: header.format ?? '', sheets: header.sheets ?? [], sheet: header.sheet ?? 0, rows }
}
