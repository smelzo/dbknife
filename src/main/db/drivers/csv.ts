import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { app } from 'electron'
import type { CsvFormat } from '@shared/csv'
import { t } from '@shared/i18n'
import type { ConnectionConfig, CsvSaveResult, CsvStatus, DbError } from '@shared/types'
import { expandHome } from '../session'
import { SqliteSession } from './sqlite'

/** Folder of the hidden databases, one subfolder per app process. */
const workRoot = (): string => join(app.getPath('userData'), 'csv-work')

function running(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Removes the hidden databases a crashed app process left; those of a running one (dev and packaged app at once) stay. */
export function removeStaleCsvWork(): void {
  let dirs: string[]
  try {
    dirs = readdirSync(workRoot())
  } catch {
    return
  }
  for (const dir of dirs) {
    const pid = Number(dir)
    if (pid === process.pid || (Number.isInteger(pid) && pid > 0 && running(pid))) continue
    rmSync(join(workRoot(), dir), { recursive: true, force: true })
  }
}

/** What tells a file changed on disk since it was read or written. */
function stampOf(path: string): string {
  try {
    const s = statSync(path)
    return `${s.mtimeMs}:${s.size}`
  } catch {
    return ''
  }
}

/**
 * A CSV file as the only table of a hidden SQLite database: the file is read
 * when the session opens and written back only by save().
 */
export class CsvSession extends SqliteSession {
  readonly path: string
  readonly table: string
  private readonly work: string
  private format?: CsvFormat
  /** data_version of the auxiliary connection when the file was last read or written. */
  private savedVersion = ''
  private stamp = ''

  constructor(config: ConnectionConfig, safeUpdates = false) {
    const work = join(workRoot(), String(process.pid), `${randomUUID()}.db`)
    super({ ...config, file: work }, safeUpdates)
    this.work = work
    this.path = resolve(expandHome(config.csv!))
    this.table = basename(this.path, extname(this.path))
  }

  private message(error: DbError): string {
    if (error.code === 'CSV_EMPTY') return t('main.csv.empty', { file: this.path })
    if (error.code === 'CSV_UNENCODABLE') return t('main.csv.unencodable', { character: error.message, encoding: this.format?.encoding ?? '' })
    return error.message
  }

  /** Changes whenever another connection (the user one) commits. */
  private async dataVersion(): Promise<string> {
    const r = await this.query('PRAGMA data_version')
    if (r.error) throw new Error(r.error.message)
    return String(Object.values(r.rows[0])[0])
  }

  async open(): Promise<void> {
    mkdirSync(dirname(this.work), { recursive: true })
    await super.open()
    try {
      const r = await this.userRequest({ op: 'importCsv', file: this.path, table: this.table })
      if (!r || r.error) throw new Error(r?.error ? this.message(r.error) : t('main.sqlite.processEnded'))
      this.format = r.csv
      this.info = { ...this.info, endpoint: { host: this.path, port: 0 } }
      this.savedVersion = await this.dataVersion()
      this.stamp = stampOf(this.path)
    } catch (err) {
      this.close()
      throw err
    }
  }

  async status(): Promise<CsvStatus> {
    const [version, r] = await Promise.all([this.dataVersion(), this.userRequest({ op: 'status' })])
    return { changed: version !== this.savedVersion, transaction: !!r?.transaction }
  }

  /** Writes the table's committed rows to the file; without `overwrite` a file changed on disk is left alone. */
  async save(overwrite: boolean): Promise<CsvSaveResult> {
    try {
      if (!overwrite && stampOf(this.path) !== this.stamp) return { conflict: true }
      const exists = await this.query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, [this.table])
      if (exists.error) return { error: exists.error.message }
      if (!exists.rows.length) return { error: t('main.csv.noTable', { table: this.table }) }
      // read before writing: a commit in between shows the file as changed again
      const version = await this.dataVersion()
      const r = await this.auxRequest({ op: 'exportCsv', file: this.path, table: this.table, format: this.format! })
      if (r.error) return { error: this.message(r.error) }
      this.savedVersion = version
      this.stamp = stampOf(this.path)
      return { ok: true }
    } catch (err) {
      return { error: (err as Error).message }
    }
  }

  close(): void {
    super.close()
    for (const suffix of ['', '-journal', '-wal', '-shm']) rmSync(this.work + suffix, { force: true })
  }
}
