// The remote helper (helper/, dbknife-sqlite) at the other end of an SSH
// connection: uploaded to ~/.cache/dbknife of the remote machine when it is not
// there, started with exec and spoken to in JSON lines on its stdin and stdout
// (wire.ts). Only exec is asked of the server: no SFTP, no port, no service.
import { constants } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type { Client, ClientChannel } from 'ssh2'
import { t } from '@shared/i18n'
import type { RemoteListing } from '@shared/types'
// types only: the module is the entry of a utility process
import type { SqliteRequest, SqliteResponse } from '../drivers/sqlite-process'
import { fromWire, toWire, type WireResponse } from './wire'

type WireCommand = ReturnType<typeof toWire>

/** Folder of the helper, relative to the home folder: where exec starts its commands. */
const remoteDir = '.cache/dbknife'

/** `uname -sm` of the machines the helper is built for, and the suffix of its file in bin/remote. */
const platforms = new Map([
  ['Linux x86_64', 'linux-x64'],
  ['Linux aarch64', 'linux-arm64'],
  ['Darwin arm64', 'darwin-arm64'],
  ['Darwin x86_64', 'darwin-x64']
])

/** How much of the helper's stderr is kept, for the message of a failed start. */
const stderrKept = 2000

const failure = (message: string): WireResponse => ({ id: 0, error: { message } })

/**
 * One helper process on the remote machine, on the exec stream that started it:
 * what Connection (drivers/sqlite.ts) is for a local file.
 */
export class HelperLink {
  alive = true
  /** The end of what the helper wrote on stderr. */
  stderr = ''
  private seq = 0
  /** Requests waiting for their response, the oldest first: the helper answers in the order it reads. */
  private pending: ((res: WireResponse) => void)[] = []
  /** The pieces received of the line not yet complete: a response is one line, of any length. */
  private chunks: Buffer[] = []
  private size = 0

  constructor(private readonly stream: ClientChannel) {
    // never removed: ssh2 emits 'close' only once stdout has been read to its end
    stream.on('data', (chunk: Buffer) => this.receive(chunk))
    // always read: a channel nobody reads stalls the helper
    stream.stderr.on('data', (chunk: Buffer) => (this.stderr = (this.stderr + chunk.toString()).slice(-stderrKept)))
    stream.on('close', () => this.ended())
    stream.on('error', () => this.kill())
  }

  /** A request is waiting for its answer. */
  get busy(): boolean {
    return this.pending.length > 0
  }

  async request(req: SqliteRequest): Promise<SqliteResponse> {
    const started = performance.now()
    return fromWire(req, await this.send(toWire(req)), performance.now() - started)
  }

  /** The entries of a folder of the remote machine; an empty path is the home folder. */
  async list(path: string): Promise<RemoteListing> {
    const res = await this.send({ op: 'list', path })
    if ('error' in res) return { path, entries: [], error: res.error.message }
    const listing = res as RemoteListing
    return { path: listing.path, entries: listing.entries }
  }

  /**
   * Closes the stream, which for the helper is the end of stdin: it interrupts the
   * statement running and exits, an open transaction rolls back. The link is ended
   * at once, without waiting for the remote process.
   */
  kill(): void {
    this.ended()
    this.stream.close()
  }

  /** Never rejects: a request that gets no response gets an error as response. */
  private send(command: WireCommand): Promise<WireResponse> {
    if (!this.alive) return Promise.resolve(failure(t('main.sqlite.processEnded')))
    return new Promise((done) => {
      this.pending.push(done)
      // stdin stays open as long as the link lives: its end is the order to stop
      this.stream.write(JSON.stringify({ ...command, id: ++this.seq }) + '\n')
    })
  }

  private receive(chunk: Buffer): void {
    if (!this.alive) return
    let start = 0
    for (let end = chunk.indexOf(10); end >= 0; end = chunk.indexOf(10, start)) {
      this.keep(chunk.subarray(start, end))
      this.answer()
      start = end + 1
    }
    if (start < chunk.length) this.keep(chunk.subarray(start))
  }

  private keep(piece: Buffer): void {
    this.size += piece.length
    // no string holds a longer line: it cannot be decoded, so its bytes are let go
    if (this.size <= constants.MAX_STRING_LENGTH) this.chunks.push(piece)
    else this.chunks = []
  }

  /**
   * A complete line is the response to the oldest request, whatever its id: a
   * request the helper could not read is answered without one.
   */
  private answer(): void {
    const { chunks, size } = this
    this.chunks = []
    this.size = 0
    let res: WireResponse
    if (size > constants.MAX_STRING_LENGTH) res = failure(t('main.channel.resultTooLarge'))
    else {
      try {
        // inside the try: joining a line close to the limit may fail too
        const line = Buffer.concat(chunks, size).toString()
        const parsed: unknown = JSON.parse(line)
        // valid JSON, yet not a response: a number or a text printed by something else
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(line.slice(0, 200))
        res = parsed as WireResponse
      } catch (err) {
        res = failure(t('main.channel.badResponse', { error: (err as Error).message }))
      }
    }
    this.pending.shift()?.(res)
  }

  private ended(): void {
    this.alive = false
    this.chunks = []
    const waiting = this.pending
    this.pending = []
    for (const done of waiting) done(failure(t('main.sqlite.processEnded')))
  }
}

/** How a remote command ended; neither `code` nor `signal` when the connection ended first. */
interface Exit {
  code?: number | null
  signal?: string
  stderr: string
}

