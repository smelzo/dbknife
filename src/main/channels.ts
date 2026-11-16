// Channels: verified links to other machines, through which SQLite connections
// open a database file there (the saved list is in store.ts).
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Client } from 'ssh2'
import { t } from '@shared/i18n'
import type { Channel, RemoteListing } from '@shared/types'
import { startHelper, type HelperLink } from './db/remote/helper'
import { expandHome, type SessionSecrets } from './db/session'
import { connectSsh } from './db/ssh'
import { checkHostKey } from './store'

/** Opens the SSH connection of a channel; rejects with an SshError. The caller ends it. */
export async function connectChannel(channel: Channel, secrets: SessionSecrets): Promise<Client> {
  return connectSsh({
    host: channel.host,
    port: channel.port,
    username: channel.user,
    password: secrets.sshPassword,
    privateKey: channel.keyFile ? await readFile(expandHome(channel.keyFile)) : undefined,
    passphrase: secrets.sshPassphrase,
    verifyHostKey: (fingerprint) => checkHostKey(`${channel.host}:${channel.port}`, fingerprint)
  })
}

/** Everything a channel must do to be saved: connect, start the helper (uploading it), list the home folder. */
export async function verifyChannel(channel: Channel, secrets: SessionSecrets): Promise<void> {
  const client = await connectChannel(channel, secrets)
  try {
    const listing = await (await startHelper(client)).list('')
    if (listing.error) throw new Error(listing.error)
  } finally {
    client.end()
  }
}

/** The sessions browsing the folders of a remote machine, each with its own connection and helper. */
const browsing = new Map<string, { client: Client; link: HelperLink }>()

/** Opens a browsing session; its id is the handle for browseList and browseClose. */
export async function browseOpen(channel: Channel, secrets: SessionSecrets): Promise<string> {
  const client = await connectChannel(channel, secrets)
  try {
    const link = await startHelper(client)
    const id = randomUUID()
    browsing.set(id, { client, link })
    return id
  } catch (err) {
    client.end()
    throw err
  }
}

export async function browseList(browseId: string, path: string): Promise<RemoteListing> {
  const session = browsing.get(browseId)
  return session ? session.link.list(path) : { path, entries: [], error: t('main.session.closed') }
}

export function browseClose(browseId: string): void {
  browsing.get(browseId)?.client.end()
  browsing.delete(browseId)
}

export function closeAllBrowsing(): void {
  for (const { client } of browsing.values()) client.end()
  browsing.clear()
}
