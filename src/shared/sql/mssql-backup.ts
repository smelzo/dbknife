import { mssqlDialect as d } from './dialect'

// SQL Server backup and restore of .bak files on the server's disk, and the
// dates of SQL Server Agent's job history.

/** A file of a backup: its logical name and where the restore puts it. */
export interface RestoreMove {
  logical: string
  physical: string
}

/** A full backup that leaves the database's backup chain alone (COPY_ONLY), overwriting the file. */
export const backupStatement = (database: string, path: string): string =>
  `BACKUP DATABASE ${d.quoteIdentifier(database)} TO DISK = ${d.quoteString(path)} WITH COPY_ONLY, INIT, CHECKSUM, STATS = 10`

/** The data and log files a backup holds (LogicalName, Type, PhysicalName, …). */
export const fileListStatement = (path: string): string => `RESTORE FILELISTONLY FROM DISK = ${d.quoteString(path)}`

export function restoreStatement(database: string, path: string, moves: RestoreMove[], replace: boolean): string {
  const options = [...moves.map((m) => `MOVE ${d.quoteString(m.logical)} TO ${d.quoteString(m.physical)}`), 'STATS = 10']
  if (replace) options.push('REPLACE')
  return `RESTORE DATABASE ${d.quoteIdentifier(database)} FROM DISK = ${d.quoteString(path)} WITH ${options.join(', ')}`
}

/** `name` in the server folder `dir`, joined with the separator `dir` uses (\ on Windows, / on Linux). */
export function serverPath(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/'
  return dir.replace(/[\\/]+$/, '') + sep + name
}

const fileExtensions: Record<string, string> = { D: '.mdf', L: '.ldf' }

/**
 * Where a restore as `database` puts a file of the backup: `<dir>/<database>_<logical>`, with .mdf for
 * data (D) and .ldf for log (L) files; FILESTREAM (S) and full-text (F) containers are folders, without one.
 */
export const physicalPath = (dir: string, database: string, logical: string, type: string): string =>
  serverPath(dir, `${database}_${logical}${fileExtensions[type] ?? ''}`)

/** SQL Server Agent's date (yyyymmdd) and time (hhmmss) integers as `yyyy-mm-dd hh:mm:ss`; '' for no date (0). */
export function agentDateTime(date: number, time: number): string {
  if (!date) return ''
  const d = String(date).padStart(8, '0')
  const t = String(time).padStart(6, '0')
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)} ${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`
}
