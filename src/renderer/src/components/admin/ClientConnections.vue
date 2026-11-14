<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RefreshCw } from 'lucide-vue-next'
import type { Row } from '@shared/types'
import type { Workspace } from '@/workspace/workspace'
import { alertError, confirm } from '@/dialogs'
import { t } from '@/i18n'
import DataGrid, { type GridCell, type GridColumn } from '../grid/DataGrid.vue'
import { metadataQuery } from '@/workspace/catalog/mssql'
import { fetchGlobals, usePolling, type AdminTab } from './admin'

const props = defineProps<{ ws: Workspace; tab: AdminTab }>()

interface Connection {
  id: number | null
  user: string | null
  host: string | null
  db: string | null
  command: string | null
  time: number | null
  state: string | null
  threadId: number | null
  type: string
  name: string | null
  info: string | null
  /** Idle, hidden by "Hide sleeping connections". */
  sleeping: boolean
  /** SQL Server: what the request waits for, and the session blocking it. */
  wait?: string | null
  blockedBy?: number | null
}

interface Column extends GridColumn {
  get: (c: Connection) => string | number | null
}

/** Where an engine lists its connections, and how it ends them. */
interface Source {
  ownIdSql: string
  /** The connections; throws on error. */
  load(): Promise<Connection[]>
  columns(): Column[]
  summary(): Promise<[string, string | undefined][]>
  killSql(id: number, what: 'QUERY' | 'CONNECTION'): string
  /** Background processes, hidden by "Hide background threads"; absent when only client sessions are listed. */
  background?: (c: Connection) => boolean
  /** Whether a query can be stopped without ending its connection (Kill Query). */
  killsQueries: boolean
  /** Whether the connection these queries run on may end itself. */
  killsItself: boolean
}

const rates = [0, 0.5, 1, 2, 3, 5, 10, 15, 30]
const rate = ref(1)
const hideSleeping = ref(false)
const hideBackground = ref(true)
const showDetails = ref(true)
const connections = ref<Connection[]>([])
/** performance_schema.threads is used when available (MySQL), else the processlist. */
const fromThreads = ref(false)
const summaryItems = ref<[string, string | undefined][]>([])
const error = ref('')
const version = ref(0)
const sort = ref<{ col: number; dir: 'asc' | 'desc' } | null>(null)
const grid = ref<InstanceType<typeof DataGrid>>()
/** Thread (or connection) id of the row shown in the details pane. */
const selectedKey = ref<number | null>(null)
/** Connection id of the auxiliary connection these queries run on. */
let auxId: number | null = null

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const key = (c: Connection): number | null => c.threadId ?? c.id

// --- MySQL -----------------------------------------------------------------------------

const threadsSql = `SELECT PROCESSLIST_ID, PROCESSLIST_USER, PROCESSLIST_HOST, PROCESSLIST_DB, PROCESSLIST_COMMAND,
  PROCESSLIST_TIME, PROCESSLIST_STATE, THREAD_ID, TYPE, NAME, PROCESSLIST_INFO
  FROM performance_schema.threads ORDER BY THREAD_ID`
const processlistSql = 'SELECT ID, USER, HOST, DB, COMMAND, TIME, STATE, INFO FROM information_schema.PROCESSLIST ORDER BY ID'

const fromThreadsRow = (r: Row): Connection => ({
  id: num(r.PROCESSLIST_ID),
  user: str(r.PROCESSLIST_USER),
  host: str(r.PROCESSLIST_HOST),
  db: str(r.PROCESSLIST_DB),
  command: str(r.PROCESSLIST_COMMAND),
  time: num(r.PROCESSLIST_TIME),
  state: str(r.PROCESSLIST_STATE),
  threadId: num(r.THREAD_ID),
  type: String(r.TYPE),
  name: str(r.NAME),
  info: str(r.PROCESSLIST_INFO),
  sleeping: r.PROCESSLIST_COMMAND === 'Sleep'
})

const fromProcesslistRow = (r: Row): Connection => ({
  id: num(r.ID),
  user: str(r.USER),
  host: str(r.HOST),
  db: str(r.DB),
  command: str(r.COMMAND),
  time: num(r.TIME),
  state: str(r.STATE),
  threadId: null,
  type: r.COMMAND === 'Daemon' || r.USER === 'system user' ? 'BACKGROUND' : 'FOREGROUND',
  name: null,
  info: str(r.INFO),
  sleeping: r.COMMAND === 'Sleep'
})

