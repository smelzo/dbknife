import { computed, reactive, ref } from 'vue'
import type { Row } from '@shared/types'
import type { Workspace } from '@/workspace/workspace'
import { metadataQuery } from '@/workspace/catalog/mssql'
import { formatBytes } from '@/workspace/format'
import { formatLocale, t } from '@/i18n'
import { available, count, percent, perSecond, push, rates, uptimeText, type Feature, type InfoRow, type StatusModel } from './common'

/**
 * Counters of sys.dm_os_performance_counters, by counter name; the /sec ones
 * are cumulative. object_name starts with "SQLServer:" or "MSSQL$<instance>:".
 */
const countersSql = `SELECT RTRIM(counter_name) AS name, cntr_value AS value FROM sys.dm_os_performance_counters
  WHERE (RTRIM(object_name) LIKE '%:General Statistics' AND counter_name = 'User Connections')
     OR (RTRIM(object_name) LIKE '%:SQL Statistics' AND counter_name IN ('Batch Requests/sec', 'SQL Compilations/sec', 'SQL Re-Compilations/sec'))
     OR (RTRIM(object_name) LIKE '%:Buffer Manager' AND counter_name IN ('Buffer cache hit ratio', 'Buffer cache hit ratio base',
         'Page life expectancy', 'Page reads/sec', 'Page writes/sec'))
     OR (RTRIM(object_name) LIKE '%:Memory Manager' AND counter_name IN ('Total Server Memory (KB)', 'Target Server Memory (KB)'))
     OR (RTRIM(object_name) LIKE '%:Databases' AND instance_name = '_Total' AND counter_name IN ('Transactions/sec', 'Write Transactions/sec'))
  UNION ALL
  SELECT 'Active Requests', COUNT(*) FROM sys.dm_exec_requests r
    JOIN sys.dm_exec_sessions s ON s.session_id = r.session_id WHERE s.is_user_process = 1`

const infoSql = `SELECT @@SERVERNAME AS server_name,
  CAST(SERVERPROPERTY('Edition') AS nvarchar(128)) AS edition,
  CAST(SERVERPROPERTY('ProductLevel') AS nvarchar(128)) AS product_level,
  CAST(SERVERPROPERTY('ProductUpdateLevel') AS nvarchar(128)) AS update_level,
  CAST(SERVERPROPERTY('Collation') AS nvarchar(128)) AS collation,
  CAST(SERVERPROPERTY('IsIntegratedSecurityOnly') AS int) AS windows_only,
  CAST(SERVERPROPERTY('IsFullTextInstalled') AS int) AS is_fulltext,
  CAST(SERVERPROPERTY('IsHadrEnabled') AS int) AS is_hadr,
  CAST(SERVERPROPERTY('IsClustered') AS int) AS is_clustered,
  CAST(SERVERPROPERTY('InstanceDefaultDataPath') AS nvarchar(512)) AS data_path,
  CAST(SERVERPROPERTY('InstanceDefaultLogPath') AS nvarchar(512)) AS log_path,
  CAST(SERVERPROPERTY('ErrorLogFileName') AS nvarchar(512)) AS error_log,
  @@MAX_CONNECTIONS AS max_connections,
  HAS_PERMS_BY_NAME(NULL, NULL, 'VIEW SERVER STATE') AS view_server_state`

/** Server information that needs VIEW SERVER STATE. */
const stateSql = `SELECT DATEDIFF(SECOND, i.sqlserver_start_time, SYSDATETIME()) AS uptime, i.cpu_count, i.physical_memory_kb,
  i.committed_kb, i.committed_target_kb, c.local_net_address AS address, c.local_tcp_port AS port,
  c.auth_scheme, c.net_transport,
  (SELECT TOP (1) status_desc FROM sys.dm_server_services WHERE servicename LIKE 'SQL Server Agent%') AS agent
  FROM sys.dm_os_sys_info i LEFT JOIN sys.dm_exec_connections c ON c.session_id = @@SPID AND c.parent_connection_id IS NULL`

const configNames = [
  'clr enabled',
  'max server memory (MB)',
  'min server memory (MB)',
  'backup compression default',
  'contained database authentication',
  'xp_cmdshell',
  'Database Mail XPs',
  'filestream access level'
]
const configSql = `SELECT name, value_in_use FROM sys.configurations WHERE name IN (${configNames.map((n) => `'${n}'`).join(', ')})`

/** Size of every database's files; NULL where the login may not see sys.master_files. */
const databasesSql = `SELECT d.name, d.state_desc AS state, d.recovery_model_desc AS recovery, SUM(CAST(f.size AS bigint)) * 8192 AS bytes
  FROM sys.databases d LEFT JOIN sys.master_files f ON f.database_id = d.database_id
  GROUP BY d.name, d.state_desc, d.recovery_model_desc ORDER BY d.name`

