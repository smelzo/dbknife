import type { WebContents } from 'electron'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, open, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { t } from '@shared/i18n'
import type { DumpOptions, ImportOptions, ToolInfo, ToolProgress } from '@shared/types'
import { expandHome, type DbSession } from '../db/session'

// Background jobs of the data export/import pages: the client tool
// processes, their progress and cancellation.

export interface Job {
  id: string
  sender: WebContents
  /** The running tool processes, killed when the job is cancelled. */
  children: Set<ChildProcess>
  /** Stop the job's other work (e.g. a running statement), called when the job is cancelled. */
  cancelers: Set<() => void>
  cancelled: boolean
  /** The message of the job's end when it is cancelled, instead of the generic one. */
  cancelledMessage?: string
  progress: number
}

export const jobs = new Map<string, Job>()

export function report(job: Job, p: Omit<ToolProgress, 'jobId' | 'progress'> & { progress?: number }): void {
  if (p.progress !== undefined) job.progress = p.progress
  if (!job.sender.isDestroyed()) job.sender.send('tools:progress', { ...p, jobId: job.id, progress: job.progress })
}

export function checkCancelled(job: Job): void {
  if (job.cancelled) throw new Error(t('tools.cancelled'))
}

/** Runs a job in the background, reporting its outcome; returns the job id at once. */
export function startJob(sender: WebContents, work: (job: Job) => Promise<string>): string {
  const job: Job = { id: randomUUID(), sender, children: new Set(), cancelers: new Set(), cancelled: false, progress: 0 }
  jobs.set(job.id, job)
  const run = async (): Promise<void> => {
    try {
      const message = await work(job)
      report(job, { progress: 1, message, log: message, done: true })
    } catch (err) {
      const error = job.cancelled ? (job.cancelledMessage ?? t('tools.cancelled')) : (err as Error).message
      const code = job.cancelled ? undefined : (err as { code?: unknown }).code
      report(job, { message: error, log: t('tools.job.error', { error }), done: true, error, ...(typeof code === 'string' ? { errorCode: code } : {}) })
    } finally {
      jobs.delete(job.id)
    }
  }
  setImmediate(() => void run())
  return job.id
}

/** Runs `<path> <args>` with a timeout (5 s by default); its stdout, or undefined when it fails. */
export function versionOutput(path: string, args: string[], timeout = 5000): Promise<string | undefined> {
  return new Promise((resolve) => execFile(path, args, { timeout }, (err, stdout) => resolve(err ? undefined : stdout)))
}

export interface RunIo {
  /** Fed to the tool's stdin. */
  input?: Readable
  /** File the tool's stdout is appended to. */
  output?: string
  /** Rewrites each line of stdout before it is written to `output`. */
  mapLine?: (line: string) => string
  /** Each stderr line; returns false for lines that are not worth logging. */
  onLine?: (line: string) => boolean
  /** Each stdout line, for tools reporting their progress there (without `output`); logged unless it returns false. */
  onOutput?: (line: string) => boolean
  env?: NodeJS.ProcessEnv
  /** The arguments as logged, when the real ones hold a temporary file. */
  shownArgs?: string
}

/** A stream applying `map` to each line. */
function lineMapper(map: (line: string) => string): Transform {
  let rest = ''
  return new Transform({
    transform(chunk: Buffer, _enc, done) {
      const lines = (rest + chunk.toString('utf8')).split('\n')
      rest = lines.pop()!
      done(null, lines.map((l) => map(l) + '\n').join(''))
    },
    flush(done) {
      done(null, rest ? map(rest) : '')
    }
  })
}

interface Started {
  child: ChildProcess
  /** Settles with the exit code once the process has exited and its streams are closed. */
  exited: Promise<number | null>
  /** The last stderr line logged. */
  lastError: () => string
}

/** Starts one tool process, registered in the job until it exits, logging its stderr. */
function start(job: Job, tool: ToolInfo, args: string[], io: RunIo, stdin: boolean, stdout: boolean): Started {
  checkCancelled(job)
  report(job, { log: t('tools.job.running', { command: `${basename(tool.path)} ${io.shownArgs ?? args.join(' ')}` }) })
  const child = spawn(tool.path, args, {
    stdio: [stdin ? 'pipe' : 'ignore', stdout ? 'pipe' : 'ignore', 'pipe'],
    env: io.env ?? process.env
  })
  job.children.add(child)
  let lastError = ''
  createInterface({ input: child.stderr! }).on('line', (line) => {
    if (io.onLine?.(line) === false || !line.trim()) return
    lastError = line.trim()
    report(job, { log: line })
  })
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => resolve(code))
  }).finally(() => job.children.delete(child))
  return { child, exited, lastError: () => lastError }
}

/** The error of a tool that exited with `code`: its own message explains more than a broken pipe. */
const exitError = (tool: ToolInfo, code: number | null, lastError: string): Error =>
  new Error(lastError || t('tools.job.exitCode', { tool: basename(tool.path), code: String(code) }))

