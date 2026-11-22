import { app } from 'electron'
import { parseArgs } from 'node:util'
import { t } from '@shared/i18n'
import type { AlignRequest, ConnectionConfig, ToolProgress } from '@shared/types'
import type { DbSession } from './db/session'
import { openSession } from './ipc'
import { getConnection, listAlignments, recordAlignmentRun } from './store'
import { alignApply, NeedsConfirmation } from './tools/align-mysql'
import { cancelJob, startJob } from './tools/jobs'

// Command line mode: `dbknife --runjob <name>` runs a saved alignment without a
// window, logging to the terminal, and records the run with via 'cli'. Exit
// code: 0 done, 1 failed, 2 bad arguments or no such alignment. Recreations are
// never confirmed here (nobody can answer), saved drops are.

/** The arguments after the program: argv is [electron, out/main/index.js, …] in dev and e2e, [DBKnife, …] packaged. */
export const cliArgs = (): string[] => process.argv.slice(app.isPackaged ? 1 : 2)

export const isCliRun = (): boolean => cliArgs().some((a) => a === '--runjob' || a.startsWith('--runjob='))

/** The name of `--runjob <name>` or `--runjob=<name>`, undefined when missing or empty; switches added by Chromium or macOS are ignored. */
function jobName(): string | undefined {
  const { values } = parseArgs({ args: cliArgs(), options: { runjob: { type: 'string' } }, strict: false })
  const name = values.runjob
  return typeof name === 'string' && name.trim() ? name : undefined
}

const out = (line: string): void => void process.stdout.write(`${line}\n`)
const err = (line: string): void => void process.stderr.write(`${line}\n`)

/** A session on the saved secrets, or the message of why it cannot be opened. */
async function open(config: ConnectionConfig): Promise<DbSession | string> {
  const { result, session } = await openSession(config, {})
  if (session) return session
  if (result.needs === 'password' && !result.error) return t('cli.passwordMissing', { name: config.name })
  if (result.needs === 'sshPassword' || result.needs === 'sshPassphrase') return t('cli.sshSecretMissing', { name: config.name })
  return t('tools.align.openFailed', { connection: config.name, error: result.error?.message ?? '' })
}

/** Runs the alignment named by `--runjob`; the exit code. */
export async function runCli(): Promise<number> {
  const name = jobName()
  if (name === undefined) {
    err(t('cli.usage'))
    return 2
  }
  const found = listAlignments().filter((a) => a.name === name)
  if (found.length !== 1) {
    err(found.length ? t('cli.ambiguous', { count: found.length, name }) : t('cli.notFound', { name }))
    return 2
  }
  const [a] = found
  // from here every outcome is a run of the alignment
  const record = (ok: boolean, message: string): number => {
    recordAlignmentRun(a.id, { at: Date.now(), via: 'cli', ok, message })
    if (ok) out(message)
    else err(message)
    return ok ? 0 : 1
  }
  // Ctrl-C or a cron timeout: Electron turns SIGINT/SIGTERM into a quit (Node's signal handlers are not called);
  // the quit waits for the job, which the engine cancels putting back what it changed
  let stopped = false
  let jobId = ''
  const stop = (e: Electron.Event): void => {
    e.preventDefault()
    stopped = true
    cancelJob(jobId)
  }
  app.on('before-quit', stop)
  const sessions: DbSession[] = []
  try {
    const sourceConfig = getConnection(a.source.connectionId)
    const targetConfig = getConnection(a.target.connectionId)
    if (!sourceConfig || !targetConfig) return record(false, t('admin.align.connectionMissingFor', { name: a.name }))
    if (sourceConfig.engine !== 'mysql' || targetConfig.engine !== 'mysql') return record(false, t('tools.align.unsupported'))
    const source = await open(sourceConfig)
    if (typeof source === 'string') return record(false, source)
    sessions.push(source)
    // the same connection at both ends: one session, as in the app
    let target = source
    if (targetConfig.id !== sourceConfig.id) {
      const opened = await open(targetConfig)
      if (typeof opened === 'string') return record(false, opened)
      sessions.push(opened)
      target = opened
    }
    const r: AlignRequest = {
      source: { sessionId: source.id, schema: a.source.schema },
      target: { sessionId: target.id, schema: a.target.schema },
      objects: a.objects,
      drop: a.drop,
      options: a.options,
      confirmed: { recreate: [], drop: a.drop },
      alignmentId: a.id
    }
    if (stopped) return record(false, t('tools.cancelled'))
    // the job's end tells only the error code: the exception itself says what is to confirm
    let failure: unknown
    const end = await new Promise<ToolProgress>((resolve) => {
      jobId = startJob(
        (p) => {
          if (p.done) resolve(p)
          else if (p.log) out(p.log)
        },
        async (job) => {
          try {
            return await alignApply(job, source, target, r)
          } catch (e) {
            failure = e
            throw e
          }
        }
      )
    })
    if (end.error === undefined) return record(true, end.message ?? '')
    if (end.errorCode === 'needsConfirmation' && failure instanceof NeedsConfirmation) {
      return record(false, t('cli.needsConfirmation', { tables: failure.pending.map((o) => o.name).join(', ') }))
    }
    return record(false, end.error)
  } catch (e) {
    return record(false, (e as Error).message)
  } finally {
    app.off('before-quit', stop)
    for (const s of sessions) s.close()
  }
}
