import { app, BrowserWindow, Menu, shell, type KeyboardEvent, type MenuItemConstructorOptions } from 'electron'
import type { MenuState } from '@shared/api'
import { t } from '@shared/i18n'
import { checkForUpdates, updateChecking, updateReady, updatesEnabled } from './updater'

const limitChoices = [0, 10, 50, 100, 200, 300, 400, 500, 1000, 2000, 5000, 10000, 50000]

/** The renderer gets whether the item was triggered by its shortcut, to avoid acting twice
 * when the focused editor already handled the same keys. */
const send =
  (command: string) =>
  (_item: unknown, _win: unknown, event: KeyboardEvent): void => {
    BrowserWindow.getFocusedWindow()?.webContents.send('menu-command', command, !!event?.triggeredByAccelerator)
  }

const item = (label: string, command: string, accelerator?: string, sqlOnly = false): MenuItemConstructorOptions => ({
  id: command,
  label,
  accelerator,
  click: send(command),
  enabled: !sqlOnly
})

/** Commands that only make sense inside a SQL editor connection tab. */
const sqlCommands = new Set<string>()

const sql = (label: string, command: string, accelerator?: string): MenuItemConstructorOptions => {
  sqlCommands.add(command)
  return item(label, command, accelerator, true)
}

let state: MenuState = { inSqlEditor: false, unavailable: [], stopOnError: true, autocommit: true, limitRows: 1000 }

