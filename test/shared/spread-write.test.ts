import { describe, expect, it } from 'vitest'
import { spreadWriteLines } from '@shared/spread-write'

const parsed = (lines: string[]): unknown[] => lines.map((l): unknown => JSON.parse(l))

/** The cells of the first data row (row 2) for one column. */
function cellOf(value: string | number | null, numeric: boolean): unknown {
  const rows = parsed(spreadWriteLines([{ name: 'c', numeric }], [[value]], 'Sheet'))
  const row = rows.find((l) => Array.isArray(l) && l[0] === 2) as [number, unknown[]]
  return row[1][0]
}

describe('spreadWriteLines', () => {
  it('starts with the protocol line and closes with the count of the lines before the end line', () => {
    const lines = parsed(spreadWriteLines([{ name: 'a', numeric: false }, { name: 'b', numeric: true }], [['x', '1'], ['y', '2']], 'R'))
    expect(lines[0]).toEqual({ protocol: 1, format: 'xlsx' })
    expect(lines.at(-1)).toEqual({ end: true, lines: lines.length - 1 })
  })

  it('writes the column names on row 1 and the data from row 2, in order', () => {
    const lines = parsed(spreadWriteLines([{ name: 'id', numeric: true }], [['1'], ['2']], 'R'))
    expect(lines.filter((l) => Array.isArray(l))).toEqual([[1, ['id']], [2, [1]], [3, [2]]])
  })

  it('names column 27 AA in the bold range and in its autosize', () => {
    const columns = Array.from({ length: 27 }, (_, i) => ({ name: `c${i + 1}`, numeric: false }))
    const lines = parsed(spreadWriteLines(columns, [], 'R'))
    expect(lines).toContainEqual({ style: 'A1:AA1', font: { bold: true } })
    expect(lines).toContainEqual({ autosize: 'AA' })
  })

  it('writes an exact decimal of a numeric column as a number', () => {
    expect(cellOf('12.5', true)).toBe(12.5)
    expect(cellOf('-3', true)).toBe(-3)
  })

  it('writes a finite number of a numeric column as it is, and NaN as text', () => {
    expect(cellOf(0.1 + 0.2, true)).toBe(0.1 + 0.2)
    expect(cellOf(NaN, true)).toBe('NaN')
  })

  it('keeps as text what a number would change: leading zeros, more than 15 digits, other columns', () => {
    expect(cellOf('0012', true)).toBe('0012')
    expect(cellOf('1234567890123456', true)).toBe('1234567890123456')
    expect(cellOf('12', false)).toBe('12')
  })

  it('writes NULL as an empty cell, not as null (which leaves the cell alone)', () => {
    expect(cellOf(null, true)).toBe('')
  })

  it('makes the sheet title a valid sheet name: no forbidden characters, at most 31, no apostrophe at either end, Sheet1 when blank', () => {
    const title = (s: string): unknown => (parsed(spreadWriteLines([{ name: 'a', numeric: false }], [], s))[1] as { sheet: { title: string } }).sheet.title
    expect(title('a/b\\c[d]:e*f?g')).toBe('abcdefg')
    expect(title('x'.repeat(40))).toBe('x'.repeat(31))
    expect(title("'abc'")).toBe('abc')
    expect(title('[]:*?/\\')).toBe('Sheet1')
    // an emoji (two UTF-16 units) across the 31st unit: dropped whole, never half
    expect(title('x'.repeat(30) + '\u{1F600}')).toBe('x'.repeat(30))
  })
})
