import { app, autoUpdater, BrowserWindow, nativeTheme, screen, systemPreferences } from 'electron'
import { join } from 'node:path'
import { loadLanguage } from './i18n'
import { buildMenu } from './menu'
import { guardClose, initCloseGuard } from './close-guard'
import { removeStaleCsvWork } from './db/drivers/csv'
import { closeAllSessions, registerIpc } from './ipc'
import { initOpenFiles } from './open-files'
import { getSettings, initSecrets, updateSettings } from './store'
import { startUpdater } from './updater'

app.setName('DBKnife')
// isolated profile for automated tests
if (process.env.DBM_USER_DATA) app.setPath('userData', process.env.DBM_USER_DATA)
// on large Retina displays the GPU process allocates hundreds of MB of Metal buffers while drawing
if (!getSettings().hardwareAcceleration) app.commandLine.appendSwitch('disable-gpu-compositing')
// automated tests run in the background: no Dock icon, no focus stealing, transparent window
const testHidden = process.env.DBM_TEST_HIDDEN === '1'
if (testHidden && process.platform === 'darwin') app.setActivationPolicy('accessory')

function visibleBounds(b: { x?: number; y?: number; width: number; height: number }): boolean {
  if (b.x === undefined || b.y === undefined) return false
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea
    return b.x! < a.x + a.width && b.x! + b.width > a.x && b.y! < a.y + a.height && b.y! + b.height > a.y
  })
}

function createWindow(): void {
  const settings = getSettings()
  nativeTheme.themeSource = settings.theme
  const saved = settings.window
  const win = new BrowserWindow({
    width: saved?.width ?? 1400,
    height: saved?.height ?? 900,
    ...(saved && visibleBounds(saved) ? { x: saved.x, y: saved.y } : {}),
    minWidth: 900,
    minHeight: 600,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 11 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ececec',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: !testHidden
    }
  })
  if (saved?.maximized) win.maximize()
  if (testHidden) {
    win.setOpacity(0)
    win.once('ready-to-show', () => win.showInactive())
  } else {
    win.once('ready-to-show', () => win.show())
  }
  guardClose(win)
  win.on('close', () => {
    if (testHidden) return
    updateSettings({ window: { ...win.getNormalBounds(), maximized: win.isMaximized() } })
  })
  // links clicked in the renderer open in the browser, never inside the app
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  // reloading the page itself stays allowed: the dev server reloads it after re-optimizing dependencies
  win.webContents.on('will-navigate', (e) => {
    if (e.url !== win.webContents.getURL()) e.preventDefault()
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
    win.webContents.openDevTools()
  } else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  // in dev the app runs inside node_modules' Electron.app, whose name, version and icon macOS would show
  if (process.env.ELECTRON_RENDERER_URL && process.platform === 'darwin') {
    app.setAboutPanelOptions({ applicationName: app.name, applicationVersion: app.getVersion(), version: '' })
    app.dock?.setIcon(join(__dirname, '../../resources/icon.png'))
  }
  // otherwise macOS adds its own Enter Full Screen item to the View menu, next to ours
  if (process.platform === 'darwin') systemPreferences.setUserDefault('NSFullScreenMenuItemEverywhere', 'boolean', false)
  loadLanguage()
  initSecrets()
  registerIpc()
  initCloseGuard()
  removeStaleCsvWork()
  buildMenu()
  createWindow()
  startUpdater(buildMenu)
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

initOpenFiles(createWindow)

app.on('window-all-closed', () => {
  closeAllSessions()
  if (process.platform !== 'darwin') app.quit()
})

// not on before-quit: a window may still cancel the quit (unsaved CSV changes)
app.on('will-quit', () => closeAllSessions())
// installing an update quits without before-quit
autoUpdater.on('before-quit-for-update', () => closeAllSessions())
