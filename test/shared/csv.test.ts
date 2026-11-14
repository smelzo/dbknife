import { describe, expect, it } from 'vitest'
import { columnNames, columnType, CsvError, decodeCsv, detectDelimiter, parseCsv, readCsv, writeCsv } from '@shared/csv'

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

/** Reading a file and writing back what was read. */
function roundTrip(file: Uint8Array): Uint8Array {
  const t = readCsv(file)
  return writeCsv(
    t.columns.map((c) => c.name),
    t.rows,
    t.format
  )
}

describe('parseCsv', () => {
  it('reads quoted fields holding separators, quotes and line breaks (RFC 4180)', () => {
    expect(parseCsv('a,"b,c","say ""hi""","x\r\ny"\r\n1,2,3,4', ',')).toEqual([
      ['a', 'b,c', 'say "hi"', 'x\r\ny'],
      ['1', '2', '3', '4']
    ])
  })

  it('skips blank lines but keeps a line holding an empty quoted field', () => {
    expect(parseCsv('a\n\n""\nb\n', ',')).toEqual([['a'], [''], ['b']])
  })

  it('reads a trailing separator as an empty last field', () => {
    expect(parseCsv('a,b,\n', ',')).toEqual([['a', 'b', '']])
  })
})

describe('detectDelimiter', () => {
  it('picks the separator splitting every record alike', () => {
    expect(detectDelimiter('name;price\nwine;1,50\nbread;2,10\n')).toBe(';')
    expect(detectDelimiter('a\tb\tc\n1\t2\t3\n')).toBe('\t')
    expect(detectDelimiter('a,b\n"x;y",2\n')).toBe(',')
  })

  it('falls back to comma for a single column', () => {
    expect(detectDelimiter('name\nwine\n')).toBe(',')
  })
})

describe('columnType', () => {
  it('makes numeric only the columns whose values are written back unchanged', () => {
    expect(columnType(['1', '-20', null])).toBe('INTEGER')
    expect(columnType(['1', '2.5'])).toBe('REAL')
    for (const v of ['00123', '1.50', '1e3', '1,5', '-0', 'Infinity', ' 1', '12345678901234567890']) expect(columnType(['1', v])).toBe('TEXT')
    expect(columnType([null, null])).toBe('TEXT')
  })
})

describe('columnNames', () => {
  it('names blank headers and repeated ones, ignoring case', () => {
    expect(columnNames(['id', '', 'Name', 'name', ' '], 6)).toEqual(['id', 'column_2', 'Name', 'name_2', 'column_5', 'column_6'])
  })
})

describe('decodeCsv', () => {
  it('reads invalid UTF-8 as Windows-1252', () => {
    expect(decodeCsv(new Uint8Array([0x80, 0x20, 0xe9]))).toEqual({ text: '€ é', encoding: 'windows-1252', bom: false })
    expect(decodeCsv(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toEqual({ text: 'a', encoding: 'utf-8', bom: true })
  })
})

describe('readCsv', () => {
  it('pads short records with nulls and widens the table for long ones', () => {
    const t = readCsv(bytes('a,b\n1\n1,2,3\n'))
    expect(t.columns.map((c) => c.name)).toEqual(['a', 'b', 'column_3'])
    expect(t.rows).toEqual([
      ['1', null, null],
      ['1', '2', '3']
    ])
  })

  it('rejects a file without records', () => {
    expect(() => readCsv(bytes('\n\n'))).toThrow(CsvError)
  })
})

describe('writeCsv', () => {
  it('writes back an unchanged file byte for byte', () => {
    const files = [
      // Excel in Italian: semicolons, BOM, CRLF, decimal commas, a quoted line break
      new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('id;nome;prezzo\r\n1;"vino; rosso";1,50\r\n2;"riga\r\ndue";\r\n')]),
      // Windows-1252, no final line ending
      new Uint8Array([...bytes('a,b\n'), 0x80, ...bytes(',caff'), 0xe8]),
      // one column with an empty cell
      bytes('a\n""\nx\n'),
      bytes('n\tt\n007\t1.50\n')
    ]
    for (const file of files) expect(roundTrip(file)).toEqual(file)
  })

  it('refuses characters Windows-1252 cannot hold', () => {
    const t = readCsv(new Uint8Array([...bytes('a\n'), 0xe8]))
    expect(() => writeCsv(['a'], [['日本']], t.format)).toThrow(CsvError)
  })
})
