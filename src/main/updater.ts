import { app, autoUpdater, BrowserWindow, dialog, type MessageBoxOptions, type MessageBoxReturnValue } from 'electron'
import { t } from '@shared/i18n'

// one feed per architecture, written by the release workflow (.github/workflows/release.yml)
const FEED_URL = `https://github.com/smelzo/dbknife/releases/latest/download/releases-${process.arch}.json`
const CHECK_EVERY = 4 * 60 * 60 * 1000

let status: 'idle' | 'checking' | 'downloading' | 'ready' = 'idle'
let readyVersion: string | null = null
/** Whether the check in progress was asked for from the menu, so its outcome is shown. */
let manual = false
let onChange: () => void = () => {}
let timer: NodeJS.Timeout | undefined

/** Off in dev and in automated tests, which run the Electron of node_modules, and off the Mac:
 * the feed is Squirrel.Mac's, the Microsoft Store updates its own package. */
export const updatesEnabled = (): boolean => app.isPackaged && process.platform === 'darwin'

function show(o: MessageBoxOptions): Promise<MessageBoxReturnValue> {
  const win = BrowserWindow.getFocusedWindow()
  return win ? dialog.showMessageBox(win, o) : dialog.showMessageBox(o)
}

function setStatus(s: typeof status): void {
  status = s
  onChange()
}

function check(m: boolean): void {
  if (status !== 'idle') return
  manual = m
  autoUpdater.checkForUpdates()
}

/** Checks the feed 10 seconds after startup and every 4 hours, downloading a new version in the background. */
export function startUpdater(changed: () => void): void {
  if (!updatesEnabled()) return
  onChange = changed
  autoUpdater.setFeedURL({ url: FEED_URL, serverType: 'json' })
  autoUpdater.on('checking-for-update', () => setStatus('checking'))
  autoUpdater.on('update-available', () => {
    setStatus('downloading')
    if (!manual) return
    manual = false
    void show({ type: 'info', message: t('main.update.downloading', { app: app.name }), detail: t('main.update.downloadingDetail', { app: app.name }) })
  })
  autoUpdater.on('update-not-available', () => {
    setStatus('idle')
    if (!manual) return
    manual = false
    void show({ type: 'info', message: t('main.update.upToDate', { app: app.name, version: app.getVersion() }) })
  })
  autoUpdater.on('update-downloaded', (_e, _notes, releaseName) => {
    readyVersion = releaseName
    setStatus('ready')
    clearInterval(timer)
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('app:updateReady', releaseName)
  })
  autoUpdater.on('error', (err) => {
    setStatus('idle')
    if (!manual) return console.error(err)
    manual = false
    void show({ type: 'error', message: t('main.update.error'), detail: err.message })
  })
  // updating fails outside /Applications, e.g. run from the dmg or translocated by macOS
  if (!app.isInApplicationsFolder()) return
  setTimeout(() => {
    check(false)
    timer = setInterval(() => check(false), CHECK_EVERY)
  }, 10_000)
}

/** The check asked for from the menu: outside /Applications it offers to move the app there first. */
export function checkForUpdates(): void {
  if (app.isInApplicationsFolder()) return check(true)
  const asked = show({
    type: 'question',
    message: t('main.update.moveToApplications', { app: app.name }),
    detail: t('main.update.moveDetail', { app: app.name }),
    buttons: [t('main.update.move'), t('common.cancel')],
    defaultId: 0,
    cancelId: 1
  })
  void asked.then(({ response }) => {
    if (response !== 0) return
    try {
      // moves the app and starts it again from there
      app.moveToApplicationsFolder()
    } catch (err) {
      void show({ type: 'error', message: t('main.update.error'), detail: (err as Error).message })
    }
  })
}

/** The version downloaded and ready to install with a restart. */
export const updateReady = (): string | null => readyVersion

export const updateChecking = (): boolean => status === 'checking' || status === 'downloading'

/** Quits and installs the version downloaded; false when there is none. */
export function installUpdate(): boolean {
  if (readyVersion === null) return false
  autoUpdater.quitAndInstall()
  return true
}
