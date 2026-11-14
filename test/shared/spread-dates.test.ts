import { describe, expect, it } from 'vitest'
import { excelSerialToIso } from '@shared/spread-dates'

// oracle: Excel's 1900 date system, which matches the 1899-12-30 epoch from serial 61 on
describe('excelSerialToIso', () => {
  it('gives the date alone for a whole serial', () => {
    expect(excelSerialToIso(45000)).toBe('2023-03-15')
    expect(excelSerialToIso(61)).toBe('1900-03-01')
  })

  it('adds the time of day for a fraction', () => {
    expect(excelSerialToIso(45000.5)).toBe('2023-03-15 12:00:00')
  })

  it('rounds the seconds instead of cutting them', () => {
    expect(excelSerialToIso(45000 + 59.6 / 86400)).toBe('2023-03-15 00:01:00')
  })
})
