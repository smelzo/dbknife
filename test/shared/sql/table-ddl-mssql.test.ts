import { describe, expect, it } from 'vitest'
import type { ColumnDef, TableDef } from '@shared/sql/create-table'
import { alterTableSql } from '@shared/sql/table-ddl-mssql'

const column = (name: string, c: Partial<ColumnDef> = {}): ColumnDef => ({
  name,
  oldName: name,
  type: 'int',
  unsigned: false,
  zerofill: false,
  binary: false,
  charset: '',
  collation: '',
  nullable: true,
  default: '',
  autoIncrement: false,
  generated: null,
  comment: '',
  extra: '',
  ...c
})

const table = (columns: ColumnDef[]): TableDef => ({
  name: 't',
  columns,
  indexes: [],
  foreignKeys: [],
  otherDefinitions: [],
  options: { engine: '', charset: '', collation: '', rowFormat: '', autoIncrement: '', comment: '', other: '', partition: '' }
})

describe('mssql table DDL', () => {
  it('refuses to add or remove IDENTITY on an existing column, naming it', () => {
    const plain = table([column('id', { nullable: false }), column('n')])
    const identity = table([column('id', { nullable: false, autoIncrement: true, extra: 'IDENTITY(1,1)' }), column('n')])
    expect(() => alterTableSql('dbo', plain, identity)).toThrow(/\bid\b/)
    expect(() => alterTableSql('dbo', identity, plain)).toThrow(/\bid\b/)
  })

  it('changes the type of an identity column with ALTER COLUMN, which keeps the identity and takes no IDENTITY clause', () => {
    const from = table([column('id', { nullable: false, autoIncrement: true, extra: 'IDENTITY(5,2)' })])
    const to = table([{ ...from.columns[0], type: 'bigint' }])
    expect(alterTableSql('dbo', from, to)).toEqual(['ALTER TABLE [dbo].[t] ALTER COLUMN [id] bigint NOT NULL'])
  })
})
