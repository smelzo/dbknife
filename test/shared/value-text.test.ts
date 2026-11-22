import { describe, expect, it } from 'vitest'
import { valueText } from '@shared/value-text'

describe('valueText', () => {
  // the bugs String() has on driver values: a JSON column read as '[object Object]', a binary
  // value that crossed IPC (a Uint8Array) read as its bytes
  it('writes objects as JSON and binary data as UTF-8, never [object Object] or 1,2,3', () => {
    expect(valueText({ a: 1 })).toBe('{"a":1}')
    expect(valueText([1, 'x'])).toBe('[1,"x"]')
    expect(valueText(new TextEncoder().encode('città'))).toBe('città')
  })

  it('writes null and undefined as an empty string, scalars as they are', () => {
    expect(valueText(null)).toBe('')
    expect(valueText(undefined)).toBe('')
    expect(valueText('abc')).toBe('abc')
    expect(valueText(42)).toBe('42')
    expect(valueText(10n)).toBe('10')
    expect(valueText(false)).toBe('false')
  })
})
