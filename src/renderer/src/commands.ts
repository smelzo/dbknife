import { watch } from 'vue'
import type { Workspace } from './workspace/workspace'
import { openDialog, prompt } from './dialogs'
import { t } from './i18n'
import { beautify, changeKeywordCase } from './editor/sql-actions'
import { useApp } from './stores/app'
import { csvExtensions, sqliteExtensions } from '@shared/file-types'
import { applyEdits, exportResult, revertEdits } from './components/results/result-actions'
import { newDatabase, newSqliteDatabase, schemaDialog } from './workspace/object-actions'
import PreferencesDialog from './components/common/PreferencesDialog.vue'
import { runScriptRequests } from './components/admin/DataImport.vue'

/** Native menu commands the engine of a connection tab does not offer. */
function unavailableCommands(ws: Workspace): string[] {
  const f = ws.features
  const out: string[] = []
  for (const page of ['status', 'connections', 'users', 'variables', 'agent', 'export', 'import', 'backup', 'copy', 'align'] as const) {
    if (!f.adminPages.includes(page)) out.push(`server.${page}`)
  }
  // the import page runs SQL scripts only for the engines dumping to SQL
  if (!f.adminPages.includes('import') || f.dumpFormat !== 'sql') out.push('file.runScript')
  if (!f.newDatabase) out.push('db.createDatabase')
  if (!f.schemaEditor) out.push('db.createSchema')
  if (!f.reconnect) out.push('query.reconnect')
  if (!f.snippets) out.push('view.toggleSecondarySidebar')
  if (!ws.config.csv) out.push('file.saveCsv')
  // a second copy of a CSV file would overwrite the first one's changes when saved
  else out.push('query.newConnectionTab')
  return out
}

