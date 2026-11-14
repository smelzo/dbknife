import { describe, expect, it } from 'vitest'
import { agentDateTime, backupStatement, fileListStatement, physicalPath, restoreStatement } from '@shared/sql/mssql-backup'

describe('backup and restore statements', () => {
  it('quotes a database name holding ] and a path holding a quote', () => {
    expect(backupStatement('a]b', "C:\\Backup\\it's.bak")).toBe(
      "BACKUP DATABASE [a]]b] TO DISK = N'C:\\Backup\\it''s.bak' WITH COPY_ONLY, INIT, CHECKSUM, STATS = 10"
    )
    expect(fileListStatement("/var/opt/mssql/it's.bak")).toBe("RESTORE FILELISTONLY FROM DISK = N'/var/opt/mssql/it''s.bak'")
  })

  it('moves every file and adds REPLACE only when asked', () => {
    const moves = [
      { logical: "da'ta", physical: 'C:\\Data\\x_data.mdf' },
      { logical: 'log', physical: 'C:\\Data\\x_log.ldf' }
    ]
    expect(restoreStatement('x]', 'C:\\b.bak', moves, false)).toBe(
      "RESTORE DATABASE [x]]] FROM DISK = N'C:\\b.bak' WITH MOVE N'da''ta' TO N'C:\\Data\\x_data.mdf', MOVE N'log' TO N'C:\\Data\\x_log.ldf', STATS = 10"
    )
    expect(restoreStatement('x', 'C:\\b.bak', [], true)).toBe("RESTORE DATABASE [x] FROM DISK = N'C:\\b.bak' WITH STATS = 10, REPLACE")
  })
})

describe('physicalPath', () => {
  it('keeps the Windows separator of the folder without doubling a trailing one', () => {
    expect(physicalPath('C:\\Data\\', 'shop', 'shop_data', 'D')).toBe('C:\\Data\\shop_shop_data.mdf')
    expect(physicalPath('C:\\Data', 'shop', 'shop_log', 'L')).toBe('C:\\Data\\shop_shop_log.ldf')
  })

  it('uses / for a Linux folder', () => {
    expect(physicalPath('/var/opt/mssql/data', 'shop', 'shop', 'D')).toBe('/var/opt/mssql/data/shop_shop.mdf')
    expect(physicalPath('/var/opt/mssql/data/', 'shop', 'shop_log', 'L')).toBe('/var/opt/mssql/data/shop_shop_log.ldf')
  })

  it('gives FILESTREAM and full-text containers a folder name without extension', () => {
    expect(physicalPath('C:\\Data\\', 'shop', 'docs', 'S')).toBe('C:\\Data\\shop_docs')
    expect(physicalPath('/var/opt/mssql/data', 'shop', 'ftcat', 'F')).toBe('/var/opt/mssql/data/shop_ftcat')
  })
})

describe('agentDateTime', () => {
  it('pads the time of a run before 10 am', () => {
    expect(agentDateTime(20261113, 93005)).toBe('2026-11-13 09:30:05')
    expect(agentDateTime(20261113, 0)).toBe('2026-11-13 00:00:00')
  })

  it('is empty for a job that never ran', () => {
    expect(agentDateTime(0, 0)).toBe('')
  })
})
