import { createHash } from 'node:crypto'
import { Client } from 'ssh2'
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

export class SshError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'passphrase' | 'hostkey' | 'network'
  ) {
    super(message)
  }
}

/** Opens an SSH connection; resolves once the client is ready, rejects with an SshError. */
export function connectSsh(opts: SshOptions): Promise<Client> {
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
      if (hostKeyRejected) reject(new SshError(t('main.ssh.hostKeyChanged', { host: opts.host }), 'hostkey'))
      else if (err.level === 'client-authentication') reject(new SshError(t('main.ssh.authFailed'), 'auth'))
      else if (/passphrase/i.test(err.message)) reject(new SshError(err.message, 'passphrase'))
      else reject(new SshError(t('main.ssh.error', { error: err.message }), 'network'))
    })

    // The server closing while authenticating emits no error: without this the promise would stay pending.
    client.on('close', () => {
      if (!ready) reject(new SshError(t('main.channel.connectionLost'), 'network'))
    })

    try {
      client.connect({
        host: opts.host,
        port: opts.port,
        username: opts.username,
        password: opts.password || undefined,
        privateKey: opts.privateKey,
        passphrase: opts.passphrase || undefined,
        agent: process.env.SSH_AUTH_SOCK ?? (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined),
        readyTimeout: 15000,
        keepaliveInterval: 30000,
        hostVerifier: (key: Buffer) => {
          const ok = opts.verifyHostKey(createHash('sha256').update(key).digest('base64'))
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
