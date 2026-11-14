import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:net'
import { Client } from 'ssh2'
import { t } from '@shared/i18n'

export interface TunnelOptions {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: Buffer
  passphrase?: string
  dstHost: string
  dstPort: number
  /** Accepts or rejects the server host key fingerprint (SHA256, base64). */
  verifyHostKey: (fingerprint: string) => boolean
}

export interface Tunnel {
  localPort: number
  isOpen(): boolean
  close(): void
}

export class TunnelError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'passphrase' | 'hostkey' | 'network'
  ) {
    super(message)
  }
}

/** Opens an SSH connection and a local TCP listener forwarding to dstHost:dstPort. */
export function openTunnel(opts: TunnelOptions): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    let server: Server | undefined
    let open = false
    let hostKeyRejected = false

    client.on('ready', () => {
      open = true
      server = createServer((socket) => {
        client.forwardOut('127.0.0.1', socket.localPort ?? 0, opts.dstHost, opts.dstPort, (err, stream) => {
          if (err) {
            socket.destroy()
            return
          }
          socket.pipe(stream).pipe(socket)
          socket.on('error', () => stream.close())
          stream.on('error', () => socket.destroy())
        })
      })
      server.on('error', (err) => reject(new TunnelError(err.message, 'network')))
      server.listen(0, '127.0.0.1', () => {
        const address = server!.address()
        const localPort = typeof address === 'object' && address ? address.port : 0
        resolve({
          localPort,
          isOpen: () => open,
          close: () => {
            open = false
            server?.close()
            client.end()
          }
        })
      })
    })
    client.on('error', (err: Error & { level?: string }) => {
      if (open) return
      if (hostKeyRejected) reject(new TunnelError(t('main.ssh.hostKeyChanged', { host: opts.host }), 'hostkey'))
      else if (err.level === 'client-authentication') reject(new TunnelError(t('main.ssh.authFailed'), 'auth'))
      else if (/passphrase/i.test(err.message)) reject(new TunnelError(err.message, 'passphrase'))
      else reject(new TunnelError(t('main.ssh.error', { error: err.message }), 'network'))
    })
    client.on('close', () => {
      open = false
      server?.close()
    })

    try {
      client.connect({
        host: opts.host,
        port: opts.port,
        username: opts.username,
        password: opts.password || undefined,
        privateKey: opts.privateKey,
        passphrase: opts.passphrase || undefined,
        agent: process.env.SSH_AUTH_SOCK,
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
      reject(new TunnelError(message, /passphrase|encrypted/i.test(message) ? 'passphrase' : 'network'))
    }
  })
}
