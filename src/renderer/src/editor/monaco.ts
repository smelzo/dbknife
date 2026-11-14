import * as monaco from './monaco-entry'
import EditorWorker from 'monaco-esm/editor/editor.worker.js?worker'

self.MonacoEnvironment = { getWorker: () => new EditorWorker() }

export { monaco }

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')
let themeSetting: 'system' | 'light' | 'dark' = 'system'

const isDark = (): boolean => (themeSetting === 'system' ? darkQuery.matches : themeSetting === 'dark')

export function applyTheme(setting: 'system' | 'light' | 'dark'): void {
  themeSetting = setting
  if (setting === 'system') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = setting
  monaco.editor.setTheme(isDark() ? 'vs-dark' : 'vs')
}

darkQuery.addEventListener('change', () => applyTheme(themeSetting))
