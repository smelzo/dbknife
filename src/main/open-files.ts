import { app, BrowserWindow, ipcMain, type WebContents } from 'electron'

/** Files received before the renderer listens for them. */
let pending: string[] = []
let target: WebContents | undefined

/**
 * Forwards the files macOS asks the app to open (Finder "Open With", Dock icon) to the
 * renderer. Must run before the app is ready: the files the app is launched with arrive then.
 */
export function initOpenFiles(createWindow: () => void): void {
  app.on('open-file', (e, path) => {
    e.preventDefault()
    if (target && !target.isDestroyed()) {
      target.send('app:openFile', path)
      const win = BrowserWindow.fromWebContents(target)
      if (win?.isMinimized()) win.restore()
      return
    }
    pending.push(path)
    if (app.isReady() && !BrowserWindow.getAllWindows().length) createWindow()
  })
  ipcMain.on('app:openFileReady', (e) => {
    target = e.sender
    for (const path of pending) target.send('app:openFile', path)
    pending = []
  })
}