const summaryStatus = [
  'Threads_connected',
  'Threads_running',
  'Threads_created',
  'Threads_cached',
  'Connections',
  'Aborted_clients',
  'Aborted_connects',
  'Connection_errors_accept',
  'Connection_errors_internal',
  'Connection_errors_max_connections',
  'Connection_errors_peer_address',
  'Connection_errors_select',
  'Connection_errors_tcpwrap'
]

const mysqlSource: Source = {
  ownIdSql: 'SELECT CONNECTION_ID() AS id',
  async load() {
    const ws = props.ws
    let r = ws.info?.isMariaDB ? undefined : await window.api.db.query(ws.sessionId, threadsSql)
    fromThreads.value = !!r && !r.error
    if (!fromThreads.value) r = await window.api.db.query(ws.sessionId, processlistSql)
    if (r!.error) throw new Error(r!.error.message)
    return r!.rows.map(fromThreads.value ? fromThreadsRow : fromProcesslistRow)
  },
  columns() {
    const cols: Column[] = [
      { name: t('admin.connections.id'), align: 'right', get: (c) => c.id },
      { name: t('admin.connections.user'), get: (c) => c.user },
      { name: t('admin.connections.host'), get: (c) => c.host },
      { name: t('admin.connections.db'), get: (c) => c.db },
      { name: t('admin.connections.command'), get: (c) => c.command },
      { name: t('admin.connections.time'), align: 'right', get: (c) => c.time },
      { name: t('admin.connections.state'), get: (c) => c.state },
      { name: t('admin.connections.threadType'), get: (c) => c.type }
    ]
    if (fromThreads.value) {
      cols.splice(7, 0, { name: t('admin.connections.threadId'), align: 'right', get: (c) => c.threadId })
      cols.push({ name: t('admin.connections.name'), get: (c) => c.name })
    }
    return cols
  },
  async summary() {
    let s: Record<string, string>
    try {
      s = { ...(await fetchGlobals(props.ws, 'STATUS', summaryStatus)), ...(await fetchGlobals(props.ws, 'VARIABLES', ['max_connections'])) }
    } catch {
      return []
    }
    const errors = summaryStatus.filter((n) => n.startsWith('Connection_errors_')).reduce((sum, n) => sum + Number(s[n] ?? 0), 0)
    return [
      [t('admin.connections.threadsConnected'), s.Threads_connected],
      [t('admin.connections.threadsRunning'), s.Threads_running],
      [t('admin.connections.threadsCreated'), s.Threads_created],
      [t('admin.connections.threadsCached'), s.Threads_cached],
      [t('admin.connections.rejected'), s.Connection_errors_max_connections],
      [t('admin.connections.totalConnections'), s.Connections],
      [t('admin.connections.connectionLimit'), s.max_connections],
      [t('admin.connections.abortedClients'), s.Aborted_clients],
      [t('admin.connections.abortedConnections'), s.Aborted_connects],
      [t('admin.connections.errors'), s.Connections === undefined ? undefined : String(errors)]
    ]
  },
  killSql: (id, what) => (what === 'QUERY' ? `KILL QUERY ${id}` : `KILL ${id}`),
  background: (c) => c.type === 'BACKGROUND',
  killsQueries: true,
  killsItself: true
}

// --- PostgreSQL ------------------------------------------------------------------------

/** Every server process: client backends and the background workers (autovacuum, checkpointer...). */
const activitySql = `SELECT pid, usename, client_addr::text AS client_addr, client_hostname, client_port, datname, state,
  floor(extract(epoch FROM now() - coalesce(state_change, backend_start)))::int AS seconds,
  wait_event_type, wait_event, backend_type, application_name, query
  FROM pg_stat_activity ORDER BY pid`

const fromActivityRow = (r: Row): Connection => ({
  id: num(r.pid),
  user: str(r.usename),
  host: r.client_addr === null ? (r.backend_type === 'client backend' ? 'local' : null) : `${r.client_hostname ?? r.client_addr}:${r.client_port}`,
  db: str(r.datname),
  command: str(r.state),
  time: num(r.seconds),
  state: r.wait_event ? `${r.wait_event_type}: ${r.wait_event}` : null,
  threadId: null,
  type: String(r.backend_type),
  name: str(r.application_name),
  info: str(r.query),
  sleeping: r.state === 'idle'
})

