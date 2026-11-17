import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { Api } from '@shared/api'

const invoke =
  <T>(channel: string) =>
  (...args: unknown[]): Promise<T> =>
    ipcRenderer.invoke(channel, ...args) as Promise<T>

function subscribe<T extends unknown[]>(channel: string, callback: (...values: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...values: T): void => callback(...values)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: Api = {
  connections: {
    list: invoke('connections:list'),
    save: invoke('connections:save'),
    remove: invoke('connections:remove'),
    reorder: invoke('connections:reorder'),
    importWorkbench: invoke('connections:importWorkbench')
  },
  channels: {
    list: invoke('channels:list'),
    save: invoke('channels:save'),
    remove: invoke('channels:remove'),
    browseOpen: invoke('channels:browseOpen'),
    browseList: invoke('channels:browseList'),
    browseClose: invoke('channels:browseClose'),
    configHosts: invoke('channels:configHosts')
  },
  secrets: {
    status: invoke('secrets:status'),
    set: invoke('secrets:set'),
    clear: invoke('secrets:clear')
  },
  db: {
    open: invoke('db:open'),
    test: invoke('db:test'),
    openTemporary: invoke('db:openTemporary'),
    close: invoke('db:close'),
    execute: invoke('db:execute'),
    explain: invoke('db:explain'),
    cancel: invoke('db:cancel'),
    query: invoke('db:query'),
    currentSchema: invoke('db:currentSchema'),
    setAutocommit: invoke('db:setAutocommit')
  },
  csv: {
    status: invoke('csv:status'),
    save: invoke('csv:save')
  },
  tools: {
    find: invoke('tools:find'),
    exportDump: invoke('tools:exportDump'),
    importDump: invoke('tools:importDump'),
    copyPreview: invoke('tools:copyPreview'),
    copyDatabase: invoke('tools:copyDatabase'),
    mssqlBackup: invoke('tools:mssqlBackup'),
    mssqlRestore: invoke('tools:mssqlRestore'),
    cancel: invoke('tools:cancel'),
    onProgress: (cb) => subscribe('tools:progress', cb)
  },
  files: {
    openSql: invoke('files:openSql'),
    read: invoke('files:read'),
    readBinary: invoke('files:readBinary'),
    write: invoke('files:write'),
    writeXlsx: invoke('files:writeXlsx'),
    spreadAvailable: invoke('files:spreadAvailable'),
    readSpread: invoke('files:readSpread'),
    chooseImportFile: invoke('files:chooseImportFile'),
    chooseOpen: invoke('files:chooseOpen'),
    chooseSave: invoke('files:chooseSave'),
    pathForFile: (file) => webUtils.getPathForFile(file),
    reveal: invoke('files:reveal'),
    newSqlite: invoke('files:newSqlite')
  },
  recentFiles: {
    list: invoke('recentFiles:list'),
    remove: invoke('recentFiles:remove')
  },
  ui: {
    contextMenu: invoke('ui:contextMenu'),
    message: invoke('ui:message'),
    setMenuState: (state) => ipcRenderer.send('ui:menuState', state),
    onMenu: (cb) => subscribe('menu-command', cb),
    openExternal: invoke('ui:openExternal')
  },
  settings: {
    get: invoke('settings:get'),
    set: invoke('settings:set')
  },
  workspace: {
    load: invoke('workspace:load'),
    save: invoke('workspace:save')
  },
  history: {
    append: invoke('history:append'),
    load: invoke('history:load')
  },
  snippets: {
    load: invoke('snippets:load'),
    save: invoke('snippets:save')
  },
  i18n: {
    info: ipcRenderer.sendSync('i18n:get'),
    list: invoke('i18n:list'),
    install: invoke('i18n:install'),
    remove: invoke('i18n:remove'),
    openFolder: invoke('i18n:openFolder')
  },
  app: {
    jobsRunning: invoke('app:jobsRunning'),
    restart: () => ipcRenderer.send('app:restart'),
    updateReady: invoke('app:updateReady'),
    onUpdateReady: (cb) => subscribe('app:updateReady', cb),
    onOpenFile: (cb) => {
      const off = subscribe('app:openFile', cb)
      ipcRenderer.send('app:openFileReady')
      return off
    },
    setUnsaved: (unsaved) => ipcRenderer.send('app:unsaved', unsaved),
    onCloseRequest: (cb) => subscribe('app:closeRequest', cb),
    closeConfirmed: () => ipcRenderer.send('app:closeConfirmed')
  }
}

contextBridge.exposeInMainWorld('api', api)
