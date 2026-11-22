<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ClipboardCopy, Copy, RefreshCw } from 'lucide-vue-next'
import { quoteString } from '@shared/sql/quote'
import { valueText } from '@shared/value-text'
import type { Workspace } from '@/workspace/workspace'
import { alertError, promptText } from '@/dialogs'
import { metadataQuery } from '@/workspace/catalog/mssql'
import { reviewAndApply } from '@/workspace/review'
import { t } from '@/i18n'
import DataGrid, { type GridCell, type GridColumn } from '../grid/DataGrid.vue'
import { fetchGlobals, type AdminTab } from './admin'

const props = defineProps<{ ws: Workspace; tab: AdminTab }>()

type Kind = 'status' | 'system'
/** `extra`: the values of the source's systemColumns. */
type Variable = [name: string, value: string, category: string, extra?: string[]]

/** Where an engine's status counters and settings come from, and how a setting is changed. */
interface Source {
  tabs: Record<Kind, string>
  /** Headings of the lists copied to the clipboard. */
  titles: Record<Kind, string>
  copyAllTitle: string
  promptTitle: string
  editHint: string
  /** Category order; categories not listed follow alphabetically, otherCategory last. */
  categoryOrder: string[]
  /** Headings of the system settings' columns after Name and Value. */
  systemColumns?: string[]
  load(): Promise<Record<Kind, Variable[]>>
  /** Changes a setting; returns an error message, '' when done, null when the review dialog did not apply it. */
  set(name: string, value: string): Promise<string | null>
}

// --- MySQL ------------------------------------------------------------------------------

const otherCategory = t('admin.variables.categoryOther')

/** Categories by name prefix, first match wins; anything else is otherCategory. */
const categoryRules: [string, RegExp][] = [
  ['InnoDB', /^innodb/],
  ['Performance Schema', /^performance_schema/],
  ['Binlog', /^(binlog|log_bin|max_binlog|sync_binlog|log_slave|log_replica)/],
  [t('admin.variables.categoryReplication'), /^(rpl_|slave|replica|source_|master_|gtid|relay_log|sync_master|sync_relay|wsrep|server_id|server_uuid)/],
  [t('admin.variables.categoryQueryCache'), /^(qcache|query_cache|have_query_cache)/],
  ['SSL', /^(ssl|tls|have_ssl|have_openssl|current_tls|admin_ssl|admin_tls)/],
  [
    t('admin.variables.categoryConnections'),
    /^(connection|aborted|max_connect|max_used_connections|max_user_connections|connect_timeout|wait_timeout|interactive_timeout|locked_connects)/
  ],
  [t('admin.variables.categoryThreads'), /^thread/],
  [t('admin.variables.categoryHandler'), /^handler/],
  [t('admin.variables.categoryCommands'), /^com_/],
  [t('admin.variables.categoryKeyCache'), /^key_/],
  [t('admin.variables.categoryTableCache'), /^(table_open_cache|table_definition_cache|open_|opened_|table_locks)/],
  [t('admin.variables.categoryTemporaryTables'), /^(created_tmp|tmp_|max_heap_table_size)/],
  [t('admin.variables.categoryNetwork'), /^(bytes_|net_|max_allowed_packet)/],
  [t('admin.variables.categorySortSelect'), /^(sort_|select_)/],
  [t('admin.variables.categoryLogging'), /^(log_|general_log|slow_|long_query_time)/],
  [t('admin.variables.categoryCharacterSets'), /^(character_set|collation)/]
]

const categoryOf = (name: string): string => {
  const n = name.toLowerCase()
  return categoryRules.find(([, re]) => re.test(n))?.[0] ?? otherCategory
}

/** Numbers and keywords go unquoted, anything else as a string literal. */
const valueLiteral = (v: string): string => (/^(-?\d+(\.\d+)?|ON|OFF|TRUE|FALSE|DEFAULT)$/i.test(v.trim()) ? v.trim() : quoteString(v))