const postgresSource: Source = {
  ownIdSql: 'SELECT pg_backend_pid() AS id',
  load: async () => (await props.ws.query(activitySql)).map(fromActivityRow),
  columns: () => [
    { name: 'PID', align: 'right', get: (c) => c.id },
    { name: t('admin.connections.user'), get: (c) => c.user },
    { name: t('admin.connections.host'), get: (c) => c.host },
    { name: t('admin.connections.db'), get: (c) => c.db },
    { name: t('admin.connections.state'), get: (c) => c.command },
    { name: t('admin.connections.time'), align: 'right', get: (c) => c.time },
    { name: t('admin.connections.waitingFor'), get: (c) => c.state },
    { name: t('admin.connections.backendType'), get: (c) => c.type },
    { name: t('admin.connections.application'), get: (c) => c.name }
  ],
  async summary() {
    const rows = connections.value.filter((c) => c.type === 'client backend')
    const count = (state: string): string => String(rows.filter((c) => c.command === state).length)
    let limit: string | undefined
    try {
      limit = String((await props.ws.query('SHOW max_connections'))[0]?.max_connections)
    } catch {
      limit = undefined
    }
    return [
      [t('admin.connections.clientConnections'), String(rows.length)],
      [t('admin.connections.active'), count('active')],
      [t('admin.connections.idle'), count('idle')],
      [t('admin.connections.idleInTransaction'), count('idle in transaction')],
      [t('admin.connections.waitingForLock'), String(rows.filter((c) => c.state?.startsWith('Lock:')).length)],
      [t('admin.connections.connectionLimit'), limit]
    ]
  },
  // pg_cancel_backend stops the running query, pg_terminate_backend ends the process
  killSql: (id, what) => `SELECT ${what === 'QUERY' ? 'pg_cancel_backend' : 'pg_terminate_backend'}(${id}) AS signalled`,
  background: (c) => c.type !== 'client backend',
  killsQueries: true,
  killsItself: true
}

// --- SQL Server ------------------------------------------------------------------------

/**
 * User sessions with their running request, if any, and the text of the
 * running (or else the last) batch. Without VIEW SERVER STATE only the
 * login's own sessions are listed.
 */
const sessionsSql = `SELECT s.session_id, s.login_name, s.host_name, s.program_name, DB_NAME(s.database_id) AS db, s.status,
  r.command, r.wait_type, r.wait_time, r.blocking_session_id, c.client_net_address, c.client_tcp_port,
  DATEDIFF(SECOND, COALESCE(r.start_time, s.last_request_end_time, s.login_time), GETDATE()) AS seconds, q.text AS query
  FROM sys.dm_exec_sessions s
  LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id
  LEFT JOIN sys.dm_exec_connections c ON c.session_id = s.session_id AND c.parent_connection_id IS NULL
  OUTER APPLY sys.dm_exec_sql_text(COALESCE(r.sql_handle, c.most_recent_sql_handle)) q
  WHERE s.is_user_process = 1
  ORDER BY s.session_id`

const fromSessionRow = (r: Row): Connection => ({
  id: num(r.session_id),
  user: str(r.login_name),
  host: r.client_net_address === null ? str(r.host_name) : `${r.host_name ?? r.client_net_address}${r.client_tcp_port === null ? '' : `:${r.client_tcp_port}`}`,
  db: str(r.db),
  command: str(r.command),
  time: num(r.seconds),
  state: str(r.status),
  threadId: null,
  type: '',
  name: str(r.program_name),
  info: str(r.query),
  sleeping: r.status === 'sleeping',
  wait: r.wait_type ? `${r.wait_type} (${r.wait_time} ms)` : null,
  // 0: not blocked
  blockedBy: num(r.blocking_session_id) || null
})

const mssqlSource: Source = {
  ownIdSql: 'SELECT @@SPID AS id',
  load: async () => (await metadataQuery(props.ws.query)(sessionsSql)).map(fromSessionRow),
  columns: () => [
    { name: t('admin.connections.sessionId'), align: 'right', get: (c) => c.id },
    { name: t('admin.connections.login'), get: (c) => c.user },
    { name: t('admin.connections.host'), get: (c) => c.host },
    { name: t('admin.connections.db'), get: (c) => c.db },
    { name: t('admin.connections.state'), get: (c) => c.state },
    { name: t('admin.connections.command'), get: (c) => c.command },
    { name: t('admin.connections.time'), align: 'right', get: (c) => c.time },
    { name: t('admin.connections.waitingFor'), get: (c) => c.wait ?? null },
    { name: t('admin.connections.blockedBy'), align: 'right', get: (c) => c.blockedBy ?? null },
    { name: t('admin.connections.application'), get: (c) => c.name }
  ],
  async summary() {
    const rows = connections.value
    const count = (status: string): string => String(rows.filter((c) => c.state === status).length)
    let row: Row | undefined
    try {
      ;[row] = await props.ws.query(`SELECT @@MAX_CONNECTIONS AS max_connections, HAS_PERMS_BY_NAME(NULL, NULL, 'VIEW SERVER STATE') AS view_server_state`)
    } catch {
      row = undefined
    }
    return [
      [t('admin.connections.userSessions'), String(rows.length)],
      [t('admin.connections.running'), count('running')],
      [t('admin.connections.sleeping'), count('sleeping')],
      [t('admin.connections.blocked'), String(rows.filter((c) => c.blockedBy).length)],
      [t('admin.connections.connectionLimit'), row ? String(row.max_connections) : undefined],
      ['VIEW SERVER STATE', row?.view_server_state === 0 ? t('admin.connections.ownSessionsOnly') : undefined]
    ]
  },
  // KILL rolls back the session's open transaction; a running query cannot be stopped alone
  killSql: (id) => `KILL ${id}`,
  killsQueries: false,
  killsItself: false
}

