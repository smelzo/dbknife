import { computed, onBeforeUnmount, watch } from 'vue'
import { quoteString } from '@shared/sql/quote'
import type { EditorTab, Workspace } from '@/workspace/workspace'
import { useApp } from '@/stores/app'

export type AdminTab = Extract<EditorTab, { kind: 'admin' }>

/** SHOW GLOBAL STATUS / VARIABLES as a name → value map, optionally limited to some names. */
export async function fetchGlobals(ws: Workspace, kind: 'STATUS' | 'VARIABLES', names?: string[]): Promise<Record<string, string>> {
  const where = names ? ` WHERE Variable_name IN (${names.map(quoteString).join(', ')})` : ''
  const r = await window.api.db.query(ws.sessionId, `SHOW GLOBAL ${kind}${where}`)
  if (r.error) throw new Error(r.error.message)
  return Object.fromEntries(r.rows.map((row) => [String(row.Variable_name), String(row.Value ?? '')]))
}

/**
 * Calls `tick` every `interval()` ms (0 = paused) while the admin tab is the
 * visible one, never overlapping runs. Stops when the component unmounts.
 */
export function usePolling(ws: Workspace, tab: AdminTab, interval: () => number, tick: () => Promise<void>): void {
  const app = useApp()
  const visible = computed(() => app.active === ws.id && ws.activeTab === tab.id)
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let stopped = false

  const schedule = (): void => {
    clearTimeout(timer)
    const ms = interval()
    if (!stopped && visible.value && ms) timer = setTimeout(run, ms)
  }

  async function run(): Promise<void> {
    if (running) return
    running = true
    try {
      await tick()
    } finally {
      running = false
      schedule()
    }
  }

  watch([visible, interval], schedule, { immediate: true })
  onBeforeUnmount(() => {
    stopped = true
    clearTimeout(timer)
  })
}
