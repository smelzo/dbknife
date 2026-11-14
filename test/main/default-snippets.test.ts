import { describe, expect, it } from 'vitest'
import type { Snippet } from '@shared/types'
import { withDefaultSnippets } from '../../src/main/default-snippets'

const noWorkbench = (): null => null
const engines = (list: Snippet[]): string[] => [...new Set(list.map((s) => s.engine))].sort()

describe('withDefaultSnippets', () => {
  it('keeps the snippets of a file written before engines as MySQL ones and adds the other collections', () => {
    const legacy = [{ id: 'a', category: 'My Snippets', title: 'Mine', sql: 'SELECT 1' }] as Snippet[]
    const list = withDefaultSnippets(legacy, noWorkbench)
    expect(list.filter((s) => s.engine === 'mysql')).toEqual([{ ...legacy[0], engine: 'mysql' }])
    expect(engines(list)).toEqual(['mssql', 'mysql', 'postgres', 'sqlite'])
  })

  it('does not bring back the collection of an engine whose snippets were all deleted', () => {
    const stored: Snippet[] = [{ id: 'a', engine: 'mysql', category: 'My Snippets', title: 'Mine', sql: 'SELECT 1' }]
    expect(withDefaultSnippets(stored, noWorkbench)).toEqual(stored)
  })

  it('starts from MySQL Workbench snippets when there is no file of ours', () => {
    const wb: Snippet[] = [{ id: 'w', engine: 'mysql', category: 'My Snippets', title: 'From Workbench', sql: 'SELECT 2' }]
    const list = withDefaultSnippets(null, () => wb)
    expect(list.filter((s) => s.engine === 'mysql')).toEqual(wb)
    expect(engines(list)).toEqual(['mssql', 'mysql', 'postgres', 'sqlite'])
  })
})