const text = (row: Row | undefined): Record<string, string> =>
  Object.fromEntries(Object.entries(row ?? {}).map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)]))

const kib = (v: string): string => (v === '' ? '' : formatBytes(Number(v) * 1024))
const seconds = (n: number): string => `${Math.round(n)} s`

/** Server Status of SQL Server: server properties, sys.configurations and the DMVs (VIEW SERVER STATE). */
export function useMssqlStatus(ws: Workspace): StatusModel {
  const query = metadataQuery(ws.query)
  const info = ref<Record<string, string>>({})
  const state = ref<Record<string, string>>({})
  const config = ref<Record<string, string>>({})
  const databases = ref<Record<string, string>[]>([])
  const error = ref('')
  /** The DMVs answer only with VIEW SERVER STATE: without it the charts stay empty. */
  const canViewState = ref(true)

  const history = reactive({
    connections: [] as (number | null)[],
    active: [] as (number | null)[],
    batches: [] as (number | null)[],
    compilations: [] as (number | null)[],
    recompilations: [] as (number | null)[],
    transactions: [] as (number | null)[],
    writeTransactions: [] as (number | null)[],
    cacheHit: [] as (number | null)[],
    pageLife: [] as (number | null)[],
    pageReads: [] as (number | null)[],
    pageWrites: [] as (number | null)[],
    memoryTotal: [] as (number | null)[],
    memoryTarget: [] as (number | null)[]
  })

  const nextRates = rates()

  async function sample(): Promise<void> {
    if (!canViewState.value) return
    let values: Record<string, string>
    try {
      values = Object.fromEntries((await query(countersSql)).map((r) => [String(r.name), String(r.value)]))
    } catch (e) {
      error.value = (e as Error).message
      return
    }
    const num = (name: string): number | null => (name in values ? Number(values[name]) : null)
    const rate = nextRates(values)
    const base = num('Buffer cache hit ratio base')
    const kb = (name: string): number | null => (name in values ? Number(values[name]) * 1024 : null)
    push(history.connections, num('User Connections'))
    push(history.active, num('Active Requests'))
    push(history.batches, rate('Batch Requests/sec'))
    push(history.compilations, rate('SQL Compilations/sec'))
    push(history.recompilations, rate('SQL Re-Compilations/sec'))
    push(history.transactions, rate('Transactions/sec'))
    push(history.writeTransactions, rate('Write Transactions/sec'))
    push(history.cacheHit, base ? (num('Buffer cache hit ratio')! / base) * 100 : null)
    push(history.pageLife, num('Page life expectancy'))
    push(history.pageReads, rate('Page reads/sec'))
    push(history.pageWrites, rate('Page writes/sec'))
    push(history.memoryTotal, kb('Total Server Memory (KB)'))
    push(history.memoryTarget, kb('Target Server Memory (KB)'))
  }

  async function loadInfo(): Promise<void> {
    error.value = ''
    try {
      const [[row], configs, dbs] = await Promise.all([query(infoSql), query(configSql), query(databasesSql)])
      info.value = text(row)
      config.value = Object.fromEntries(configs.map((r) => [String(r.name), String(r.value_in_use)]))
      databases.value = dbs.map(text)
      canViewState.value = info.value.view_server_state === '1'
      if (canViewState.value) state.value = text((await query(stateSql))[0])
      else error.value = t('admin.status.mssqlViewServerState')
    } catch (e) {
      error.value = (e as Error).message
    }
    await sample()
  }

  // --- info sections ---------------------------------------------------------------

  const flag = (v: string): boolean => v !== '' && v !== '0'
  const configMb = (name: string): string => (config.value[name] ? formatBytes(Number(config.value[name]) * 1024 ** 2) : '')

  const serverRows = computed<InfoRow[]>(() => {
    const i = info.value
    const s = state.value
    const uptime = Number(s.uptime)
    const level = [i.product_level, i.update_level].filter(Boolean).join(' ')
    return available([
      [t('admin.status.host'), s.address || ws.config.host],
      [t('admin.status.port'), s.port || String(ws.config.port || 1433)],
      [t('admin.status.serverName'), i.server_name],
      [t('admin.status.version'), ws.info?.version ?? ''],
      [t('admin.status.edition'), i.edition],
      [t('admin.status.productLevel'), level],
      [t('admin.status.collation'), i.collation],
      [
        t('admin.status.authenticationMode'),
        i.windows_only === '' ? '' : i.windows_only === '1' ? t('admin.status.windowsAuthenticationOnly') : t('admin.status.mixedAuthentication')
      ],
      [t('admin.status.runningSince'), s.uptime ? `${new Date(Date.now() - uptime * 1000).toLocaleString(formatLocale())} (${uptimeText(uptime)})` : ''],
      [t('admin.status.processors'), s.cpu_count],
      [t('admin.status.physicalMemory'), kib(s.physical_memory_kb)],
      [t('admin.status.connectionLimit'), i.max_connections]
    ])
  })

  const features = computed<Feature[]>(() => {
    const c = config.value
    const agent = state.value.agent
    return [
      { label: t('admin.status.sqlServerAgent'), on: agent === 'Running', detail: agent || undefined },
      { label: t('admin.status.fullTextSearch'), on: flag(info.value.is_fulltext) },
      { label: t('admin.status.alwaysOn'), on: flag(info.value.is_hadr) },
      { label: t('admin.status.failoverCluster'), on: flag(info.value.is_clustered) },
      { label: t('admin.status.clrIntegration'), on: flag(c['clr enabled']) },
      { label: t('admin.status.containedAuthentication'), on: flag(c['contained database authentication']) },
      { label: t('admin.status.backupCompression'), on: flag(c['backup compression default']) },
      { label: 'FILESTREAM', on: flag(c['filestream access level']), detail: flag(c['filestream access level']) ? t('admin.status.filestreamLevel', { level: String(c['filestream access level']) }) : undefined },
      { label: t('admin.status.databaseMail'), on: flag(c['Database Mail XPs']) },
      { label: 'xp_cmdshell', on: flag(c.xp_cmdshell) }
    ]
  })

  const sections = computed(() => [
    {
      title: t('admin.status.sectionServerFiles'),
      rows: available([
        [t('admin.status.dataDirectory'), info.value.data_path],
        [t('admin.status.transactionLogDirectory'), info.value.log_path],
        [t('admin.status.errorLog'), info.value.error_log]
      ])
    },
    {
      title: t('admin.status.sectionMemory'),
      rows: available([
        [t('admin.status.maxServerMemory'), configMb('max server memory (MB)')],
        [t('admin.status.minServerMemory'), configMb('min server memory (MB)')],
        [t('admin.status.committedMemory'), kib(state.value.committed_kb)],
        [t('admin.status.committedTarget'), kib(state.value.committed_target_kb)]
      ])
    },
    {
      title: t('admin.status.sectionDatabases'),
      rows: databases.value.map((d): InfoRow => [
        d.name,
        [d.bytes ? formatBytes(Number(d.bytes)) : '', d.recovery, d.state === 'ONLINE' ? '' : d.state].filter(Boolean).join(' · ')
      ])
    },
    {
      title: t('admin.status.thisConnection'),
      rows: available([
        [t('admin.status.encryption'), ws.info?.ssl || t('admin.status.notEncrypted')],
        [t('admin.status.authenticationScheme'), state.value.auth_scheme],
        [t('admin.status.transport'), state.value.net_transport]
      ])
    }
  ])

  // --- charts ------------------------------------------------------------------------

  const charts = computed(() => [
    {
      title: t('admin.status.chartConnections'),
      format: count,
      series: [
        { label: t('admin.status.seriesConnected'), color: 'var(--accent)', values: history.connections },
        { label: t('admin.status.seriesActive'), color: 'var(--success)', values: history.active }
      ]
    },
    {
      title: t('admin.status.chartBatchRequests'),
      format: perSecond,
      series: [
        { label: t('admin.status.seriesBatches'), color: 'var(--accent)', values: history.batches },
        { label: t('admin.status.seriesCompilations'), color: 'var(--success)', values: history.compilations },
        { label: t('admin.status.seriesRecompilations'), color: 'var(--warning)', values: history.recompilations }
      ]
    },
    {
      title: t('admin.status.chartTransactionsPerSecond'),
      format: perSecond,
      series: [
        { label: t('admin.status.seriesTransactions'), color: 'var(--accent)', values: history.transactions },
        { label: t('admin.status.seriesWriteTransactions'), color: 'var(--warning)', values: history.writeTransactions }
      ]
    },
    {
      title: t('admin.status.chartCacheHitRatio'),
      format: percent,
      max: 100,
      series: [{ label: t('admin.status.seriesHits'), color: 'var(--success)', values: history.cacheHit }]
    },
    {
      title: t('admin.status.chartPageLifeExpectancy'),
      format: seconds,
      series: [{ label: t('admin.status.seriesSeconds'), color: 'var(--accent)', values: history.pageLife }]
    },
    {
      title: t('admin.status.chartPageReadsWrites'),
      format: perSecond,
      series: [
        { label: t('admin.status.seriesReads'), color: 'var(--accent)', values: history.pageReads },
        { label: t('admin.status.seriesWrites'), color: 'var(--warning)', values: history.pageWrites }
      ]
    },
    {
      title: t('admin.status.chartServerMemory'),
      format: formatBytes,
      series: [
        { label: t('admin.status.seriesTotal'), color: 'var(--accent)', values: history.memoryTotal },
        { label: t('admin.status.seriesTarget'), color: 'var(--text-faint)', values: history.memoryTarget }
      ]
    }
  ])

  return { error, serverRows, features, sections, charts, loadInfo, sample }
}
