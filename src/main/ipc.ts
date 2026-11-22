import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { FileFilter, MenuState, MessageOptions } from '@shared/api'
import { t } from '@shared/i18n'
import type {
  Alignment,
  Channel,
  ChannelResult,
  ConnectionConfig,
  Credentials,
  ExecOptions,
  MenuItemSpec,
  OpenSessionResult,
  RecentFile,
  SecretKind
} from '@shared/types'
import { browseClose, browseList, browseOpen, closeAllBrowsing, verifyChannel } from './channels'
import { allowClose } from './close-guard'
import { createSession } from './db/create-session'
import { CsvSession } from './db/drivers/csv'
import { channelId, expandHome, isAuthError, toDbError, usesPassword, type DbSession, type SessionSecrets } from './db/session'
import { SshError } from './db/ssh'
import { listConfigHosts } from './db/ssh-config'
import { i18nInfo, installLanguage, languagesDir, listInstalled, loadLanguage, removeLanguage } from './i18n'
import { buildMenu, setMenuState } from './menu'
import { readSpread, spreadAvailable, writeXlsx } from './spread'
import * as store from './store'
import { registerToolHandlers } from './tools/index'
import { jobs } from './tools/jobs'
import { installUpdate, updateReady } from './updater'
import { importWorkbenchConnections, importWorkbenchSnippets, readWorkbenchPassword } from './workbench-import'
import { withDefaultSnippets } from './default-snippets'

const sessions = new Map<string, DbSession>()

const getSession = (id: string): DbSession => {
  const s = sessions.get(id)
  if (!s) throw new Error(t('main.session.closed'))
  return s
}

const getCsvSession = (id: string): CsvSession => {
  const s = getSession(id)
  if (!(s instanceof CsvSession)) throw new Error(`Session ${id} is not a CSV file`)
  return s
}

export function closeAllSessions(): void {
  for (const s of sessions.values()) s.close()
  sessions.clear()
  closeAllBrowsing()
}

/** SSH password and passphrase: the supplied ones, else those saved under `id` (a connection's, or a channel's). */
const sshSecrets = (id: string, creds: Credentials): SessionSecrets => ({
  sshPassword: creds.sshPassword ?? store.getSecret(id, 'ssh'),
  sshPassphrase: creds.sshPassphrase ?? store.getSecret(id, 'sshPassphrase')
})

function saveSshSecrets(id: string, creds: Credentials): void {
  if (creds.sshPassword !== undefined) store.setSecret(id, 'ssh', creds.sshPassword)
  if (creds.sshPassphrase !== undefined) store.setSecret(id, 'sshPassphrase', creds.sshPassphrase)
}

/** The secret the SSH server asks for or has rejected, for the renderer to prompt for it. */
const sshNeeds = (err: SshError): 'sshPassword' | 'sshPassphrase' | undefined =>
  err.kind === 'auth' ? 'sshPassword' : err.kind === 'passphrase' ? 'sshPassphrase' : undefined

/**
 * Runs `action` on a channel with the supplied SSH secrets, falling back to the
 * stored ones; only when it succeeds the supplied secrets are stored (with `creds.save`).
 */
async function useChannel(
  channel: Channel,
  creds: Credentials,
  action: (secrets: SessionSecrets) => Promise<Pick<ChannelResult, 'browseId'>>
): Promise<ChannelResult> {
  let done: Pick<ChannelResult, 'browseId'>
  try {
    done = await action(sshSecrets(channel.id, creds))
  } catch (err) {
    if (err instanceof SshError) return { ok: false, error: { message: err.message }, needs: sshNeeds(err) }
    return { ok: false, error: toDbError(err) }
  }
  if (creds.save) saveSshSecrets(channel.id, creds)
  return { ok: true, ...done }
}

/**
 * Starts the app again, so the language and settings are loaded anew. In dev the
 * dev server ends with the Electron process: the menu and the windows are reloaded
 * instead. With an update downloaded, the restart installs it. Automated tests
 * only quit, a relaunched instance would escape them.
 */
function restartApp(): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    closeAllSessions()
    loadLanguage()
    buildMenu()
    for (const win of BrowserWindow.getAllWindows()) win.reload()
    return
  }
  if (installUpdate()) return
  if (process.env.DBM_TEST_HIDDEN !== '1') app.relaunch()
  app.quit()
}

