// CSV files read into a table and written back (RFC 4180, with the variants
// Excel writes: `;` or tab as separator, Windows-1252 text, a UTF-8 BOM).

export type CsvDelimiter = ',' | ';' | '\t'
export type CsvEncoding = 'utf-8' | 'windows-1252'

/** How a file is written, so that saving it keeps the layout it was read with. */
export interface CsvFormat {
  delimiter: CsvDelimiter
  encoding: CsvEncoding
  bom: boolean
  lineEnding: '\r\n' | '\n' | '\r'
  /** The last record ends with a line ending. */
  finalNewline: boolean
}

export type CsvColumnType = 'INTEGER' | 'REAL' | 'TEXT'

export interface CsvTable {
  format: CsvFormat
  columns: { name: string; type: CsvColumnType }[]
  /** Records after the header, as long as `columns`; empty cells are null. */
  rows: (string | null)[][]
}

/** `code` says what went wrong; the caller turns it into a message. */
export class CsvError extends Error {
  constructor(
    readonly code: 'empty' | 'unencodable',
    readonly detail = ''
  ) {
    super(`CSV ${code}${detail ? `: ${detail}` : ''}`)
  }
}

const delimiters: CsvDelimiter[] = [',', ';', '\t']

/**
 * Records of `text`. Fields may be quoted, with `""` for a quote and line
 * breaks inside; characters after a closing quote stay in the field. Blank
 * lines are no records.
 */
export function parseCsv(text: string, delimiter: string): string[][] {
  const records: string[][] = []
  const n = text.length
  const fieldEnd = (from: number): number => {
    let k = from
    while (k < n && text[k] !== delimiter && text[k] !== '\n' && text[k] !== '\r') k++
    return k
  }
  let i = 0
  while (i < n) {
    const record: string[] = []
    let quoted = false
    for (;;) {
      let field = ''
      quoted = text[i] === '"'
      if (quoted) {
        let j = i + 1
        for (;;) {
          const q = text.indexOf('"', j)
          if (q < 0) {
            field += text.slice(j)
            i = n
            break
          }
          if (text[q + 1] === '"') {
            field += text.slice(j, q + 1)
            j = q + 2
            continue
          }
          field += text.slice(j, q)
          i = q + 1
          break
        }
      }
      const k = fieldEnd(i)
      field += text.slice(i, k)
      i = k
      record.push(field)
      if (text[i] !== delimiter) break
      i++
    }
    if (text[i] === '\r') i++
    if (text[i] === '\n') i++
    if (record.length > 1 || record[0] !== '' || quoted) records.push(record)
  }
  return records
}

/**
 * The separator of `text` among `,` `;` and tab: the one splitting the first
 * records into the same number of fields (more than one), the most fields
 * winning; otherwise the one giving the header most fields; `,` by default.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  // a sample is enough; the last record of the sample may be cut, it is left out
  const sample = text.length > 65536 ? text.slice(0, text.lastIndexOf('\n', 65536) + 1 || 65536) : text
  let best: CsvDelimiter = ','
  let bestScore = -1
  for (const d of delimiters) {
    const records = parseCsv(sample, d).slice(0, 20)
    if (!records.length) continue
    const count = records[0].length
    if (count < 2) continue
    const consistent = records.every((r) => r.length === count)
    // consistent separators always beat inconsistent ones
    const score = (consistent ? 1_000_000 : 0) + count
    if (score > bestScore) {
      best = d
      bestScore = score
    }
  }
  return best
}

let cp1252: Map<string, number> | undefined

/** Windows-1252 bytes of `text`; a character it cannot hold throws CsvError 'unencodable'. */
function encodeWindows1252(text: string): Uint8Array {
  // the 0x80-0x9F block is the only one differing from Latin-1: take it from the decoder
  cp1252 ??= new Map(Array.from({ length: 32 }, (_, i) => [new TextDecoder('windows-1252').decode(new Uint8Array([0x80 + i])), 0x80 + i]))
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    const b = c < 0x80 || (c >= 0xa0 && c <= 0xff) ? c : cp1252.get(text[i])
    if (b === undefined) throw new CsvError('unencodable', String.fromCodePoint(text.codePointAt(i)!))
    out[i] = b
  }
  return out
}

/** Text of a file: UTF-8 (with or without BOM) when valid, Windows-1252 otherwise. */
export function decodeCsv(bytes: Uint8Array): { text: string; encoding: CsvEncoding; bom: boolean } {
  const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8', bom }
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252', bom: false }
  }
}

/** A field quoted when it holds the separator, a quote or a line break. */
export function csvField(text: string, delimiter: string): string {
  return /["\r\n]/.test(text) || text.includes(delimiter) ? `"${text.replace(/"/g, '""')}"` : text
}

const integer = /^-?(0|[1-9]\d*)$/
const decimal = /^-?(0|[1-9]\d*)(\.\d+)?$/

/**
 * INTEGER or REAL when every value is a number written exactly as the number
 * is written back (`00123`, `1.50`, `1e3`, `1,5` stay TEXT), TEXT otherwise.
 */
export function columnType(values: Iterable<string | null>): CsvColumnType {
  let type: CsvColumnType = 'TEXT'
  for (const v of values) {
    if (v === null) continue
    if (!decimal.test(v) || String(Number(v)) !== v) return 'TEXT'
    if (type === 'TEXT') type = 'INTEGER'
    if (!integer.test(v)) type = 'REAL'
  }
  return type
}

/** Column names from the header: blank ones become column_N, repeated ones (ignoring case, as SQLite does) get _2, _3... */
export function columnNames(header: string[], count: number): string[] {
  const used = new Set<string>()
  return Array.from({ length: count }, (_, i) => {
    const base = header[i]?.trim() ? header[i] : `column_${i + 1}`
    let name = base
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base}_${n}`
    used.add(name.toLowerCase())
    return name
  })
}

/** Reads a CSV file whose first record is the header. Records longer than the header add columns. */
export function readCsv(bytes: Uint8Array): CsvTable {
  const { text, encoding, bom } = decodeCsv(bytes)
  const delimiter = detectDelimiter(text)
  const records = parseCsv(text, delimiter)
  if (!records.length) throw new CsvError('empty')
  const lineEnding = (/\r\n|\n|\r/.exec(text)?.[0] ?? '\n') as CsvFormat['lineEnding']
  const count = records.reduce((max, r) => Math.max(max, r.length), 0)
  const names = columnNames(records[0], count)
  const rows = records.slice(1).map((r) => Array.from({ length: count }, (_, i) => (r[i] ? r[i] : null)))
  return {
    format: { delimiter, encoding, bom, lineEnding, finalNewline: /[\r\n]$/.test(text) },
    columns: names.map((name, i) => ({ name, type: columnType(rows.map((r) => r[i])) })),
    rows
  }
}

/** File content of `header` and `rows` (null cells empty) in `format`. */
export function writeCsv(header: string[], rows: (string | null)[][], format: CsvFormat): Uint8Array {
  const d = format.delimiter
  const line = (cells: (string | null)[]): string =>
    // a lone empty field would be a blank line, which reading skips
    cells.length === 1 && !cells[0] ? '""' : cells.map((c) => csvField(c ?? '', d)).join(d)
  const text = [header, ...rows].map(line).join(format.lineEnding) + (format.finalNewline ? format.lineEnding : '')
  if (format.encoding === 'windows-1252') return encodeWindows1252(text)
  const body = new TextEncoder().encode(text)
  if (!format.bom) return body
  const out = new Uint8Array(body.length + 3)
  out.set([0xef, 0xbb, 0xbf])
  out.set(body, 3)
  return out
}
