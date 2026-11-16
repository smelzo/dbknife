import { createServer } from 'node:net'
import { connectSsh, SshError, type SshOptions } from './ssh'

export interface TunnelOptions extends SshOptions {
  dstHost: string
  dstPort: number
}

export interface Tunnel {
  localPort: number
  isOpen(): boolean
  close(): void
}

/** Opens an SSH connection and a local TCP listener forwarding to dstHost:dstPort. */
export async function openTunnel(opts: TunnelOptions): Promise<Tunnel> {
  const client = await connectSsh(opts)
  return new Promise((resolve, reject) => {
    let open = true
    const server = createServer((socket) => {
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
    client.on('close', () => {
      open = false
      server.close()
    })
    server.on('error', (err) => reject(new SshError(err.message, 'network')))
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const localPort = typeof address === 'object' && address ? address.port : 0
      resolve({
        localPort,
        isOpen: () => open,
        close: () => {
          open = false
          server.close()
          client.end()
        }
      })
    })
  })
}