const mysqlSource: Source = {
  tabs: { status: t('admin.variables.statusVariables'), system: t('admin.variables.systemVariables') },
  titles: { status: t('admin.variables.globalStatus'), system: t('admin.variables.globalVariables') },
  copyAllTitle: t('admin.variables.copyAllMysql'),
  promptTitle: t('admin.variables.setGlobal'),
  editHint: t('admin.variables.editHintMysql'),
  categoryOrder: categoryRules.map(([c]) => c),
  async load() {
    const [status, system] = await Promise.all([fetchGlobals(props.ws, 'STATUS'), fetchGlobals(props.ws, 'VARIABLES')])
    const rows = (vars: Record<string, string>): Variable[] => Object.entries(vars).map(([n, v]) => [n, v, categoryOf(n)])
    return { status: rows(status), system: rows(system) }
  },
  async set(name, value) {
    const outcome = await props.ws.runStatements([`SET GLOBAL ${name} = ${valueLiteral(value)}`])
    return outcome.ok ? '' : (outcome.error ?? t('admin.variables.failed'))
  }
}

// --- PostgreSQL -------------------------------------------------------------------------

/** Statistics views of one row (or the row of the current database), shown as name.column counters. */
const statViews: [category: string, prefix: string, sql: string][] = [
  [t('admin.variables.categoryDatabase'), 'database', 'SELECT * FROM pg_stat_database WHERE datname = current_database()'],
  [t('admin.variables.categoryConnections'), 'connections', `SELECT count(*) AS total, count(*) FILTER (WHERE state = 'active') AS active,
    count(*) FILTER (WHERE state = 'idle') AS idle, count(*) FILTER (WHERE state LIKE 'idle in transaction%') AS idle_in_transaction,
    count(*) FILTER (WHERE wait_event_type = 'Lock') AS waiting_for_lock FROM pg_stat_activity WHERE backend_type = 'client backend'`],
  [t('admin.variables.categoryBackgroundWriter'), 'bgwriter', 'SELECT * FROM pg_stat_bgwriter'],
  // PostgreSQL 17+; the earlier versions have these counters in pg_stat_bgwriter
  [t('admin.variables.categoryCheckpointer'), 'checkpointer', 'SELECT * FROM pg_stat_checkpointer'],
  ['WAL', 'wal', 'SELECT * FROM pg_stat_wal'],
  [t('admin.variables.categoryArchiver'), 'archiver', 'SELECT * FROM pg_stat_archiver'],
  [t('admin.variables.categoryReplication'), 'replication', 'SELECT count(*) AS standbys FROM pg_stat_replication']
]

const postgresSource: Source = {
  tabs: { status: t('admin.variables.statistics'), system: t('admin.variables.settings') },
  titles: { status: t('admin.variables.statistics'), system: t('admin.variables.settings') },
  copyAllTitle: t('admin.variables.copyAllPostgres'),
  promptTitle: t('admin.variables.changeSetting'),
  editHint: t('admin.variables.editHintPostgres'),
  categoryOrder: statViews.map(([c]) => c),
  async load() {
    const status: Variable[] = []
    // a view missing on this server version is skipped
    const views = await Promise.all(statViews.map(([, , sql]) => props.ws.query(sql).catch(() => [])))
    statViews.forEach(([category, prefix], i) => {
      for (const [col, v] of Object.entries(views[i][0] ?? {})) {
        if (!['datid', 'datname'].includes(col)) status.push([`${prefix}.${col}`, valueText(v), category])
      }
    })
    const settings = await props.ws.query(`SELECT name, current_setting(name) AS value, category FROM pg_settings ORDER BY name`)
    return { status, system: settings.map((r) => [String(r.name), valueText(r.value), String(r.category)]) }
  },
  async set(name, value) {
    const [row] = await props.ws.query('SELECT context FROM pg_settings WHERE name = $1', [name])
    if (row?.context === 'internal') return t('admin.variables.fixedSetting', { name })
    const outcome = await props.ws.runStatements([`ALTER SYSTEM SET ${name.split('.').map(props.ws.dialect.quoteIdentifier).join('.')} = ${props.ws.dialect.quoteString(value)}`, 'SELECT pg_reload_conf()'])
    if (!outcome.ok) return outcome.error ?? t('admin.variables.failed')
    const [after] = await props.ws.query('SELECT pending_restart FROM pg_settings WHERE name = $1', [name])
    if (after?.pending_restart === 'true') props.ws.log('info', `ALTER SYSTEM SET ${name}`, t('admin.variables.pendingRestart'))
    return ''
  }
}

