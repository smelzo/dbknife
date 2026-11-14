import { app, BrowserWindow, ipcMain } from 'electron'

/** The renderer holds work that closing loses. */
let unsaved = false
/** The renderer has asked the user already: the next close goes through. */
let confirmed = false
let quitting = false
/** The close the renderer is asked about came from quitting the app. */
let pendingQuit = false

/**
 * Closing the window (or quitting) while the renderer has unsaved work waits
 * for it: the renderer asks the user and confirms, or the close is dropped.
 */
export function initCloseGuard(): void {
  app.on('before-quit', () => (quitting = true))
  ipcMain.on('app:unsaved', (_e, value: boolean) => (unsaved = value))
  ipcMain.on('app:closeConfirmed', (e) => {
    confirmed = true
    if (pendingQuit) app.quit()
    else BrowserWindow.fromWebContents(e.sender)?.close()
  })
}

export function guardClose(win: BrowserWindow): void {
  // a new or reloaded page starts without unsaved work
  win.webContents.on('did-start-loading', () => (unsaved = confirmed = false))
  win.on('close', (e) => {
    const quit = quitting
    quitting = false
    if (!unsaved || confirmed) return
    // a prevented close also cancels the quit
    e.preventDefault()
    pendingQuit = quit
    win.webContents.send('app:closeRequest')
  })
}

/** The renderer has confirmed before asking for a restart. */
export function allowClose(): void {
  confirmed = true
}
