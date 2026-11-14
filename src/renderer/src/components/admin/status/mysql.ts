import { computed, reactive, ref } from 'vue'
import type { Workspace } from '@/workspace/workspace'
import { formatBytes } from '@/workspace/format'
import { formatLocale, t } from '@/i18n'
import { fetchGlobals } from '../admin'
import { available, bytesPerSecond, count, percent, perSecond, push, rates, uptimeText, type Feature, type InfoRow, type StatusModel } from './common'

const statusNames = [
  'Uptime',
  'Threads_connected',
  'Threads_running',
  'Bytes_received',
  'Bytes_sent',
  'Questions',
  'Com_select',
  'Innodb_buffer_pool_pages_total',
  'Innodb_buffer_pool_pages_free',
  'Innodb_data_reads',
  'Innodb_data_writes',
  'Key_reads',
  'Key_read_requests',
  'Current_tls_cert'
]

/** Server Status of MySQL and MariaDB: global variables, plugins and global status. */
export function useMysqlStatus(ws: Workspace): StatusModel {
  const vars = ref<Record<string, string>>({})
  /** Plugins by lower case name. */
  const plugins = ref<Record<string, { status: string; type: string }>>({})
  const status = ref<Record<string, string>>({})
  const error = ref('')

  const history = reactive({
    connections: [] as (number | null)[],
    running: [] as (number | null)[],
    netIn: [] as (number | null)[],
    netOut: [] as (number | null)[],
    questions: [] as (number | null)[],
    selects: [] as (number | null)[],
    bufferPool: [] as (number | null)[],
    reads: [] as (number | null)[],
    writes: [] as (number | null)[],
    keyEfficiency: [] as (number | null)[]
  })

  const nextRates = rates()

  async function sample(): Promise<void> {
    let values: Record<string, string>
    try {
      values = await fetchGlobals(ws, 'STATUS', statusNames)
    } catch (e) {
      error.value = (e as Error).message
      return
    }
    const num = (name: string): number | null => (name in values ? Number(values[name]) : null)
    const rate = nextRates(values)
    const total = num('Innodb_buffer_pool_pages_total')
    const free = num('Innodb_buffer_pool_pages_free')
    const keyRequests = num('Key_read_requests')
    push(history.connections, num('Threads_connected'))
    push(history.running, num('Threads_running'))
    push(history.netIn, rate('Bytes_received'))
    push(history.netOut, rate('Bytes_sent'))
    push(history.questions, rate('Questions'))
    push(history.selects, rate('Com_select'))
    push(history.bufferPool, total && free !== null ? ((total - free) / total) * 100 : null)
    push(history.reads, rate('Innodb_data_reads'))
    push(history.writes, rate('Innodb_data_writes'))
    push(history.keyEfficiency, keyRequests ? 100 - (num('Key_reads')! / keyRequests) * 100 : null)
    status.value = values
  }

  async function loadInfo(): Promise<void> {
    error.value = ''
    try {
      vars.value = await fetchGlobals(ws, 'VARIABLES')
    } catch (e) {
      error.value = (e as Error).message
    }
    const r = await window.api.db.query(ws.sessionId, 'SELECT PLUGIN_NAME, PLUGIN_STATUS, PLUGIN_TYPE FROM information_schema.PLUGINS')
    plugins.value = Object.fromEntries(
      r.rows.map((row) => [String(row.PLUGIN_NAME).toLowerCase(), { status: String(row.PLUGIN_STATUS), type: String(row.PLUGIN_TYPE) }])
    )
    await sample()
  }

  // --- info sections ---------------------------------------------------------------

  const v = (name: string): string | undefined => vars.value[name]
  const isOn = (name: string): boolean => v(name) === 'ON'
  const pluginActive = (name: string): boolean => plugins.value[name]?.status === 'ACTIVE'
  const onOff = (name: string, file?: string): string => (v(name) === undefined ? '' : `${v(name)}${file && v(file) ? ` (${v(file)})` : ''}`)

  const serverRows = computed<InfoRow[]>(() => {
    const uptime = Number(status.value.Uptime)
    return available([
      [t('admin.status.host'), v('hostname') ?? ''],
      [t('admin.status.socket'), v('socket') ?? ''],
      [t('admin.status.port'), v('port') ?? ''],
      [t('admin.status.version'), [v('version'), v('version_comment')].filter(Boolean).join(' — ')],
      [t('admin.status.compiledFor'), [v('version_compile_os'), v('version_compile_machine') && `(${v('version_compile_machine')})`].filter(Boolean).join(' ')],
      [t('admin.status.serverId'), v('server_id') ?? ''],
      [
        t('admin.status.runningSince'),
        Number.isFinite(uptime) && status.value.Uptime
          ? `${new Date(Date.now() - uptime * 1000).toLocaleString(formatLocale())} (${uptimeText(uptime)})`
          : ''
      ]
    ])
  })

  const sslAvailable = computed(() => v('have_ssl') === 'YES' || !!v('ssl_cert') || !!status.value.Current_tls_cert)

  const features = computed<Feature[]>(() => {
    const semiSource = v('rpl_semi_sync_source_enabled') ?? v('rpl_semi_sync_master_enabled')
    const semiReplica = v('rpl_semi_sync_replica_enabled') ?? v('rpl_semi_sync_slave_enabled')
    const semiDetail = [semiSource === 'ON' && t('admin.status.semiSyncSource'), semiReplica === 'ON' && t('admin.status.semiSyncReplica')].filter(Boolean).join(', ')
    return [
      { label: 'Performance Schema', on: isOn('performance_schema') },
      { label: t('admin.status.threadPool'), on: /pool/i.test(v('thread_handling') ?? '') || pluginActive('thread_pool'), detail: v('thread_handling') },
      { label: t('admin.status.sslAvailability'), on: sslAvailable.value },
      {
        label: t('admin.status.semiSyncReplication'),
        on: !!semiDetail,
        detail: semiSource === undefined && semiReplica === undefined ? t('admin.status.pluginNotInstalled') : semiDetail || undefined
      },
      { label: t('admin.status.binaryLog'), on: isOn('log_bin'), detail: isOn('log_bin') ? v('binlog_format') : undefined },
      ws.info?.isMariaDB
        ? { label: 'GTID', on: true, detail: v('gtid_current_pos') || undefined }
        : { label: t('admin.status.gtidMode'), on: (v('gtid_mode') ?? '').startsWith('ON'), detail: /_/.test(v('gtid_mode') ?? '') ? v('gtid_mode') : undefined },
      { label: t('admin.status.firewall'), on: pluginActive('mysql_firewall') },
      { label: t('admin.status.auditLog'), on: pluginActive('audit_log') || pluginActive('server_audit') },
      {
        label: t('admin.status.passwordValidation'),
        on:
          Object.keys(vars.value).some((k) => k.startsWith('validate_password')) ||
          pluginActive('simple_password_check') ||
          pluginActive('cracklib_password_check')
      },
      {
        label: 'InnoDB',
        on: pluginActive('innodb'),
        detail: v('innodb_buffer_pool_size') ? t('admin.status.bufferPoolSize', { size: formatBytes(Number(v('innodb_buffer_pool_size'))) }) : undefined
      }
    ]
  })

  const directoryRows = computed<InfoRow[]>(() =>
    available([
      [t('admin.status.baseDirectory'), v('basedir') ?? ''],
      [t('admin.status.dataDirectory'), v('datadir') ?? ''],
      [t('admin.status.pluginsDirectory'), v('plugin_dir') ?? ''],
      [t('admin.status.tmpDirectory'), v('tmpdir') ?? ''],
      [t('admin.status.secureFilePriv'), v('secure_file_priv') ?? ''],
      [t('admin.status.errorLog'), v('log_error') === undefined ? '' : v('log_error') || t('admin.status.defaultValue')],
      [t('admin.status.generalLog'), onOff('general_log', 'general_log_file')],
      [t('admin.status.slowQueryLog'), onOff('slow_query_log', 'slow_query_log_file')],
      [t('admin.status.logOutput'), v('log_output') ?? '']
    ])
  )

  const sslRows = computed<InfoRow[]>(() =>
    available([
      [t('admin.status.available'), sslAvailable.value ? t('admin.status.yes') : t('admin.status.no')],
      ['CA', v('ssl_ca') ?? ''],
      [t('admin.status.certificate'), v('ssl_cert') || status.value.Current_tls_cert || ''],
      [t('admin.status.key'), v('ssl_key') ?? ''],
      [t('admin.status.cipher'), v('ssl_cipher') ?? ''],
      [t('admin.status.tlsVersions'), v('tls_version') ?? ''],
      [t('admin.status.thisConnection'), ws.info?.ssl || t('admin.status.notEncrypted')]
    ])
  )

  const authRows = computed<InfoRow[]>(() =>
    available([
      [t('admin.status.defaultPlugin'), v('default_authentication_plugin') ?? ''],
      [t('admin.status.authenticationPolicy'), v('authentication_policy') ?? ''],
      [
        t('admin.status.activePlugins'),
        Object.keys(plugins.value)
          .filter((n) => plugins.value[n].type === 'AUTHENTICATION' && pluginActive(n))
          .join(', ')
      ]
    ])
  )

  const sections = computed(() => [
    { title: t('admin.status.sectionServerDirectories'), rows: directoryRows.value },
    { title: 'SSL', rows: sslRows.value },
    { title: t('admin.status.sectionAuthentication'), rows: authRows.value }
  ])

  // --- charts ------------------------------------------------------------------------

  const charts = computed(() => [
    {
      title: t('admin.status.chartConnections'),
      format: count,
      series: [
        { label: t('admin.status.seriesConnected'), color: 'var(--accent)', values: history.connections },
        { label: t('admin.status.seriesRunning'), color: 'var(--success)', values: history.running }
      ]
    },
    {
      title: t('admin.status.chartNetworkTraffic'),
      format: bytesPerSecond,
      series: [
        { label: t('admin.status.seriesIn'), color: 'var(--accent)', values: history.netIn },
        { label: t('admin.status.seriesOut'), color: 'var(--warning)', values: history.netOut }
      ]
    },
    {
      title: t('admin.status.chartQueriesPerSecond'),
      format: perSecond,
      series: [
        { label: t('admin.status.seriesQueries'), color: 'var(--accent)', values: history.questions },
        { label: t('admin.status.seriesSelects'), color: 'var(--success)', values: history.selects }
      ]
    },
    {
      title: t('admin.status.chartBufferPoolUsage'),
      format: percent,
      max: 100,
      series: [{ label: t('admin.status.seriesUsage'), color: 'var(--accent)', values: history.bufferPool }]
    },
    {
      title: t('admin.status.chartDiskReadsWrites'),
      format: perSecond,
      series: [
        { label: t('admin.status.seriesReads'), color: 'var(--accent)', values: history.reads },
        { label: t('admin.status.seriesWrites'), color: 'var(--warning)', values: history.writes }
      ]
    },
    {
      title: t('admin.status.chartKeyEfficiency'),
      format: percent,
      max: 100,
      series: [{ label: t('admin.status.seriesEfficiency'), color: 'var(--success)', values: history.keyEfficiency }]
    }
  ])

  return { error, serverRows, features, sections, charts, loadInfo, sample }
}
