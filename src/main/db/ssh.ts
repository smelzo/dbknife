import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Duplex } from 'node:stream'
import { Client, utils, type AnyAuthMethod, type ConnectConfig } from 'ssh2'
import { t } from '@shared/i18n'

export interface SshOptions {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: Buffer
  passphrase?: string
  /** Accepts or rejects the server host key fingerprint (SHA256, base64). */
  verifyHostKey: (fingerprint: string) => boolean
}

/** One connection of a chain the OpenSSH configuration describes: the destination, or a ProxyJump host on the way to it. */
export interface SshHop {
  /** The host as the configuration names it: what the error of a jump host calls it. */
  alias: string
  host: string
  port: number
  username: string
  /** Private key files, tried in this order after the agent; those that do not exist are skipped. */
  keyFiles: string[]
  /** False with IdentitiesOnly: the keys of the agent are not offered. */
  agent: boolean
  /** The name its host key is known under: HostKeyAlias, else the host name. */
  hostKeyName: string
}

export class SshError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'passphrase' | 'hostkey' | 'network'
  ) {
    super(message)
  }
}

const agentSocket = (): string | undefined => process.env.SSH_AUTH_SOCK ?? (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined)

/**
 * Opens one SSH connection; resolves once the client is ready, rejects with an SshError.
 * `authFailed` is the error of a server that accepted none of the methods.
 */
function open(
  config: ConnectConfig,
  hostName: string,
  verifyHostKey: (fingerprint: string) => boolean,
  authFailed = (): SshError => new SshError(t('main.ssh.authFailed'), 'auth')
): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    let ready = false
    let hostKeyRejected = false

    client.on('ready', () => {
      ready = true
      resolve(client)
    })
    // Stays attached after 'ready': an 'error' event without a listener would crash the main process.
    client.on('error', (err: Error & { level?: string }) => {
      // An agent that cannot be reached (on Windows its pipe is always tried, also with the service
      // stopped) is not the end: ssh2 goes on with the next method, then emits 'ready' or its own error.
      if (ready || err.level === 'agent') return
      if (hostKeyRejected) reject(new SshError(t('main.ssh.hostKeyChanged', { host: hostName }), 'hostkey'))
      else if (err.level === 'client-authentication') reject(authFailed())
      else if (/passphrase/i.test(err.message)) reject(new SshError(err.message, 'passphrase'))
      else reject(new SshError(t('main.ssh.error', { error: err.message }), 'network'))
    })

    // The server closing while authenticating emits no error: without this the promise would stay pending.
    client.on('close', () => {
      if (!ready) reject(new SshError(t('main.channel.connectionLost'), 'network'))
    })

    try {
      client.connect({
        ...config,
        readyTimeout: 15000,
        keepaliveInterval: 30000,
        hostVerifier: (key: Buffer) => {
          const ok = verifyHostKey(createHash('sha256').update(key).digest('base64'))
          hostKeyRejected = !ok
          return ok
        }
      })
    } catch (err) {
      // ssh2 throws synchronously when the private key cannot be parsed
      const message = (err as Error).message
      reject(new SshError(message, /passphrase|encrypted/i.test(message) ? 'passphrase' : 'network'))
    }
  })
}

/** Opens an SSH connection; resolves once the client is ready, rejects with an SshError. */
export function connectSsh(opts: SshOptions): Promise<Client> {
  return open(
    {
      host: opts.host,
      port: opts.port,
      username: opts.username,
      password: opts.password || undefined,
      privateKey: opts.privateKey,
      passphrase: opts.passphrase || undefined,
      agent: agentSocket()
    },
    opts.host,
    opts.verifyHostKey
  )
}

/**
 * Connects one hop with the methods OpenSSH would try, in its order: the agent, each key file
 * that exists, the password when there is one. A key file its passphrase does not open is
 * left out; when the server then accepts nothing the error asks for the passphrase
 * (`passphrase`), unless an empty one was given, which stands for "go on without that key":
 * then, as without such keys, it asks for the password (`auth`).
 */
async function connectHop(
  hop: SshHop,
  secrets: { password?: string; passphrase?: string },
  sock: Duplex | undefined,
  verifyHostKey: (name: string, fingerprint: string) => boolean
): Promise<Client> {
  const username = hop.username
  const methods: AnyAuthMethod[] = []
  const agent = hop.agent ? agentSocket() : undefined
  if (agent) methods.push({ type: 'agent', username, agent })
  let keyLocked = false
  for (const file of hop.keyFiles) {
    const data = await readFile(file).catch(() => undefined)
    if (!data) continue
    // parsed here and not by ssh2, which skips a key it cannot read without saying why
    let key = utils.parseKey(data)
    const encrypted = key instanceof Error && /encrypted/i.test(key.message)
    if (encrypted && secrets.passphrase) key = utils.parseKey(data, secrets.passphrase)
    if (key instanceof Error) keyLocked ||= encrypted
    else methods.push({ type: 'publickey', username, key })
  }
  if (secrets.password) methods.push({ type: 'password', username, password: secrets.password })
  const askPassphrase = keyLocked && secrets.passphrase !== ''
  return open(
    { host: hop.host, port: hop.port, username, sock, authHandler: methods },
    hop.hostKeyName,
    (fingerprint) => verifyHostKey(`${hop.hostKeyName}:${hop.port}`, fingerprint),
    () => (askPassphrase ? new SshError(t('main.ssh.keyLocked'), 'passphrase') : new SshError(t('main.ssh.authFailed'), 'auth'))
  )
}

/** A stream to `host:port` opened by the machine `client` is connected to. */
const forward = (client: Client, host: string, port: number): Promise<Duplex> =>
  new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, host, port, (err, stream) => (err ? reject(new SshError(t('main.ssh.error', { error: err.message }), 'network')) : resolve(stream)))
  })

/**
 * Opens the SSH connections of a chain, each through the one before it (ProxyJump), and
 * resolves with the last: the destination. The secrets are those of the destination; a jump
 * host that does not let in with the agent or a key file is an error naming it, which asks
 * for nothing. The connections of the jump hosts end with the one returned.
 * `verifyHostKey` receives the name of each host key as `<name>:<port>`.
 */
export async function connectSshChain(
  hops: SshHop[],
  secrets: { password?: string; passphrase?: string },
  verifyHostKey: (name: string, fingerprint: string) => boolean
): Promise<Client> {
  const jumps: Client[] = []
  const endJumps = (): void => {
    // from the nearest to the destination back: each one carries those after it
    for (const jump of jumps.reverse()) jump.end()
  }
  try {
    for (const hop of hops.slice(0, -1)) {
      try {
        const through = jumps.at(-1)
        // the empty passphrase: nothing is asked for a jump host, it goes on without the keys a passphrase protects
        jumps.push(await connectHop(hop, { passphrase: '' }, through && (await forward(through, hop.host, hop.port)), verifyHostKey))
      } catch (err) {
        if (!(err instanceof SshError)) throw err
        throw new SshError(t('main.ssh.jumpFailed', { host: hop.alias, error: err.message }), err.kind === 'hostkey' ? 'hostkey' : 'network')
      }
    }
    const destination = hops[hops.length - 1]
    const through = jumps.at(-1)
    const client = await connectHop(destination, secrets, through && (await forward(through, destination.host, destination.port)), verifyHostKey)
    client.on('close', endJumps)
    return client
  } catch (err) {
    endJumps()
    throw err
  }
}
