import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  defaultSettings,
  type Alignment,
  type AlignRun,
  type Channel,
  type ConnectionConfig,
  type HistoryEntry,
  type SecretKind,
  type Settings,
  type Snippet,
  type WorkspaceState
} from '@shared/types'

export const dataDir = (...parts: string[]): string => {
  const dir = join(app.getPath('userData'), ...parts)
  mkdirSync(dir, { recursive: true })
  return dir
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

/** Write through a temporary file so a crash never leaves a truncated file. */
function writeJson(file: string, data: unknown): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
}

const file = (name: string): string => join(dataDir(), name)

// --- connections -----------------------------------------------------------

/** Connections saved before the engine choice existed are MySQL ones. */
const withDefaults = (c: ConnectionConfig): ConnectionConfig => ({ ...c, engine: c.engine ?? 'mysql', database: c.database ?? '', file: c.file ?? '' })

export const listConnections = (): ConnectionConfig[] => readJson<ConnectionConfig[]>(file('connections.json'), []).map(withDefaults)

export function saveConnection(config: ConnectionConfig): void {
  const all = listConnections()
  const i = all.findIndex((c) => c.id === config.id)
  if (i >= 0) all[i] = config
  else all.push(config)
  writeJson(file('connections.json'), all)
}

/** Saves the connections in the order of `ids` (tile order on the home screen); unknown ones keep their place at the end. */
export function reorderConnections(ids: string[]): void {
  const rank = (c: ConnectionConfig): number => {
    const i = ids.indexOf(c.id)
    return i < 0 ? ids.length : i
  }
  writeJson(
    file('connections.json'),
    listConnections().sort((a, b) => rank(a) - rank(b))
  )
}

export function removeConnection(id: string): void {
  writeJson(
    file('connections.json'),
    listConnections().filter((c) => c.id !== id)
  )
  clearSecrets(id)
}

export const getConnection = (id: string): ConnectionConfig | undefined => listConnections().find((c) => c.id === id)

// --- channels (their SSH secrets are stored under the channel's id) ---------

export const listChannels = (): Channel[] => readJson<Channel[]>(file('channels.json'), [])

export function saveChannel(channel: Channel): void {
  const all = listChannels()
  const i = all.findIndex((c) => c.id === channel.id)
  if (i >= 0) all[i] = channel
  else all.push(channel)
  writeJson(file('channels.json'), all)
}

export function removeChannel(id: string): void {
  writeJson(
    file('channels.json'),
    listChannels().filter((c) => c.id !== id)
  )
  clearSecrets(id)
}

export const getChannel = (id: string): Channel | undefined => listChannels().find((c) => c.id === id)

// --- alignments --------------------------------------------------------------

/** Alignments saved before the backup option existed make the backup. */
const alignmentDefaults = (a: Alignment): Alignment => ({ ...a, options: { ...a.options, backup: a.options.backup ?? true } })

export const listAlignments = (): Alignment[] => readJson<Alignment[]>(file('alignments.json'), []).map(alignmentDefaults)

export function saveAlignment(alignment: Alignment): void {
  const all = listAlignments()
  const i = all.findIndex((a) => a.id === alignment.id)
  if (i >= 0) all[i] = alignment
  else all.push(alignment)
  writeJson(file('alignments.json'), all)
}

export function removeAlignment(id: string): void {
  writeJson(
    file('alignments.json'),
    listAlignments().filter((a) => a.id !== id)
  )
}

/** Puts the run first in the alignment's history (at most 20); nothing when the alignment no longer exists. */
export function recordAlignmentRun(id: string, run: AlignRun): void {
  const all = listAlignments()
  const a = all.find((x) => x.id === id)
  if (!a) return
  a.runs = [run, ...a.runs].slice(0, 20)
  writeJson(file('alignments.json'), all)
}

// --- secrets (encrypted with the OS keychain-backed safeStorage key) -------

type SecretFile = Record<string, Partial<Record<SecretKind | 'mysql', string>>>

/** Earlier versions stored the database password as 'mysql'. */
function readSecrets(): SecretFile {
  const all = readJson<SecretFile>(file('secrets.json'), {})
  for (const entry of Object.values(all)) {
    if (entry.mysql && !entry.password) entry.password = entry.mysql
    delete entry.mysql
  }
  return all
}