const sources = { mysql: mysqlSource, postgres: postgresSource, mssql: mssqlSource }
const source = sources[props.ws.config.engine as keyof typeof sources]

async function refresh(): Promise<void> {
  const ws = props.ws
  if (auxId === null) {
    const r = await window.api.db.query(ws.sessionId, source.ownIdSql)
    auxId = num(r.rows[0]?.id)
  }
  try {
    connections.value = await source.load()
    error.value = ''
  } catch (e) {
    error.value = (e as Error).message
  }
  summaryItems.value = (await source.summary()).filter((i) => i[1] !== undefined)
  version.value++
}

onMounted(refresh)
usePolling(props.ws, props.tab, () => rate.value * 1000, refresh)

// --- grid ------------------------------------------------------------------------------

const columns = computed<Column[]>(() => {
  void fromThreads.value
  return [...source.columns(), { name: t('admin.connections.info'), width: 400, get: (c) => c.info }]
})

const view = computed<Connection[]>(() => {
  let rows = connections.value.filter(
    (c) => !(hideSleeping.value && c.sleeping) && !(hideBackground.value && source.background?.(c))
  )
  const s = sort.value
  if (s) {
    const get = columns.value[s.col].get
    const dir = s.dir === 'asc' ? 1 : -1
    rows = [...rows].sort((a, b) => {
      const ka = get(a)
      const kb = get(b)
      if (ka === kb) return 0
      if (ka === null) return -dir
      if (kb === null) return dir
      return (ka < kb ? -1 : 1) * dir
    })
  }
  return rows
})

function cell(r: number, c: number): GridCell {
  const v = columns.value[c].get(view.value[r])
  return v === null ? { text: 'NULL', cls: 'null' } : { text: String(v).replace(/\s+/g, ' ') }
}

function onSort(col: number): void {
  const s = sort.value
  sort.value = !s || s.col !== col ? { col, dir: 'asc' } : s.dir === 'asc' ? { col, dir: 'desc' } : null
}

const onSelect = (r: number): void => {
  selectedKey.value = view.value[r] ? key(view.value[r]) : null
}

const selected = computed(() => connections.value.find((c) => key(c) === selectedKey.value))

const detailRows = computed<[string, string][]>(() => {
  const c = selected.value
  if (!c) return []
  // every column but the last, Info, shown below the table
  return columns.value
    .slice(0, -1)
    .map((col) => [col.name, String(col.get(c) ?? 'NULL')])
})

// --- kill ----------------------------------------------------------------------------------

async function kill(what: 'QUERY' | 'CONNECTION'): Promise<void> {
  const rows = (grid.value?.selectedRows() ?? []).map((r) => view.value[r]).filter((c) => c?.id !== null)
  let ids = [...new Set(rows.map((c) => c.id!))]
  if (!source.killsItself && auxId !== null && ids.includes(auxId)) {
    ids = ids.filter((id) => id !== auxId)
    await alertError(t('admin.connections.ownSessionNotKilled', { id: String(auxId) }), t('admin.connections.ownSessionNotKilledDetail'))
  }
  if (!ids.length) return
  const own = ids.filter((id) => id === props.ws.info?.threadId || id === auxId)
  const query = what === 'QUERY'
  const ok = own.length
    ? await confirm(
        t('admin.connections.ownSelection', { ids: own.join(', ') }),
        t(query ? 'admin.connections.ownKillQuery' : 'admin.connections.ownKillConnection', {
          editorId: String(props.ws.info?.threadId),
          auxId: String(auxId),
          count: ids.length
        }),
        t(query ? 'admin.connections.killQuery' : 'admin.connections.killConnection')
      )
    : await confirm(
        t(query ? 'admin.connections.confirmKillQuery' : 'admin.connections.confirmKillConnection', { count: ids.length }),
        t('admin.connections.ids', { ids: ids.join(', ') })
      )
  if (!ok) return
  const errors: string[] = []
  for (const id of ids) {
    const sql = source.killSql(id, what)
    const r = await window.api.db.query(props.ws.sessionId, sql)
    // the PostgreSQL functions answer false when the process is gone or may not be signalled
    const message = r.error?.message ?? (r.rows[0]?.signalled === 'false' ? t('admin.connections.notSignalled') : '')
    props.ws.log(message ? 'error' : 'ok', sql, message || t('common.ok'))
    if (message) errors.push(`${id}: ${message}`)
  }
  if (errors.length) {
    await alertError(t(query ? 'admin.connections.killQueryFailed' : 'admin.connections.killConnectionFailed', { count: errors.length }), errors.join('\n'))
  }
  await refresh()
}

