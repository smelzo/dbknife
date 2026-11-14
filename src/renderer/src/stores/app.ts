import { defineStore } from 'pinia'
import { computed, reactive, ref, shallowRef, watch } from 'vue'
import { defaultSettings, type ConnectionConfig, type ConnectionEnvironment, type Credentials, type OpenSessionResult, type RecentFile, type Settings } from '@shared/types'
import { applyTheme } from '@/editor/monaco'
import { alertError, confirm, prompt } from '@/dialogs'
import { t } from '@/i18n'
import type { MessageKey } from '@shared/i18n'
import { Workspace } from '@/workspace/workspace'
import { engineLabels } from '@/workspace/engines'
import { isCsvFile } from '@shared/file-types'

export function newConnectionConfig(): ConnectionConfig {
  return {
    id: crypto.randomUUID(),
    name: '',
    engine: 'mysql',
    method: 'tcp',
    host: '127.0.0.1',
    port: 3306,
    socket: '/tmp/mysql.sock',
    user: 'root',
    database: '',
    file: '',
    defaultSchema: '',
    ssl: { mode: 'preferred', ca: '', cert: '', key: '', cipher: '' },
    ssh: { host: '', port: 22, user: '', keyFile: '' },
    options: { compress: false, connectTimeout: 10, sqlMode: '', others: '' }
  }
}

export function connectionEndpoint(c: ConnectionConfig): string {
  if (c.engine === 'sqlite') return c.file
  const db = (c.engine === 'postgres' || c.engine === 'mssql') && c.database ? `/${c.database}` : ''
  if (c.method === 'socket') return c.socket + db
  return c.method === 'ssh'
    ? t('app.endpointViaSsh', { endpoint: `${c.host}:${c.port}${db}`, sshHost: c.ssh.host })
    : `${c.host}:${c.port}${db}`
}

const environmentKeys: Record<ConnectionEnvironment, MessageKey> = {
  production: 'connection.environment.production',
  staging: 'connection.environment.staging',
  test: 'connection.environment.test',
  development: 'connection.environment.development'
}

/** Name of a connection's environment, as its label on the tile and the connection tab shows it. */
export const environmentLabel = (e: ConnectionEnvironment): string => t(environmentKeys[e])

const secretPrompts = {
  password: {
    field: 'password',
    label: 'app.credentials.password',
    title: 'app.credentials.passwordTitle',
    message: 'app.credentials.passwordMessage'
  },
  sshPassword: {
    field: 'sshPassword',
    label: 'app.credentials.sshPassword',
    title: 'app.credentials.sshPasswordTitle',
    message: 'app.credentials.sshPasswordMessage'
  },
  sshPassphrase: {
    field: 'sshPassphrase',
    label: 'app.credentials.keyPassphrase',
    title: 'app.credentials.keyPassphraseTitle',
    message: 'app.credentials.keyPassphraseMessage'
  }
} as const

/**
 * Asks for the missing secrets until the session opens or the user gives up.
 * `attempt` performs the actual open/test call with the collected credentials.
 */
export async function withCredentials(
  config: ConnectionConfig,
  attempt: (creds: Credentials) => Promise<OpenSessionResult>
): Promise<OpenSessionResult | undefined> {
  const creds: Credentials = {}
  let previousError = ''
  for (;;) {
    const r = await attempt(creds)
    if (r.ok || !r.needs) return r
    const p = secretPrompts[r.needs]
    // MySQL service names follow MySQL Workbench's keychain entries
    const service =
      r.needs === 'password'
        ? `${config.engine === 'mysql' ? 'Mysql' : engineLabels[config.engine]}@${config.method === 'ssh' ? `${config.host}:${config.port}@${config.ssh.host}` : connectionEndpoint(config)}`
        : `${config.ssh.user}@${config.ssh.host}`
    const error = r.error?.message && r.error.message !== previousError ? r.error.message : ''
    previousError = r.error?.message ?? ''
    const message = t(p.message, { service, user: r.needs === 'password' ? config.user : config.ssh.user })
    const values = await prompt({
      title: t(p.title),
      message: error ? `${error}\n\n${message}` : message,
      fields: [
        { key: 'secret', label: t(p.label), type: 'password' },
        { key: 'save', label: t('app.credentials.savePassword'), type: 'checkbox', value: false }
      ]
    })
    if (!values) return undefined
    creds[p.field] = String(values.secret)
    creds.save = creds.save || !!values.save
  }
}

