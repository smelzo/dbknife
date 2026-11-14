import { describe, expect, it } from 'vitest'
import { toCell, typeAffinity } from '../../../../src/main/db/drivers/sqlite-columns'

describe('typeAffinity', () => {
  // examples of https://www.sqlite.org/datatype3.html, 3.1.1
  it.each([
    ['INTEGER', ['INT', 'INTEGER', 'TINYINT', 'UNSIGNED BIG INT', 'INT8', 'FLOATING POINT']],
    ['TEXT', ['CHARACTER(20)', 'VARCHAR(255)', 'NATIVE CHARACTER(70)', 'nvarchar(100)', 'TEXT', 'CLOB']],
    ['BLOB', ['BLOB', '']],
    ['REAL', ['REAL', 'DOUBLE PRECISION', 'FLOAT']],
    ['NUMERIC', ['NUMERIC', 'DECIMAL(10,5)', 'BOOLEAN', 'DATE', 'DATETIME', 'STRING']]
  ])('maps declared types to %s affinity in the documented rule order', (affinity, types) => {
    for (const t of types) expect(typeAffinity(t), t).toBe(affinity)
  })
})

describe('toCell', () => {
  it('keeps integers beyond the safe range exact as strings', () => {
    expect(toCell(9007199254740993n)).toBe('9007199254740993')
    expect(toCell(-9007199254740993n)).toBe('-9007199254740993')
    expect(toCell(9007199254740991n)).toBe(9007199254740991)
  })
})