/** Linux without a Secret Service keyring (e.g. a bare XFCE): Electron's fallback key, which
 * only obfuscates, so that passwords are saved all the same. Call once the app is ready. */
export function initSecrets(): void {
  if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') safeStorage.setUsePlainTextEncryption(true)
}

export async function getSecret(id: string, kind: SecretKind): Promise<string | undefined> {
  const value = readSecrets()[id]?.[kind]
  if (!value || !(await safeStorage.isAsyncEncryptionAvailable())) return undefined
  try {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(value, 'base64'))
    // the key has been rotated, or one of a better security level is available
    if (shouldReEncrypt) await setSecret(id, kind, result)
    return result
  } catch {
    return undefined
  }
}

export async function setSecret(id: string, kind: SecretKind, value: string): Promise<boolean> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) return false
  let encrypted: string
  try {
    encrypted = (await safeStorage.encryptStringAsync(value)).toString('base64')
  } catch {
    // macOS: access to the Keychain denied
    return false
  }
  const all = readSecrets()
  all[id] = { ...all[id], [kind]: encrypted }
  writeJson(file('secrets.json'), all)
  return true
}

export function secretStatus(id: string): Record<SecretKind, boolean> {
  const entry = readSecrets()[id] ?? {}
  return { password: !!entry.password, ssh: !!entry.ssh, sshPassphrase: !!entry.sshPassphrase }
}

export function clearSecrets(id: string): void {
  const all = readSecrets()
  delete all[id]
  writeJson(file('secrets.json'), all)
}

// --- settings --------------------------------------------------------------

export const getSettings = (): Settings => ({ ...defaultSettings, ...readJson(file('settings.json'), {}) })

export function updateSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch }
  writeJson(file('settings.json'), next)
  return next
}

// --- SQLite and CSV files opened directly, most recent first ------------------

type RecentEntry = { path: string; openedAt: number }

export const listRecentFiles = (): RecentEntry[] => readJson<RecentEntry[]>(file('recent-files.json'), [])

export function addRecentFile(path: string): void {
  const rest = listRecentFiles().filter((r) => r.path !== path)
  writeJson(file('recent-files.json'), [{ path, openedAt: Date.now() }, ...rest].slice(0, getSettings().recentFiles))
}

export function removeRecentFile(path: string): void {
  writeJson(
    file('recent-files.json'),
    listRecentFiles().filter((r) => r.path !== path)
  )
}

// --- per-connection workspaces (open query tabs) -----------------------------

const workspaceFile = (connectionId: string): string =>
  join(dataDir('workspaces'), `${connectionId.replace(/[^\w-]/g, '_')}.json`)

export const loadWorkspace = (connectionId: string): WorkspaceState | null =>
  readJson<WorkspaceState | null>(workspaceFile(connectionId), null)

export const saveWorkspace = (connectionId: string, state: WorkspaceState): void =>
  writeJson(workspaceFile(connectionId), state)

// --- query history: one JSON-lines file per day ------------------------------

const day = (time: number): string => {
  const d = new Date(time)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function appendHistory(entries: HistoryEntry[]): void {
  const dir = dataDir('history')
  for (const e of entries) appendFileSync(join(dir, `${day(e.time)}.jsonl`), JSON.stringify(e) + '\n')
}

export function loadHistory(days: number): HistoryEntry[] {
  const dir = dataDir('history')
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .slice(-days)
  const out: HistoryEntry[] = []
  for (const f of files) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!line) continue
      try {
        out.push(JSON.parse(line) as HistoryEntry)
      } catch {
        // skip a partially written line
      }
    }
  }
  return out
}

// --- snippets ----------------------------------------------------------------

export const loadSnippets = (): Snippet[] | null =>
  existsSync(file('snippets.json')) ? readJson<Snippet[]>(file('snippets.json'), []) : null

export const saveSnippets = (snippets: Snippet[]): void => writeJson(file('snippets.json'), snippets)

// --- SSH host keys (trust on first use) --------------------------------------

export function checkHostKey(host: string, fingerprint: string): boolean {
  const known = readJson<Record<string, string>>(file('known_hosts.json'), {})
  if (!known[host]) {
    known[host] = fingerprint
    writeJson(file('known_hosts.json'), known)
    return true
  }
  return known[host] === fingerprint
}