export const useApp = defineStore('app', () => {
  const settings = reactive<Settings>({ ...defaultSettings })
  const connections = ref<ConnectionConfig[]>([])
  const recentFiles = ref<RecentFile[]>([])
  // shallow: Workspace instances are reactive themselves and must keep their class type
  const workspaces = shallowRef<Workspace[]>([])
  const active = ref<string>('home')
  const connecting = ref<string>('')
  const updateReady = ref<string | null>(null)

  const activeWorkspace = computed(() => workspaces.value.find((w) => w.id === active.value))

  async function init(): Promise<void> {
    Object.assign(settings, await window.api.settings.get())
    applyTheme(settings.theme)
    await loadConnections()
    updateReady.value = await window.api.app.updateReady()
    window.api.app.onUpdateReady((v) => (updateReady.value = v))
    watch(
      () => workspaces.value.some((w) => w.pendingWork),
      (unsaved) => window.api.app.setUnsaved(unsaved),
      { immediate: true }
    )
    window.api.app.onCloseRequest(async () => {
      if (await confirmUnsaved()) window.api.app.closeConfirmed()
    })
  }

  /** Asks about the work closing loses in every connection tab (Workspace.confirmClose); false when the user cancels. */
  async function confirmUnsaved(): Promise<boolean> {
    for (const ws of workspaces.value) {
      await ws.refreshCsv()
      if (!ws.pendingWork) continue
      active.value = ws.id
      if (!(await ws.confirmClose())) return false
    }
    return true
  }

  /** The saved connections and the recent files, which leave out the files of saved connections. */
  async function loadConnections(): Promise<void> {
    ;[connections.value, recentFiles.value] = await Promise.all([window.api.connections.list(), window.api.recentFiles.list()])
  }

  async function updateSettings(patch: Partial<Settings>): Promise<void> {
    Object.assign(settings, patch)
    await window.api.settings.set(patch)
    if (patch.theme) applyTheme(patch.theme)
    if (patch.recentFiles !== undefined) await loadConnections()
  }

  async function connect(config: ConnectionConfig): Promise<void> {
    if (connecting.value) return
    connecting.value = config.id
    try {
      const r = config.temporary
        ? await window.api.db.openTemporary(JSON.parse(JSON.stringify(config)))
        : await withCredentials(config, (creds) => window.api.db.open(config.id, creds))
      if (!r) return
      if (!r.ok) {
        await alertError(t('app.connectFailed', { name: config.name }), r.error?.message)
        return
      }
      const ws = Workspace.create(config, settings)
      workspaces.value = [...workspaces.value, ws]
      active.value = ws.id
      await ws.attach(r.sessionId!, r.info!)
      void loadConnections()
    } finally {
      connecting.value = ''
    }
  }

  let fileQueue = Promise.resolve()

  /**
   * Opens a SQLite or CSV file as a temporary connection, which gets no tile and is gone when the app quits.
   * Queued: Finder and drops deliver several files at once, connect() ignores calls while busy.
   */
  function openFile(path: string): Promise<void> {
    const csv = isCsvFile(path)
    const config: ConnectionConfig = {
      ...newConnectionConfig(),
      // the same file gets the same id: its query history comes back
      id: `file:${path}`,
      name: path.split('/').pop() || path,
      engine: 'sqlite',
      file: csv ? '' : path,
      csv: csv ? path : undefined,
      temporary: true
    }
    fileQueue = fileQueue.then(() => {
      // a second copy of a CSV file would overwrite the first one's changes when saved
      const open = csv && workspaces.value.find((w) => w.config.id === config.id)
      if (open) active.value = open.id
      else return connect(config)
    })
    return fileQueue
  }

  /**
   * A connection saved by its editor: its open connection tabs show the new name and environment at once.
   * The rest of the settings (host, user, database...) takes a reconnection.
   */
  function connectionSaved(config: ConnectionConfig): void {
    for (const ws of workspaces.value) {
      if (ws.config.id !== config.id) continue
      ws.config.name = config.name
      ws.config.environment = config.environment
    }
  }

  async function closeWorkspace(id: string): Promise<void> {
    const i = workspaces.value.findIndex((w) => w.id === id)
    if (i < 0) return
    const ws = workspaces.value[i]
    if (!(await ws.confirmClose())) return
    workspaces.value = workspaces.value.filter((w) => w !== ws)
    await ws.close()
    if (active.value === id) active.value = workspaces.value[Math.min(i, workspaces.value.length - 1)]?.id ?? 'home'
  }

  /**
   * Restarts the app; first warns about the statements and jobs a restart interrupts, then asks about the unsaved
   * work (confirmUnsaved: grid edits, scripts, open transactions) and saves the open query tabs.
   */
  async function restart(): Promise<void> {
    const lost: string[] = []
    for (const ws of workspaces.value) {
      if (ws.busy) lost.push(t('app.restart.running', { name: ws.title }))
    }
    if (await window.api.app.jobsRunning()) lost.push(t('app.restart.jobs'))
    if (lost.length && !(await confirm(t('app.restart.confirm'), lost.join('\n'), t('app.restart.restart')))) return
    if (!(await confirmUnsaved())) return
    for (const ws of workspaces.value) ws.persist(true)
    window.api.app.restart()
  }

  function cycleMainTab(delta: number): void {
    const ids = ['home', ...workspaces.value.map((w) => w.id)]
    const i = ids.indexOf(active.value)
    active.value = ids[(i + delta + ids.length) % ids.length]
  }

  return {
    settings,
    connections,
    recentFiles,
    workspaces,
    active,
    connecting,
    updateReady,
    activeWorkspace,
    init,
    loadConnections,
    updateSettings,
    connect,
    openFile,
    closeWorkspace,
    connectionSaved,
    restart,
    cycleMainTab
  }
})