/**
 * Opens a session using the supplied credentials, falling back to stored
 * secrets and, for connections imported from MySQL Workbench, to the
 * password Workbench keeps in the keychain.
 */
async function openSession(config: ConnectionConfig, creds: Credentials): Promise<{ result: OpenSessionResult; session?: DbSession }> {
  const id = config.id
  let password = creds.password ?? store.getSecret(id, 'password')
  if (password === undefined && config.workbenchKeychain) {
    password = await readWorkbenchPassword(config.workbenchKeychain, config.user)
    if (password !== undefined) store.setSecret(id, 'password', password)
  }
  if (password === undefined && usesPassword(config.engine)) return { result: { ok: false, needs: 'password' } }
  // a channel is shared by connections: its SSH secrets are those of the channel
  const sshId = channelId(config) ?? id
  const secrets = { password, ...sshSecrets(sshId, creds) }
  let session: DbSession | undefined
  try {
    session = createSession(config, secrets, store.getSettings().safeUpdates)
    await session.open()
  } catch (err) {
    if (err instanceof SshError) return { result: { ok: false, error: { message: err.message }, needs: sshNeeds(err) } }
    const error = toDbError(err)
    return { result: { ok: false, error, needs: isAuthError(config.engine, error) ? 'password' : undefined } }
  }
  if (creds.save) {
    if (creds.password !== undefined) store.setSecret(id, 'password', creds.password)
    saveSshSecrets(sshId, creds)
  }
  return { result: { ok: true, sessionId: session.id, info: session.info }, session }
}

function toMenu(specs: MenuItemSpec[], choose: (id: string | null) => void): MenuItemConstructorOptions[] {
  return specs.map((s) =>
    s.type === 'separator'
      ? { type: 'separator' }
      : {
          label: s.label,
          type: s.type === 'checkbox' ? 'checkbox' : s.submenu ? 'submenu' : 'normal',
          checked: s.checked,
          enabled: s.enabled !== false,
          submenu: s.submenu ? toMenu(s.submenu, choose) : undefined,
          click: s.submenu ? undefined : () => choose(s.id ?? null)
        }
  )
}

const windowOf = (e: Electron.IpcMainInvokeEvent): BrowserWindow => BrowserWindow.fromWebContents(e.sender)!