// --- SQL Server -------------------------------------------------------------------------

/** Counters of the server functions, shown with the performance counters. */
const serverFunctions = ['CONNECTIONS', 'CPU_BUSY', 'IDLE', 'IO_BUSY', 'PACK_RECEIVED', 'PACK_SENT', 'PACKET_ERRORS', 'TOTAL_READ', 'TOTAL_WRITE', 'TOTAL_ERRORS', 'TIMETICKS', 'MAX_CONNECTIONS']

const yesNo = (v: unknown): string => (v === 1 || v === true ? t('admin.status.yes') : t('admin.status.no'))

/** sp_configure takes integers only. */
const integer = /^-?\d+$/

const mssqlSource: Source = {
  tabs: { status: t('admin.variables.performanceCounters'), system: t('admin.variables.configuration') },
  titles: { status: t('admin.variables.performanceCounters'), system: t('admin.variables.configuration') },
  copyAllTitle: t('admin.variables.copyAllMssql'),
  promptTitle: t('admin.variables.changeOption'),
  editHint: t('admin.variables.editHintMssql'),
  categoryOrder: [t('admin.variables.categorySystemFunctions')],
  systemColumns: [
    t('admin.variables.valueInUse'),
    t('admin.variables.minimum'),
    t('admin.variables.maximum'),
    t('admin.variables.dynamic'),
    t('admin.variables.advanced'),
    t('admin.variables.description')
  ],
  async load() {
    const query = metadataQuery(props.ws.query)
    const [[functions], counters, options] = await Promise.all([
      query(`SELECT ${serverFunctions.map((f) => `@@${f} AS ${f}`).join(', ')}`),
      // without VIEW SERVER STATE only the server functions are shown
      query(`SELECT RTRIM(object_name) AS object, RTRIM(counter_name) AS counter, RTRIM(instance_name) AS instance, cntr_value AS value
        FROM sys.dm_os_performance_counters ORDER BY object_name, counter_name, instance_name`).catch(() => []),
      query(`SELECT name, CAST(value AS nvarchar(64)) AS value, CAST(value_in_use AS nvarchar(64)) AS value_in_use,
        CAST(minimum AS nvarchar(64)) AS minimum, CAST(maximum AS nvarchar(64)) AS maximum, is_dynamic, is_advanced, description
        FROM sys.configurations ORDER BY name`)
    ])
    const category = t('admin.variables.categorySystemFunctions')
    const status: Variable[] = serverFunctions.map((f) => [`@@${f}`, valueText(functions?.[f]), category])
    for (const r of counters) {
      // "SQLServer:Buffer Manager", "MSSQL$SQLEXPRESS:Buffer Manager"
      const object = String(r.object).replace(/^[^:]*:/, '')
      status.push([r.instance ? `${valueText(r.counter)} [${valueText(r.instance)}]` : String(r.counter), String(r.value), object])
    }
    const system = options.map((r): Variable => [
      String(r.name),
      valueText(r.value),
      r.is_advanced ? t('admin.variables.categoryAdvanced') : t('admin.variables.categoryBasic'),
      [valueText(r.value_in_use), valueText(r.minimum), valueText(r.maximum), yesNo(r.is_dynamic), yesNo(r.is_advanced), valueText(r.description)]
    ])
    return { status, system }
  },
  async set(name, value) {
    const ws = props.ws
    if (!integer.test(value.trim())) return t('admin.variables.integerValue')
    // RECONFIGURE cannot run inside the transaction IMPLICIT_TRANSACTIONS would open
    if (!ws.autocommit) return t('admin.variables.autocommitOff')
    const [option] = await ws.query(
      `SELECT c.is_dynamic, c.is_advanced, (SELECT CAST(value_in_use AS int) FROM sys.configurations WHERE name = 'show advanced options') AS show_advanced
       FROM sys.configurations c WHERE c.name = @p1`,
      [name]
    )
    const configure = (option: string, v: string): string[] => [`EXEC sp_configure ${ws.dialect.quoteString(option)}, ${v}`, 'RECONFIGURE']
    // sp_configure sees an advanced option only while 'show advanced options' is on
    const hidden = !!option?.is_advanced && option.show_advanced === 0
    const statements = hidden
      ? [...configure('show advanced options', '1'), ...configure(name, value.trim()), ...configure('show advanced options', '0')]
      : configure(name, value.trim())
    const applied = await reviewAndApply(ws, statements, {
      description: hidden ? t('admin.variables.reviewAdvancedOption', { name }) : t('admin.variables.reviewOption', { name }),
      // a failure halfway would leave the advanced options shown
      cleanup: hidden ? configure('show advanced options', '0') : undefined
    })
    if (!applied) return null
    if (option && !option.is_dynamic) ws.log('info', `sp_configure ${name}`, t('admin.variables.pendingRestart'))
    return ''
  }
}