</script>

<template>
  <div class="page">
    <div class="toolbar">
      <label class="rate">
        {{ t('admin.connections.refreshRate') }}
        <select v-model.number="rate">
          <option v-for="r in rates" :key="r" :value="r">{{ r ? t('admin.connections.seconds', { count: r }) : t('admin.connections.dontRefresh') }}</option>
        </select>
      </label>
      <span class="sep" />
      <label class="check"><input v-model="hideSleeping" type="checkbox" /> {{ t('admin.connections.hideSleeping') }}</label>
      <label v-if="source.background" class="check"><input v-model="hideBackground" type="checkbox" /> {{ t('admin.connections.hideBackground') }}</label>
      <label class="check"><input v-model="showDetails" type="checkbox" /> {{ t('admin.connections.showDetails') }}</label>
      <span class="spacer" />
      <button v-if="source.killsQueries" @click="kill('QUERY')">{{ t('admin.connections.killQueries') }}</button>
      <button @click="kill('CONNECTION')">{{ t('admin.connections.killConnections') }}</button>
      <button class="icon-btn" :title="t('admin.refresh')" @click="refresh"><RefreshCw :size="14" /></button>
    </div>
    <div v-if="error" class="error selectable">{{ error }}</div>
    <div class="list">
      <DataGrid
        ref="grid"
        :columns="columns"
        :row-count="view.length"
        :cell="cell"
        :version="version"
        :sort="sort"
        :row-numbers="false"
        @sort="onSort"
        @selection-change="onSelect"
      />
    </div>
    <div v-if="showDetails" class="details">
      <template v-if="selected">
        <table class="kv">
          <tbody>
            <tr v-for="[label, value] in detailRows" :key="label">
              <th>{{ label }}</th>
              <td class="selectable">{{ value }}</td>
            </tr>
          </tbody>
        </table>
        <pre class="info mono selectable">{{ selected.info ?? '' }}</pre>
      </template>
      <div v-else class="empty-state">{{ t('admin.connections.selectHint') }}</div>
    </div>
    <div class="summary">
      <span v-for="[label, value] in summaryItems" :key="label">
        <span class="muted">{{ t('admin.connections.summaryLabel', { label }) }}</span> {{ value }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.toolbar {
  gap: 10px;
  flex-wrap: wrap;
}

.toolbar .sep {
  margin: 0;
}

.rate {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.error {
  padding: 6px 10px;
  color: var(--danger);
  border-bottom: 1px solid var(--border);
}

.list {
  flex: 1;
  min-height: 80px;
}

.details {
  height: 190px;
  flex-shrink: 0;
  display: grid;
  grid-template-columns: minmax(220px, 320px) 1fr;
  border-top: 1px solid var(--border);
  background: var(--bg-panel);
}

.details .empty-state {
  grid-column: 1 / -1;
}

table.kv {
  border-collapse: collapse;
  margin: 6px 10px;
  align-self: start;
}

table.kv th,
table.kv td {
  padding: 1px 0;
  text-align: left;
  white-space: nowrap;
}

table.kv th {
  padding-right: 12px;
  font-weight: normal;
  color: var(--text-muted);
}

.info {
  margin: 0;
  padding: 6px 10px;
  overflow: auto;
  white-space: pre-wrap;
  border-left: 1px solid var(--border);
  background: var(--bg-content);
}

.summary {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 16px;
  padding: 5px 10px;
  border-top: 1px solid var(--border);
  background: var(--bg-panel);
  font-size: var(--fs-small);
  flex-shrink: 0;
}
</style>
