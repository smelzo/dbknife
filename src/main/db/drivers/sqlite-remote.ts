import type { Client } from 'ssh2'
import { t } from '@shared/i18n'
import type { ConnectionConfig } from '@shared/types'
import { connectChannel } from '../../channels'
import { getChannel } from '../../store'
import { startHelper } from '../remote/helper'
import type { SessionSecrets } from '../session'
import { SqliteSession, type SqliteLink } from './sqlite'

/**
 * SQLite database file of another machine, through a channel: one SSH connection
 * and, in place of the two utility processes, two helpers running there
 * (remote/helper.ts). Stop ends the helper of the user connection and the next
 * statement starts another on the same SSH connection; when that one drops, the
 * next request opens it again with the secrets the session was opened with.
 */
export class RemoteSqliteSession extends SqliteSession {
  private client?: Client
  private closed = false
  /** Settled once the last link asked for has started, or failed to. */
  private lastStart: Promise<unknown> = Promise.resolve()

  constructor(
    config: ConnectionConfig,
    private readonly secrets: SessionSecrets,
    safeUpdates = false
  ) {
    // a path of the remote machine: nothing of it is resolved here, the helper expands ~
    super(config, safeUpdates, config.file.trim())
  }

  /** Opens the SSH connection of the channel; rejects with an SshError, which asks the user for a secret. */
  protected async prepare(): Promise<void> {
    const channel = getChannel(this.config.channel ?? '')
    if (!channel) throw new Error(t('main.channel.notFound'))
    const client = await connectChannel(channel, this.secrets)
    // closed while connecting: nobody else would end this connection
    if (this.closed) {
      client.end()
      throw new Error(t('main.session.closed'))
    }
    // dropped by the network or ended by the server: the next link opens another
    client.on('close', () => (this.client = undefined))
    this.client = client
  }

  /**
   * A helper on the SSH connection, opened again if it dropped. Links start one at a
   * time: the editor and the navigator asking together after a drop would otherwise
   * open two SSH connections, and upload a missing helper twice to the same file.
   */
  protected newLink(): Promise<SqliteLink> {
    const link = this.lastStart.then(async () => {
      // also the links that were waiting their turn when the session was closed
      if (this.closed) throw new Error(t('main.session.closed'))
      if (!this.client) await this.prepare()
      return startHelper(this.client!)
    })
    this.lastStart = link.catch(() => undefined)
    return link
  }

  async open(): Promise<void> {
    try {
      await super.open()
    } catch (err) {
      // SqliteSession closes itself only past the first connection: before, the SSH connection would stay open
      this.close()
      throw err
    }
  }

  close(): void {
    this.closed = true
    super.close()
    this.client?.end()
    this.client = undefined
  }
}