/** Hooks the native menu up to the active connection tab and keeps its check marks in sync. */
export function installCommands(homeActions: { newConnection: () => void }): void {
  const app = useApp()

  watch(
    () => {
      const ws = app.activeWorkspace
      return {
        inSqlEditor: !!ws,
        unavailable: ws ? unavailableCommands(ws) : [],
        stopOnError: app.settings.stopOnError,
        autocommit: ws?.autocommit ?? true,
        limitRows: app.settings.limitRows
      }
    },
    (state) => window.api.ui.setMenuState(state),
    { immediate: true, deep: true }
  )

  // shortcuts the SQL editor binds itself; when it has the focus it already handled the keys
  const editorShortcuts = new Set([
    'edit.find',
    'edit.replace',
    'edit.comment',
    'edit.autocomplete',
    'edit.beautify',
    'query.executeAll',
    'query.executeCurrent',
    'query.executeVertical',
    'query.explain'
  ])
  window.api.ui.onMenu((command, fromShortcut) => {
    if (fromShortcut && editorShortcuts.has(command) && document.activeElement?.closest('.monaco-editor')) return
    void run(command)
  })

  async function chooseConnection(): Promise<void> {
    if (!app.connections.length) {
      homeActions.newConnection()
      return
    }
    const r = await prompt({
      title: t('app.chooseConnection.title'),
      fields: [{ key: 'name', label: t('app.chooseConnection.storedConnection'), type: 'select', options: app.connections.map((c) => c.name), value: app.connections[0].name }],
      okLabel: t('app.chooseConnection.connect')
    })
    const config = r && app.connections.find((c) => c.name === r.name)
    if (config) await app.connect(config)
  }

  async function run(command: string): Promise<void> {
    const ws = app.activeWorkspace
    const tab = ws?.activeQueryTab
    const editor = tab?.editor
    const result = tab?.results[tab.activeResult]

    if (command.startsWith('query.limit:')) {
      await app.updateSettings({ limitRows: Number(command.split(':')[1]) })
      return
    }
    switch (command) {
      case 'app.preferences':
        await openDialog(PreferencesDialog)
        return
      case 'app.restart':
        await app.restart()
        return
      case 'view.home':
      case 'db.manageConnections':
        app.active = 'home'
        return
      case 'db.connect':
        await chooseConnection()
        return
      case 'view.nextMainTab':
        app.cycleMainTab(1)
        return
      case 'view.prevMainTab':
        app.cycleMainTab(-1)
        return
      case 'file.newQueryTab':
        if (ws) ws.newQueryTab()
        else await chooseConnection()
        return
      case 'file.openScript':
        if (ws) await ws.openScript()
        else await chooseConnection()
        return
      case 'file.newSqlite':
        await newSqliteDatabase()
        return
      case 'file.openSqlite': {
        const path = await window.api.files.chooseOpen({
          title: t('app.openSqlite.title'),
          filters: [{ name: t('connection.sqliteDatabases'), extensions: sqliteExtensions }]
        })
        if (path) await app.openFile(path)
        return
      }
      case 'file.openCsv': {
        const path = await window.api.files.chooseOpen({
          title: t('app.openCsv.title'),
          filters: [{ name: t('app.openCsv.csvFiles'), extensions: csvExtensions }]
        })
        if (path) await app.openFile(path)
        return
      }
      case 'file.closeTab':
        if (ws) {
          if (ws.activeTab) await ws.closeTab(ws.activeTab)
        }
        return
    }
    if (!ws) return
    // the menu state is updated asynchronously: a command may still arrive from an item about to be disabled
    if (unavailableCommands(ws).includes(command)) return
    switch (command) {
      case 'file.closeConnectionTab':
        await app.closeWorkspace(ws.id)
        break
      case 'file.save':
        if (tab) await ws.saveTab(tab)
        break
      case 'file.saveAs':
        if (tab) await ws.saveTab(tab, true)
        break
      case 'file.revert':
        if (tab) await ws.revertTab(tab)
        break
      case 'file.saveCsv':
        await ws.saveCsv()
        break
      case 'file.runScript':
        runScriptRequests.add(ws.id)
        ws.openAdmin('import')
        break
      case 'edit.find':
        void editor?.getAction('actions.find')?.run()
        break
      case 'edit.replace':
        void editor?.getAction('editor.action.startFindReplaceAction')?.run()
        break
      case 'edit.beautify':
        if (editor) beautify(editor, ws.dialect, ws.info)
        break
      case 'edit.upcase':
      case 'edit.lowercase':
        if (editor) changeKeywordCase(editor, ws.dialect, command === 'edit.upcase')
        break
      case 'edit.comment':
        void editor?.getAction('editor.action.commentLine')?.run()
        break
      case 'edit.autocomplete':
        void editor?.getAction('editor.action.triggerSuggest')?.run()
        break
      case 'view.toggleSidebar':
        ws.sidebarVisible = !ws.sidebarVisible
        break
      case 'view.toggleOutput':
        ws.outputVisible = !ws.outputVisible
        break
      case 'view.toggleSecondarySidebar':
        ws.secondaryVisible = !ws.secondaryVisible
        break
      case 'view.nextQueryTab':
        ws.cycleTab(1)
        break
      case 'view.prevQueryTab':
        ws.cycleTab(-1)
        break
      case 'query.executeAll':
        if (tab) await ws.execute(tab, 'all')
        break
      case 'query.executeCurrent':
        if (tab) await ws.execute(tab, 'current')
        break
      case 'query.executeVertical':
        if (tab) await ws.execute(tab, 'vertical')
        break
      case 'query.explain':
        if (tab) await ws.execute(tab, 'explain')
        break
      case 'query.stop':
        await ws.cancel()
        break
      case 'query.toggleStopOnError':
        await app.updateSettings({ stopOnError: !app.settings.stopOnError })
        break
      case 'query.reconnect':
        await ws.reconnect()
        break
      case 'query.newConnectionTab':
        await app.connect(ws.config)
        break
      case 'query.toggleAutocommit':
        await ws.setAutocommit(!ws.autocommit)
        break
      case 'query.commit':
        await ws.commit()
        break
      case 'query.rollback':
        await ws.rollback()
        break
      case 'query.applyEdits':
        if (result) await applyEdits(ws, result)
        break
      case 'query.discardEdits':
        if (result) revertEdits(result)
        break
      case 'query.exportResults':
        if (result) await exportResult(result)
        break
      case 'db.createDatabase':
        await newDatabase(ws)
        break
      case 'db.createSchema':
        await schemaDialog(ws, null)
        break
      case 'db.createTable':
        if (ws.defaultSchema) ws.openTableEditor(ws.defaultSchema, null)
        break
      case 'db.searchData':
        ws.openSearch()
        break
      case 'server.status':
        ws.openAdmin('status')
        break
      case 'server.connections':
        ws.openAdmin('connections')
        break
      case 'server.users':
        ws.openAdmin('users')
        break
      case 'server.variables':
        ws.openAdmin('variables')
        break
      case 'server.agent':
        ws.openAdmin('agent')
        break
      case 'server.export':
        ws.openAdmin('export')
        break
      case 'server.import':
        ws.openAdmin('import')
        break
      case 'server.backup':
        ws.openAdmin('backup')
        break
      case 'server.copy':
        ws.openAdmin('copy')
        break
      case 'server.align':
        ws.openAdmin('align')
        break
    }
  }
}