export function buildMenu(): void {
  const isDev = !app.isPackaged
  const isMac = process.platform === 'darwin'
  const version = updateReady()
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: t('menu.app.about', { app: app.name }) },
        // its own id: getMenuItemById must not find two items, the command stays the one of Restart
        version
          ? { ...item(t('app.update.restart', { version }), 'app.restart'), id: 'app.restartToUpdate' }
          : { label: t('menu.app.checkForUpdates'), click: () => checkForUpdates(), enabled: !updateChecking(), visible: updatesEnabled() },
        { type: 'separator' },
        item(t('menu.app.preferences'), 'app.preferences', 'CmdOrCtrl+,'),
        { type: 'separator' },
        { role: 'services', label: t('menu.app.services') },
        { type: 'separator' },
        { role: 'hide', label: t('menu.app.hide', { app: app.name }) },
        { role: 'hideOthers', label: t('menu.app.hideOthers') },
        { role: 'unhide', label: t('menu.app.showAll') },
        { type: 'separator' },
        item(t('menu.app.restart', { app: app.name }), 'app.restart'),
        { role: 'quit', label: t('menu.app.quit', { app: app.name }) }
      ]
    },
    {
      label: t('menu.file'),
      submenu: [
        item(t('menu.file.newQueryTab'), 'file.newQueryTab', 'CmdOrCtrl+T'),
        item(t('menu.file.openScript'), 'file.openScript', 'CmdOrCtrl+Shift+O'),
        item(t('menu.file.newSqlite'), 'file.newSqlite'),
        item(t('menu.file.openSqlite'), 'file.openSqlite'),
        item(t('menu.file.openCsv'), 'file.openCsv'),
        sql(t('menu.file.runScript'), 'file.runScript'),
        { type: 'separator' },
        sql(t('menu.file.save'), 'file.save', 'CmdOrCtrl+S'),
        sql(t('menu.file.saveAs'), 'file.saveAs', 'CmdOrCtrl+Shift+S'),
        sql(t('menu.file.revert'), 'file.revert'),
        sql(t('menu.file.saveCsv'), 'file.saveCsv'),
        { type: 'separator' },
        item(t('menu.file.closeTab'), 'file.closeTab', 'CmdOrCtrl+W'),
        sql(t('menu.file.closeConnectionTab'), 'file.closeConnectionTab', 'CmdOrCtrl+Shift+W')
      ]
    },
    {
      label: t('menu.edit'),
      submenu: [
        { role: 'undo', label: t('menu.edit.undo') },
        { role: 'redo', label: t('menu.edit.redo') },
        { type: 'separator' },
        { role: 'cut', label: t('menu.edit.cut') },
        { role: 'copy', label: t('menu.edit.copy') },
        { role: 'paste', label: t('menu.edit.paste') },
        { role: 'selectAll', label: t('menu.edit.selectAll') },
        { type: 'separator' },
        {
          label: t('menu.edit.findMenu'),
          submenu: [sql(t('menu.edit.find'), 'edit.find', 'CmdOrCtrl+F'), sql(t('menu.edit.replace'), 'edit.replace', 'CmdOrCtrl+Alt+F')]
        },
        {
          label: t('menu.edit.formatMenu'),
          submenu: [
            sql(t('menu.edit.beautify'), 'edit.beautify', 'CmdOrCtrl+B'),
            sql(t('menu.edit.upcase'), 'edit.upcase'),
            sql(t('menu.edit.lowercase'), 'edit.lowercase'),
            sql(t('menu.edit.comment'), 'edit.comment', 'CmdOrCtrl+/')
          ]
        },
        sql(t('menu.edit.autocomplete'), 'edit.autocomplete', 'Ctrl+Space')
      ]
    },
    {
      label: t('menu.view'),
      submenu: [
        item(t('menu.view.home'), 'view.home', 'CmdOrCtrl+Shift+H'),
        { type: 'separator' },
        sql(t('menu.view.toggleSidebar'), 'view.toggleSidebar', 'CmdOrCtrl+Alt+1'),
        sql(t('menu.view.toggleOutput'), 'view.toggleOutput', 'CmdOrCtrl+Alt+2'),
        sql(t('menu.view.toggleSecondarySidebar'), 'view.toggleSecondarySidebar', 'CmdOrCtrl+Alt+3'),
        { type: 'separator' },
        sql(t('menu.view.nextQueryTab'), 'view.nextQueryTab', 'Ctrl+Tab'),
        sql(t('menu.view.prevQueryTab'), 'view.prevQueryTab', 'Ctrl+Shift+Tab'),
        // Ctrl+arrows move by word in the editor on Windows and Linux
        item(t('menu.view.nextMainTab'), 'view.nextMainTab', isMac ? 'Cmd+Ctrl+Right' : 'Ctrl+PageDown'),
        item(t('menu.view.prevMainTab'), 'view.prevMainTab', isMac ? 'Cmd+Ctrl+Left' : 'Ctrl+PageUp'),
        { type: 'separator' },
        { role: 'togglefullscreen', label: t('menu.view.toggleFullScreen') },
        ...(isDev
          ? ([
              { type: 'separator' },
              { role: 'reload', label: t('menu.view.reload') },
              { role: 'toggleDevTools', label: t('menu.view.toggleDevTools') }
            ] as MenuItemConstructorOptions[])
          : [])
      ]
    },
    {
      label: t('menu.query'),
      submenu: [
        sql(t('menu.query.executeAll'), 'query.executeAll', 'CmdOrCtrl+Shift+Enter'),
        sql(t('menu.query.executeCurrent'), 'query.executeCurrent', 'CmdOrCtrl+Enter'),
        sql(t('menu.query.executeVertical'), 'query.executeVertical', 'CmdOrCtrl+Alt+Enter'),
        sql(t('menu.query.explain'), 'query.explain', 'CmdOrCtrl+Alt+X'),
        sql(t('menu.query.stop'), 'query.stop', 'CmdOrCtrl+.'),
        {
          id: 'query.toggleStopOnError',
          label: t('menu.query.toggleStopOnError'),
          type: 'checkbox',
          checked: state.stopOnError,
          click: send('query.toggleStopOnError')
        },
        {
          label: t('menu.query.limitRows'),
          submenu: limitChoices.map((n) => ({
            id: `query.limit:${n}`,
            label: n === 0 ? t('menu.query.dontLimit') : t('menu.query.limitTo', { count: n }),
            type: 'radio' as const,
            checked: state.limitRows === n,
            click: send(`query.limit:${n}`)
          }))
        },
        { type: 'separator' },
        sql(t('menu.query.reconnect'), 'query.reconnect'),
        sql(t('menu.query.newConnectionTab'), 'query.newConnectionTab', 'CmdOrCtrl+Shift+T'),
        { type: 'separator' },
        {
          id: 'query.toggleAutocommit',
          label: t('menu.query.toggleAutocommit'),
          type: 'checkbox',
          checked: state.autocommit,
          click: send('query.toggleAutocommit')
        },
        sql(t('menu.query.commit'), 'query.commit'),
        sql(t('menu.query.rollback'), 'query.rollback'),
        { type: 'separator' },
        sql(t('menu.query.applyEdits'), 'query.applyEdits'),
        sql(t('menu.query.discardEdits'), 'query.discardEdits'),
        sql(t('menu.query.exportResults'), 'query.exportResults')
      ]
    },
    {
      label: t('menu.db'),
      submenu: [
        item(t('menu.db.connect'), 'db.connect', 'CmdOrCtrl+U'),
        item(t('menu.db.manageConnections'), 'db.manageConnections'),
        { type: 'separator' },
        sql(t('menu.db.createDatabase'), 'db.createDatabase'),
        sql(t('menu.db.createSchema'), 'db.createSchema'),
        sql(t('menu.db.createTable'), 'db.createTable'),
        sql(t('menu.db.searchData'), 'db.searchData')
      ]
    },
    {
      label: t('menu.server'),
      submenu: [
        sql(t('menu.server.status'), 'server.status'),
        sql(t('menu.server.connections'), 'server.connections'),
        sql(t('menu.server.users'), 'server.users'),
        sql(t('menu.server.variables'), 'server.variables'),
        sql(t('menu.server.agent'), 'server.agent'),
        { type: 'separator' },
        sql(t('menu.server.export'), 'server.export'),
        sql(t('menu.server.import'), 'server.import'),
        sql(t('menu.server.backup'), 'server.backup'),
        sql(t('menu.server.copy'), 'server.copy'),
        sql(t('menu.server.align'), 'server.align')
      ]
    },
    // Electron's default Window submenu on macOS, spelled out to label its items
    {
      role: 'windowMenu',
      label: t('menu.window'),
      submenu: [
        { role: 'minimize', label: t('menu.window.minimize') },
        { role: 'zoom', label: t('menu.window.zoom') },
        { type: 'separator' },
        { role: 'front', label: t('menu.window.front') }
      ]
    },
    {
      role: 'help',
      label: t('menu.help'),
      submenu: [
        { label: t('menu.help.mysqlManual'), click: () => void shell.openExternal('https://dev.mysql.com/doc/refman/8.4/en/') },
        { label: t('menu.help.mariadbKnowledgeBase'), click: () => void shell.openExternal('https://mariadb.com/kb/en/') },
        { label: t('menu.help.postgresDocs'), click: () => void shell.openExternal('https://www.postgresql.org/docs/current/') },
        { label: t('menu.help.mssqlDocs'), click: () => void shell.openExternal('https://learn.microsoft.com/sql/t-sql/language-reference') },
        { label: t('menu.help.sqliteDocs'), click: () => void shell.openExternal('https://www.sqlite.org/docs.html') }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  applyState()
}

function applyState(): void {
  const menu = Menu.getApplicationMenu()
  if (!menu) return
  const enabled = (id: string): boolean => state.inSqlEditor && !state.unavailable.includes(id)
  for (const id of sqlCommands) {
    const mi = menu.getMenuItemById(id)
    if (mi) mi.enabled = enabled(id)
  }
  const toggle = (id: string, checked: boolean): void => {
    const mi = menu.getMenuItemById(id)
    if (mi) {
      mi.checked = checked
      mi.enabled = enabled(id)
    }
  }
  toggle('query.toggleStopOnError', state.stopOnError)
  toggle('query.toggleAutocommit', state.autocommit)
  for (const n of limitChoices) {
    const mi = menu.getMenuItemById(`query.limit:${n}`)
    if (mi) mi.checked = state.limitRows === n
  }
}

export function setMenuState(next: MenuState): void {
  state = next
  applyState()
}