export function registerIpc(): void {
  // connections
  ipcMain.handle('connections:list', () => store.listConnections())
  ipcMain.handle('connections:save', (_e, c: ConnectionConfig) => store.saveConnection(c))
  ipcMain.handle('connections:remove', (_e, id: string) => store.removeConnection(id))
  ipcMain.handle('connections:reorder', (_e, ids: string[]) => store.reorderConnections(ids))
  ipcMain.handle('connections:importWorkbench', () => importWorkbenchConnections())

  // channels: saved only once verified
  ipcMain.handle('channels:list', () => store.listChannels())
  ipcMain.handle('channels:save', (_e, channel: Channel, creds: Credentials) =>
    useChannel(channel, creds, async (secrets) => {
      await verifyChannel(channel, secrets)
      store.saveChannel(channel)
      return {}
    })
  )
  ipcMain.handle('channels:remove', (_e, id: string): string[] => {
    const users = store
      .listConnections()
      .filter((c) => channelId(c) === id)
      .map((c) => c.name)
    if (!users.length) store.removeChannel(id)
    return users
  })
  ipcMain.handle('channels:browseOpen', async (_e, id: string, creds: Credentials): Promise<ChannelResult> => {
    const channel = store.getChannel(id)
    if (!channel) return { ok: false, error: { message: t('main.channel.notFound') } }
    return useChannel(channel, creds, async (secrets) => ({ browseId: await browseOpen(channel, secrets) }))
  })
  ipcMain.handle('channels:browseList', (_e, browseId: string, path: string) => browseList(browseId, path))
  ipcMain.handle('channels:browseClose', (_e, browseId: string) => browseClose(browseId))
  ipcMain.handle('channels:configHosts', () => listConfigHosts())

  // alignments
  ipcMain.handle('alignments:list', () => store.listAlignments())
  ipcMain.handle('alignments:save', (_e, a: Alignment) => store.saveAlignment(a))
  ipcMain.handle('alignments:remove', (_e, id: string) => store.removeAlignment(id))

  // secrets
  ipcMain.handle('secrets:status', (_e, id: string) => store.secretStatus(id))
  ipcMain.handle('secrets:set', (_e, id: string, kind: SecretKind, value: string) => store.setSecret(id, kind, value))
  ipcMain.handle('secrets:clear', (_e, id: string) => store.clearSecrets(id))

  // database sessions
  ipcMain.handle('db:open', async (_e, connectionId: string, creds: Credentials) => {
    const config = store.getConnection(connectionId)
    if (!config) return { ok: false, error: { message: t('main.session.notFound') } }
    const { result, session } = await openSession(config, creds)
    if (session) {
      sessions.set(session.id, session)
      store.saveConnection({ ...config, lastConnected: Date.now() })
    }
    return result
  })
  ipcMain.handle('db:openTemporary', async (_e, config: ConnectionConfig) => {
    const { result, session } = await openSession(config, {})
    if (session) {
      sessions.set(session.id, session)
      // temporary connections are the files opened directly
      const path = config.csv || config.file
      if (path) store.addRecentFile(path)
    }
    return result
  })
  ipcMain.handle('db:test', async (_e, config: ConnectionConfig, creds: Credentials) => {
    const { result, session } = await openSession(config, { ...creds, save: false })
    session?.close()
    return result
  })
  ipcMain.handle('db:close', (_e, id: string) => {
    sessions.get(id)?.close()
    sessions.delete(id)
  })
  ipcMain.handle('db:execute', (_e, id: string, sql: string, opts?: ExecOptions) => getSession(id).execute(sql, opts))
  ipcMain.handle('db:explain', (_e, id: string, sql: string) => getSession(id).explain(sql))
  ipcMain.handle('db:cancel', (_e, id: string) => getSession(id).cancel())
  ipcMain.handle('db:query', (_e, id: string, sql: string, params?: unknown[]) => getSession(id).query(sql, params))
  ipcMain.handle('db:currentSchema', (_e, id: string) => getSession(id).currentSchema())
  ipcMain.handle('db:setAutocommit', (_e, id: string, on: boolean) => {
    const session = getSession(id)
    if (!session.setAutocommit) throw new Error(`${session.config.engine} sessions switch autocommit with a statement`)
    return session.setAutocommit(on)
  })

  ipcMain.handle('csv:status', (_e, id: string) => getCsvSession(id).status())
  ipcMain.handle('csv:save', (_e, id: string, overwrite: boolean) => getCsvSession(id).save(overwrite))

  registerToolHandlers(getSession)

  // files
  ipcMain.handle('files:openSql', async (e) => {
    const r = await dialog.showOpenDialog(windowOf(e), {
      title: t('main.files.openSql'),
      filters: [
        { name: t('main.files.sqlFiles'), extensions: ['sql'] },
        { name: t('main.files.allFiles'), extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    if (r.canceled || !r.filePaths[0]) return null
    return { path: r.filePaths[0], content: await readFile(r.filePaths[0], 'utf8') }
  })
  ipcMain.handle('files:read', (_e, path: string) => readFile(path, 'utf8'))
  ipcMain.handle('files:readBinary', async (_e, path: string) => new Uint8Array(await readFile(path)))
  ipcMain.handle('files:write', (_e, path: string, data: string | Uint8Array) => writeFile(path, data))
  ipcMain.handle('files:writeXlsx', (_e, path: string, lines: string[]) => writeXlsx(path, lines))
  ipcMain.handle('files:spreadAvailable', () => spreadAvailable())
  ipcMain.handle('files:readSpread', (_e, path: string, sheet?: number) => readSpread(path, sheet))
  ipcMain.handle('files:chooseImportFile', async (e) => {
    const r = await dialog.showOpenDialog(windowOf(e), {
      title: t('main.files.importFile'),
      filters: [
        { name: t('main.files.csvFiles'), extensions: ['csv', 'txt', 'tsv'] },
        // read only by d-spread
        ...(spreadAvailable() ? [{ name: t('main.files.spreadsheets'), extensions: ['xlsx', 'xlsm', 'xls', 'ods'] }] : []),
        { name: t('main.files.allFiles'), extensions: ['*'] }
      ],
      properties: ['openFile']
    })
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })
  ipcMain.handle(
    'files:chooseOpen',
    async (e, o: { title?: string; filters?: FileFilter[]; folder?: boolean }) => {
      const r = await dialog.showOpenDialog(windowOf(e), {
        title: o.title,
        filters: o.filters,
        properties: o.folder ? ['openDirectory', 'createDirectory'] : ['openFile']
      })
      return r.canceled ? null : (r.filePaths[0] ?? null)
    }
  )
  ipcMain.handle(
    'files:chooseSave',
    async (e, o: { title?: string; defaultPath?: string; filters?: FileFilter[] }) => {
      const r = await dialog.showSaveDialog(windowOf(e), o)
      return r.canceled ? null : (r.filePath ?? null)
    }
  )

  ipcMain.handle('files:reveal', (_e, path: string) => shell.showItemInFolder(path))
  ipcMain.handle('files:newSqlite', async (_e, path: string) => {
    // the save dialog has asked before replacing an existing file
    for (const suffix of ['-wal', '-shm', '-journal', '']) await rm(path + suffix, { force: true })
    await writeFile(path, '')
  })

  // recent files: those with a saved connection are tiles of the home screen instead
  ipcMain.handle('recentFiles:list', (): RecentFile[] => {
    const saved = new Set(
      store
        .listConnections()
        // the file of a connection with a channel is on another machine
        .filter((c) => c.engine === 'sqlite' && c.file && !channelId(c))
        .map((c) => resolve(expandHome(c.file)))
    )
    return store
      .listRecentFiles()
      .filter((r) => !saved.has(r.path))
      .slice(0, store.getSettings().recentFiles)
      .map((r) => ({ ...r, missing: !existsSync(r.path) }))
  })
  ipcMain.handle('recentFiles:remove', (_e, path: string) => store.removeRecentFile(path))

  // ui
  ipcMain.handle(
    'ui:contextMenu',
    (e, items: MenuItemSpec[]) =>
      new Promise<string | null>((resolve) => {
        let chosen: string | null = null
        const menu = Menu.buildFromTemplate(toMenu(items, (id) => (chosen = id)))
        // the click handler runs before the close callback; defer to be safe
        menu.popup({ window: windowOf(e), callback: () => setTimeout(() => resolve(chosen), 0) })
      })
  )
  ipcMain.handle('ui:message', async (e, o: MessageOptions) => (await dialog.showMessageBox(windowOf(e), o)).response)
  ipcMain.on('ui:menuState', (_e, s: MenuState) => setMenuState(s))
  ipcMain.handle('ui:openExternal', (_e, url: string) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url)
  })

  // settings, workspaces, history, snippets
  ipcMain.handle('settings:get', () => store.getSettings())
  ipcMain.handle('settings:set', (_e, patch) => store.updateSettings(patch))
  ipcMain.handle('workspace:load', (_e, id: string) => store.loadWorkspace(id))
  ipcMain.handle('workspace:save', (_e, id: string, state) => store.saveWorkspace(id, state))
  ipcMain.handle('history:append', (_e, entries) => store.appendHistory(entries))
  ipcMain.handle('history:load', (_e, days: number) => store.loadHistory(days))
  ipcMain.handle('snippets:load', () => withDefaultSnippets(store.loadSnippets(), importWorkbenchSnippets))
  ipcMain.handle('snippets:save', (_e, s) => store.saveSnippets(s))

  // languages
  ipcMain.on('i18n:get', (e) => {
    e.returnValue = i18nInfo()
  })
  ipcMain.handle('i18n:list', () => listInstalled())
  ipcMain.handle('i18n:install', (e) => installLanguage(windowOf(e)))
  ipcMain.handle('i18n:remove', (_e, code: string) => removeLanguage(code))
  ipcMain.handle('i18n:openFolder', async () => {
    await shell.openPath(languagesDir())
  })

  // restart
  ipcMain.handle('app:jobsRunning', () => jobs.size)
  // the renderer has asked about unsaved work before
  ipcMain.on('app:restart', () => {
    allowClose()
    restartApp()
  })
  ipcMain.handle('app:updateReady', () => updateReady())
}