/** The message of a remote command that failed: what it wrote on stderr, else how it ended. */
function failed(key: 'main.channel.startFailed' | 'main.channel.installFailed', tool: string, exit: Exit): string {
  const stderr = exit.stderr.trim()
  if (stderr) return t(key, { error: stderr })
  if (exit.code == null && !exit.signal) return t('main.channel.connectionLost')
  return t(key, { error: t('tools.job.exitCode', { tool, code: String(exit.code ?? exit.signal) }) })
}

/** Runs a command of the remote machine to its end, with `input` as its stdin. */
function run(client: Client, command: string, input?: Buffer): Promise<Exit & { stdout: string }> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) return reject(err)
      let stdout = ''
      let stderr = ''
      stream.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
      stream.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
      stream.on('close', (code?: number | null, signal?: string) => resolve({ code, signal, stdout, stderr }))
      stream.end(input)
    })
  })
}

/** The helper for a remote machine: its file name there, which carries the hash of its content. */
interface HelperBinary {
  name: string
  content: Buffer
}

/** One `uname` per connection: Stop and a dropped link start the helper again on the same one. */
const binaries = new WeakMap<Client, Promise<HelperBinary>>()

async function findBinary(client: Client): Promise<HelperBinary> {
  const exit = await run(client, 'uname -sm')
  const platform = platforms.get(exit.stdout.trim())
  if (!platform) {
    const answer = exit.stdout.trim() || exit.stderr.trim()
    // no answer at all: the command did not run (connection lost, an account that runs no commands)
    throw new Error(answer ? t('main.channel.unsupportedPlatform', { platform: answer }) : failed('main.channel.startFailed', 'uname', exit))
  }
  // packaged: Resources/bin/remote (electron-builder.yml); otherwise bin/remote of the repo, as in spread.ts
  const dir = app.isPackaged ? join(process.resourcesPath, 'bin') : join(__dirname, '../../bin')
  const content = await readFile(join(dir, 'remote', `dbknife-sqlite-${platform}`))
  // no version to compare: another helper has another name, and is uploaded when it is not found
  return { name: `dbknife-sqlite-${createHash('sha256').update(content).digest('hex').slice(0, 12)}`, content }
}

function binaryFor(client: Client): Promise<HelperBinary> {
  let binary = binaries.get(client)
  if (!binary) {
    binary = findBinary(client)
    binaries.set(client, binary)
    binary.catch(() => binaries.delete(client))
  }
  return binary
}

/** The helper did not start. `missing`: the shell did not find the file or could not run it (exit codes 127 and 126). */
class StartError extends Error {
  constructor(
    message: string,
    readonly missing: boolean
  ) {
    super(message)
  }
}

/**
 * Starts the helper and resolves once it has answered a request: exec gives its
 * stream at once, also for a file that is not there, and the exit code comes later.
 * The command goes through `sh`, so that 127 and 126 mean the same whatever the
 * user's login shell is (csh ends with 1 for a missing file); `exec` leaves no
 * shell between SSH and the helper, which must see the end of stdin itself.
 */
function launch(client: Client, name: string): Promise<HelperLink> {
  return new Promise((resolve, reject) => {
    client.exec(`sh -c 'exec ./${remoteDir}/${name}'`, (err, stream) => {
      if (err) return reject(err)
      const link = new HelperLink(stream)
      stream.on('close', (code?: number | null, signal?: string) =>
        reject(new StartError(failed('main.channel.startFailed', name, { code, signal, stderr: link.stderr }), code === 126 || code === 127))
      )
      // 'status' is answered also with no database open, and the first request has id 1: any
      // other first line (a shell profile that prints) is not the helper's, and would shift every response
      link.request({ op: 'status' }).then((probe) => {
        // an ended link is reported by 'close', which knows why
        if (!link.alive) return
        if (probe.id === 1) return resolve(link)
        link.kill()
        reject(new StartError(t('main.channel.startFailed', { error: probe.error?.message ?? '' }), false))
      }, (err: unknown) => {
        link.kill()
        reject(err instanceof Error ? err : new Error(String(err)))
      })
    })
  })
}

/**
 * Uploads the helper with one exec, the file on stdin: readable and executable by
 * the user alone, in place only when complete, the helpers of other versions removed.
 * Complete means of the size sent: when the connection drops `cat` sees the end of
 * stdin and succeeds, and a cut file under the final name would never be replaced.
 * `wc` pads its count on macOS, hence the unquoted, numeric comparison.
 * The temporary file carries the id of its shell: two connections uploading at the
 * same time each write their own, and neither removes the other's; a failed upload
 * removes its own, which nothing else would.
 * `name` holds only [a-z0-9-] and the size is a number of this side: nothing the
 * user typed is part of the command.
 */
async function install(client: Client, { name, content }: HelperBinary): Promise<void> {
  const command = `sh -c 'umask 077; d=${remoteDir}; t=$d/${name}.$$.tmp; mkdir -p $d && cat > $t && [ $(wc -c < $t) -eq ${content.length} ] && chmod 700 $t && mv $t $d/${name} && find $d -name "dbknife-sqlite-*" ! -name "${name}" ! -name "${name}.*" -delete; s=$?; rm -f $t; exit $s'`
  const exit = await run(client, command, content)
  if (exit.code !== 0) throw new Error(failed('main.channel.installFailed', 'sh', exit))
}

/**
 * A helper running on the machine of an open SSH connection, uploaded first when
 * it is not there (or is another version, which has another name).
 */
export async function startHelper(client: Client): Promise<HelperLink> {
  const binary = await binaryFor(client)
  try {
    return await launch(client, binary.name)
  } catch (err) {
    if (!(err instanceof StartError && err.missing)) throw err
  }
  await install(client, binary)
  return launch(client, binary.name)
}
