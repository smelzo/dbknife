import { describe, expect, it } from 'vitest'
import type { ColumnInfo } from '@shared/types'
import { mysqlDialect } from '@shared/sql/dialect'
import { exportRows } from '@/workspace/format'

const col = (name: string, type = 'VARCHAR', kind: ColumnInfo['kind'] = 'text'): ColumnInfo => ({
  name,
  orgName: name,
  table: 't',
  orgTable: 't',
  schema: 'db',
  type,
  kind,
  length: 0,
  decimals: 0,
  charset: '',
  attributes: ''
})

describe('exportRows', () => {
  const columns = [col('id', 'INT', 'number'), col('note')]
  const rows = [
    [1, 'plain'],
    [2, 'a,b "quoted"\nline'],
    [3, null]
  ]

  it('quotes CSV fields containing separators, quotes or newlines (RFC 4180)', () => {
    expect(exportRows('csv', columns, rows, mysqlDialect)).toBe('id,note\n1,plain\n2,"a,b ""quoted""\nline"\n3,NULL')
  })

  it('writes INSERT statements with escaped literals and NULL', () => {
    expect(exportRows('sql', columns, rows, mysqlDialect, { schema: 'db', table: 't' }).split('\n')).toEqual([
      "INSERT INTO `db`.`t` (`id`, `note`) VALUES (1, 'plain');",
      "INSERT INTO `db`.`t` (`id`, `note`) VALUES (2, 'a,b \"quoted\"\\nline');",
      'INSERT INTO `db`.`t` (`id`, `note`) VALUES (3, NULL);'
    ])
  })
})