const sources = { mysql: mysqlSource, postgres: postgresSource, mssql: mssqlSource }
const source = sources[props.ws.config.engine as keyof typeof sources]

const kind = ref<Kind>('status')
const data = ref<Record<Kind, Variable[]>>({ status: [], system: [] })
/** Selected category; '' shows all of them. */
const category = ref('')
const filter = ref('')
const sort = ref<{ col: number; dir: 'asc' | 'desc' } | null>(null)
const grid = ref<InstanceType<typeof DataGrid>>()
const version = ref(0)

async function load(): Promise<void> {
  try {
    data.value = await source.load()
  } catch (e) {
    await alertError(t('admin.variables.loadFailed'), (e as Error).message)
  }
  version.value++
}

onMounted(load)

const categories = computed(() => {
  const counts = new Map<string, number>()
  for (const [, , c] of data.value[kind.value]) counts.set(c, (counts.get(c) ?? 0) + 1)
  const rank = (c: string): number => (c === otherCategory ? Infinity : source.categoryOrder.indexOf(c) + 1 || source.categoryOrder.length + 1)
  const names = [...counts.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  return [
    { name: '', label: t('admin.variables.all'), count: data.value[kind.value].length },
    ...names.map((name) => ({ name, label: name, count: counts.get(name)! }))
  ]
})

const activeCategory = computed(() => (categories.value.some((c) => c.name === category.value) ? category.value : ''))

const view = computed<Variable[]>(() => {
  const f = filter.value.trim().toLowerCase()
  let rows = data.value[kind.value].filter(
    ([name, value, c]) =>
      (!activeCategory.value || c === activeCategory.value) && (!f || name.toLowerCase().includes(f) || value.toLowerCase().includes(f))
  )
  const s = sort.value
  if (s) {
    const dir = s.dir === 'asc' ? 1 : -1
    rows = [...rows].sort((a, b) => {
      const [x, y] = [field(a, s.col), field(b, s.col)]
      const numeric = x !== '' && y !== '' && !isNaN(Number(x)) && !isNaN(Number(y))
      return (numeric ? Number(x) - Number(y) : x.localeCompare(y)) * dir
    })
  }
  return rows
})

const columns = computed<GridColumn[]>(() => {
  const extra = kind.value === 'system' ? (source.systemColumns ?? []) : []
  return [
    { name: t('admin.variables.name'), width: 300 },
    { name: t('admin.variables.value'), width: extra.length ? 140 : 420 },
    ...extra.map((name, i) => ({ name, width: i === extra.length - 1 ? 420 : 110 }))
  ]
})

/** Text of a grid column: name, value, then the extra columns. */
const field = (v: Variable, col: number): string => (col === 0 ? v[0] : col === 1 ? v[1] : (v[3]?.[col - 2] ?? ''))

const cell = (r: number, c: number): GridCell => ({ text: field(view.value[r], c) })

function onSort(col: number): void {
  const s = sort.value
  sort.value = !s || s.col !== col ? { col, dir: 'asc' } : s.dir === 'asc' ? { col, dir: 'desc' } : null
}

// --- editing ----------------------------------------------------------------------------

async function edit(r: number): Promise<void> {
  if (kind.value !== 'system') return
  const [name, value] = view.value[r]
  const next = await promptText(source.promptTitle, name, value)
  if (next === undefined || next === value) return
  const error = await source.set(name, next)
  if (error) await alertError(t('admin.variables.setFailed', { name }), error)
  else if (error === '') await load()
}

// --- copy -------------------------------------------------------------------------------

const lines = (rows: Variable[]): string => rows.map(([n, v]) => `${n}\t${v}`).join('\n')

function copyAll(): void {
  void navigator.clipboard.writeText(`${source.titles.status}\n${lines(data.value.status)}\n\n${source.titles.system}\n${lines(data.value.system)}\n`)
}

function copySelected(): void {
  const rows = (grid.value?.selectedRows() ?? []).map((r) => view.value[r])
  if (rows.length) void navigator.clipboard.writeText(lines(rows))
}

function setKind(k: Kind): void {
  kind.value = k
  sort.value = null
  grid.value?.scrollToTop()
}
</script>

<template>
  <div class="page">
    <div class="tabbar">
      <div class="tab" :class="{ active: kind === 'status' }" @mousedown="setKind('status')">{{ source.tabs.status }}</div>
      <div class="tab" :class="{ active: kind === 'system' }" @mousedown="setKind('system')">{{ source.tabs.system }}</div>
    </div>
    <div class="toolbar">
      <input v-model="filter" type="search" :placeholder="t('admin.variables.search')" class="search" />
      <span v-if="kind === 'system'" class="muted hint">{{ source.editHint }}</span>
      <span class="spacer" />
      <button class="icon-btn" :title="t('admin.variables.copySelected')" @click="copySelected"><Copy :size="14" /></button>
      <button class="icon-btn" :title="source.copyAllTitle" @click="copyAll"><ClipboardCopy :size="14" /></button>
      <button class="icon-btn" :title="t('admin.refresh')" @click="load"><RefreshCw :size="14" /></button>
    </div>
    <div class="body">
      <div class="categories">
        <div
          v-for="c in categories"
          :key="c.name"
          class="category"
          :class="{ selected: c.name === activeCategory }"
          @click="category = c.name"
        >
          <span>{{ c.label }}</span>
          <span class="muted">{{ c.count }}</span>
        </div>
      </div>
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
          @activate="edit"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.toolbar {
  gap: 8px;
}

.search {
  width: 240px;
}

.hint {
  font-size: var(--fs-small);
}

.body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 190px 1fr;
}

.categories {
  overflow: auto;
  border-right: 1px solid var(--border);
  background: var(--bg-panel);
  padding: 4px 0;
}

.category {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 3px 10px;
}

.category:hover {
  background: var(--bg-hover);
}

.category.selected {
  background: var(--bg-selected);
}

.list {
  min-width: 0;
  min-height: 0;
}
</style>