/** Runs one tool process; rejects with its last stderr line when it fails. */
export async function run(job: Job, tool: ToolInfo, args: string[], io: RunIo): Promise<void> {
  const { child, exited, lastError } = start(job, tool, args, io, !!io.input, !!(io.output || io.onOutput))
  if (io.onOutput && !io.output) {
    createInterface({ input: child.stdout! }).on('line', (line) => {
      if (io.onOutput!(line) !== false && line.trim()) report(job, { log: line })
    })
  }
  const streams: Promise<void>[] = []
  const kill = (err: unknown): never => {
    child.kill()
    throw err
  }
  if (io.output) {
    const file = createWriteStream(io.output, { flags: 'a' })
    streams.push((io.mapLine ? pipeline(child.stdout!, lineMapper(io.mapLine), file) : pipeline(child.stdout!, file)).catch(kill))
  }
  if (io.input) streams.push(pipeline(io.input, child.stdin!).catch(kill))
  const [code, ...piped] = await Promise.allSettled([exited, ...streams])
  checkCancelled(job)
  if (code.status === 'rejected') throw code.reason
  if (code.value !== 0) throw exitError(tool, code.value, lastError())
  const failed = piped.find((p) => p.status === 'rejected')
  if (failed) throw (failed as PromiseRejectedResult).reason
}

/**
 * Runs `from | to`: the stdout of the first tool is the stdin of the second (of `from.io` only `onLine`, `env` and
 * `shownArgs` apply). Settles once both have exited, rejecting with the error of the one that failed; when the
 * second fails the first is killed.
 */
export async function runPiped(
  job: Job,
  from: { tool: ToolInfo; args: string[]; io: RunIo },
  to: { tool: ToolInfo; args: string[]; io: RunIo }
): Promise<void> {
  const producer = start(job, from.tool, from.args, from.io, false, true)
  const { child } = producer
  // the consumer failed while the producer was running, so the producer's exit is not the cause
  let killed = false
  const consumer = run(job, to.tool, to.args, { ...to.io, input: child.stdout! }).catch((err) => {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      killed = true
      child.kill()
    }
    throw err
  })
  const [code, piped] = await Promise.allSettled([producer.exited, consumer])
  checkCancelled(job)
  if (!killed) {
    if (code.status === 'rejected') throw code.reason
    if (code.value !== 0) throw exitError(from.tool, code.value, producer.lastError())
  }
  if (piped.status === 'rejected') throw piped.reason
}

/** Gives `work` a temporary file `name` holding `content` (a secret: readable by the user only), deleted afterwards. */
export async function withSecretFile<T>(name: string, content: string, work: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'dbm-'))
  const file = join(dir, name)
  try {
    await writeFile(file, content, { mode: 0o600 })
    return await work(file)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export const fileName = (...parts: string[]): string => parts.join('_').replace(/[/\\:\0]/g, '_') + '.sql'

/** The first 8 KiB of a file, where dump tools write what a file holds. */
export async function fileHead(file: string): Promise<string> {
  const fh = await open(file, 'r')
  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(8192), 0, 8192, 0)
    return buffer.toString('utf8', 0, bytesRead)
  } finally {
    await fh.close()
  }
}

/** The files to import: the file, or a dump project folder's .sql files in the order of `rank` (then by name). */
export async function importFiles(o: ImportOptions, rank: (file: string) => Promise<number>): Promise<string[]> {
  const source = expandHome(o.source.path)
  if (o.source.kind === 'file') return [source]
  const files = (await readdir(source))
    .filter((n) => n.toLowerCase().endsWith('.sql'))
    .sort()
    .map((n) => join(source, n))
  const ranks = await Promise.all(files.map(rank))
  return files.map((f, i) => ({ f, r: ranks[i] })).sort((a, b) => a.r - b.r).map((x) => x.f)
}

/** Feeds each file to `runOne` (a client tool reading stdin), reporting the progress by bytes read. */
export async function importEach(job: Job, files: string[], runOne: (input: Readable) => Promise<void>): Promise<void> {
  const sizes = await Promise.all(files.map(async (f) => (await stat(f)).size))
  const total = sizes.reduce((a, b) => a + b, 0)
  let done = 0
  for (const [i, file] of files.entries()) {
    const message = t('tools.import.importing', { file: basename(file) })
    report(job, { progress: total ? done / total : 0, message, log: message })
    const input = createReadStream(file)
    let last = 0
    input.on('data', (chunk) => {
      done += chunk.length
      if (Date.now() - last < 100) return
      last = Date.now()
      report(job, { progress: total ? done / total : 0, message })
    })
    await runOne(input)
    done = sizes.slice(0, i + 1).reduce((a, b) => a + b, 0)
  }
}

/** The dump and client tools of an engine. */
export interface ToolSet {
  find(session: DbSession): Promise<{ dump?: ToolInfo; client?: ToolInfo }>
  exportDump(job: Job, session: DbSession, o: DumpOptions): Promise<string>
  importDump(job: Job, session: DbSession, o: ImportOptions): Promise<string>
}
