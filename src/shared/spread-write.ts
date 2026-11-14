/**
 * Input of d-spread-write (protocol 1, d-spread's docs/protocol-write.md) for an xlsx with one sheet: the column
 * names in bold on a frozen row 1, then the rows. The program never guesses a type, so numbers are decided here.
 */

/** Spreadsheet column letters of a 1-based column: 1 → A, 27 → AA. */
export function columnLetters(n: number): string {
  let s = ''
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

/** A decimal that a spreadsheet keeps exactly: no leading zeros, at most 15 digits. */
const exactNumber = (s: string): boolean =>
  /^-?\d+(\.\d+)?$/.test(s) && !/^-?0\d/.test(s) && s.replace(/\D/g, '').length <= 15

/** Excel's sheet names: at most 31 characters, none of []:*?/\, no apostrophe at either end, not blank. */
const sheetName = (title: string): string =>
  title
    .replace(/[[\]:*?/\\]/g, '')
    .slice(0, 31)
    // the cut can leave the first half of a surrogate pair (an emoji) alone
    .replace(/[\uD800-\uDBFF]$/, '')
    .replace(/^'+|'+$/g, '') || 'Sheet1'

function cellValue(value: string | number | null, numeric: boolean): string | number {
  if (value === null) return ''
  // NaN and Infinity aren't JSON numbers: as JSON they would be null, which leaves the cell alone
  if (numeric && typeof value === 'number' && Number.isFinite(value)) return value
  if (numeric && typeof value === 'string' && exactNumber(value)) return Number(value)
  return String(value)
}

export function spreadWriteLines(
  columns: { name: string; numeric: boolean }[],
  rows: (string | number | null)[][],
  sheetTitle: string
): string[] {
  const last = columnLetters(Math.max(columns.length, 1))
  const lines = [
    JSON.stringify({ protocol: 1, format: 'xlsx' }),
    JSON.stringify({ sheet: { title: sheetName(sheetTitle) } }),
    JSON.stringify([1, columns.map((c) => c.name)]),
    ...rows.map((r, i) => JSON.stringify([i + 2, r.map((v, c) => cellValue(v, columns[c].numeric))])),
    JSON.stringify({ style: `A1:${last}1`, font: { bold: true } }),
    JSON.stringify({ freeze: 'A2' }),
    ...columns.map((_, c) => JSON.stringify({ autosize: columnLetters(c + 1) }))
  ]
  lines.push(JSON.stringify({ end: true, lines: lines.length }))
  return lines
}
