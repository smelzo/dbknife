import { describe, expect, it } from 'vitest'
import { triggerTiming } from '@/workspace/catalog/sqlite'

describe('triggerTiming', () => {
  it('reads timing and event from the CREATE TRIGGER header', () => {
    expect(triggerTiming('CREATE TRIGGER t AFTER UPDATE OF a, b ON x BEGIN SELECT 1; END')).toEqual({ timing: 'AFTER', event: 'UPDATE' })
    expect(triggerTiming('create temp trigger if not exists main.t instead  of delete on v begin select 1; end')).toEqual({
      timing: 'INSTEAD OF',
      event: 'DELETE'
    })
  })

  it('defaults the timing to BEFORE, as SQLite does', () => {
    expect(triggerTiming('CREATE TRIGGER t INSERT ON x BEGIN SELECT 1; END')).toEqual({ timing: 'BEFORE', event: 'INSERT' })
  })

  it('is not misled by keywords inside a quoted trigger name', () => {
    expect(triggerTiming('CREATE TRIGGER "after insert" BEFORE DELETE ON x BEGIN SELECT 1; END')).toEqual({ timing: 'BEFORE', event: 'DELETE' })
  })
})
