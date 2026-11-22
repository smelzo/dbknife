import { computed, reactive, ref } from 'vue'
import { valueText } from '@shared/value-text'
import type { Workspace } from '@/workspace/workspace'
import { formatBytes } from '@/workspace/format'
import { formatLocale, t } from '@/i18n'
import { available, bytesPerSecond, count, percent, perSecond, push, rates, uptimeText, type Feature, type InfoRow, type StatusModel } from './common'

/** Bytes of pg_settings units; settings in other units are shown as they are. */
const unitBytes: Record<string, number> = { B: 1, kB: 1024, '8kB': 8192, MB: 1024 ** 2, '16MB': 16 * 1024 ** 2 }

/** Counters of the whole server, summed over pg_stat_database, and the client backends. */
const sampleSql = `SELECT
  (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend') AS connections,
  (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend' AND state = 'active') AS active,
  sum(xact_commit) AS commits, sum(xact_rollback) AS rollbacks,
  sum(tup_returned + tup_fetched) AS read, sum(tup_inserted + tup_updated + tup_deleted) AS written,
  sum(blks_hit) AS hits, sum(blks_read) AS disk_reads, sum(temp_bytes) AS temp_bytes
  FROM pg_stat_database`

const infoSql = `SELECT version() AS version,
  floor(extract(epoch FROM now() - pg_postmaster_start_time()))::bigint AS uptime,
  inet_server_addr()::text AS address, inet_server_port() AS port, pg_is_in_recovery() AS standby,
  (SELECT string_agg(extname || ' ' || extversion, ', ' ORDER BY extname) FROM pg_extension) AS extensions`

/** Server Status of PostgreSQL: pg_settings, the server functions and the statistics views. */
export function usePostgresStatus(ws: Workspace): StatusModel {
  const settings = ref<Record<string, { value: string; unit: string }>>({})
  const info = ref<Record<string, string>>({})
  const error = ref('')

  const history = reactive({
    connections: [] as (number | null)[],
    active: [] as (number | null)[],
    commits: [] as (number | null)[],
    rollbacks: [] as (number | null)[],
    read: [] as (number | null)[],
    written: [] as (number | null)[],
    cacheHit: [] as (number | null)[],
    diskReads: [] as (number | null)[],
    tempBytes: [] as (number | null)[]
  })

  const nextRates = rates()

  async function sample(): Promise<void> {
    let values: Record<string, string>
    try {
      const [row] = await ws.query(sampleSql)
      values = Object.fromEntries(Object.entries(row).filter(([, v]) => v !== null).map(([k, v]) => [k, String(v)]))
    } catch (e) {
      error.value = (e as Error).message
      return
    }
    const rate = nextRates(values)
    const hits = Number(values.hits)
    const blocks = hits + Number(values.disk_reads)
    push(history.connections, Number(values.connections))
    push(history.active, Number(values.active))
    push(history.commits, rate('commits'))
    push(history.rollbacks, rate('rollbacks'))
    push(history.read, rate('read'))
    push(history.written, rate('written'))
    push(history.cacheHit, blocks ? (hits / blocks) * 100 : null)
    push(history.diskReads, rate('disk_reads'))
    push(history.tempBytes, rate('temp_bytes'))
  }

  async function loadInfo(): Promise<void> {
    error.value = ''
    try {
      const [rows, [row]] = await Promise.all([ws.query('SELECT name, setting, unit FROM pg_settings'), ws.query(infoSql)])
      settings.value = Object.fromEntries(rows.map((r) => [String(r.name), { value: valueText(r.setting), unit: valueText(r.unit) }]))
      info.value = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, valueText(v)]))
    } catch (e) {
      error.value = (e as Error).message
    }
    await sample()
  }

  // --- info sections ---------------------------------------------------------------

  /** A setting as text; '' when the role may not read it (pg_read_all_settings). */
  const v = (name: string): string => settings.value[name]?.value ?? ''
  const isOn = (name: string): boolean => v(name) === 'on'
  /** A memory setting in bytes as KiB/MiB/GiB. */
  function size(name: string): string {
    const s = settings.value[name]
    if (!s) return ''
    const unit = unitBytes[s.unit]
    return unit && Number(s.value) >= 0 ? formatBytes(Number(s.value) * unit) : `${s.value}${s.unit ? ` ${s.unit}` : ''}`
  }

  const serverRows = computed<InfoRow[]>(() => {
    const uptime = Number(info.value.uptime)
    return available([
      [t('admin.status.host'), info.value.address || ws.config.host || t('admin.status.localSocket')],
      [t('admin.status.port'), info.value.port || v('port')],
      [t('admin.status.version'), info.value.version],
      [t('admin.status.role'), info.value.standby === 'true' ? t('admin.status.standby') : info.value.standby === 'false' ? t('admin.status.primary') : ''],
      [t('admin.status.runningSince'), info.value.uptime ? `${new Date(Date.now() - uptime * 1000).toLocaleString(formatLocale())} (${uptimeText(uptime)})` : ''],
      [t('admin.status.connectionLimit'), v('max_connections')],
      [t('admin.status.extensions'), info.value.extensions]
    ])
  })

  const features = computed<Feature[]>(() => {
    const preload = v('shared_preload_libraries')
    return [
      { label: 'SSL', on: isOn('ssl'), detail: v('ssl_min_protocol_version') ? t('admin.status.sslFrom', { version: v('ssl_min_protocol_version') }) : undefined },
      { label: t('admin.status.walReplication'), on: Number(v('max_wal_senders')) > 0 && v('wal_level') !== 'minimal', detail: v('wal_level') ? `wal_level ${v('wal_level')}` : undefined },
      { label: t('admin.status.walArchiving'), on: v('archive_mode') === 'on' || v('archive_mode') === 'always', detail: v('archive_mode') === 'always' ? 'always' : undefined },
      { label: t('admin.status.synchronousCommit'), on: v('synchronous_commit') !== 'off', detail: v('synchronous_commit') || undefined },
      { label: t('admin.status.dataChecksums'), on: isOn('data_checksums') },
      { label: t('admin.status.autovacuum'), on: isOn('autovacuum') },
      { label: t('admin.status.loggingCollector'), on: isOn('logging_collector') },
      { label: t('admin.status.jitCompilation'), on: isOn('jit') },
      { label: 'pg_stat_statements', on: /\bpg_stat_statements\b/.test(preload) },
      { label: t('admin.status.ioTiming'), on: isOn('track_io_timing') }
    ]
  })

  const sections = computed(() => [
    {
      title: t('admin.status.sectionServerFiles'),
      rows: available([
        [t('admin.status.dataDirectory'), v('data_directory')],
        [t('admin.status.configuration'), v('config_file')],
        [t('admin.status.clientAuthentication'), v('hba_file')],
        [t('admin.status.socketDirectories'), v('unix_socket_directories')],
        [t('admin.status.logDirectory'), isOn('logging_collector') ? v('log_directory') : ''],
        [t('admin.status.logDestination'), v('log_destination')]
      ])
    },
    {
      title: t('admin.status.sectionMemory'),
      rows: available([
        [t('admin.status.sharedBuffers'), size('shared_buffers')],
        [t('admin.status.workMemory'), size('work_mem')],
        [t('admin.status.maintenanceMemory'), size('maintenance_work_mem')],
        [t('admin.status.effectiveCache'), size('effective_cache_size')],
        [t('admin.status.maxWalSize'), size('max_wal_size')]
      ])
    },
    {
      title: 'SSL',
      rows: available([
        [t('admin.status.enabled'), settings.value.ssl ? (isOn('ssl') ? t('admin.status.yes') : t('admin.status.no')) : ''],
        ['CA', v('ssl_ca_file')],
        [t('admin.status.certificate'), v('ssl_cert_file')],
        [t('admin.status.key'), v('ssl_key_file')],
        [t('admin.status.tlsVersions'), [v('ssl_min_protocol_version'), v('ssl_max_protocol_version')].filter(Boolean).join(' – ')],
        [t('admin.status.thisConnection'), ws.info?.ssl || t('admin.status.notEncrypted')]
      ])
    },
    {
      title: t('admin.status.sectionAuthentication'),
      rows: available([
        [t('admin.status.passwordEncryption'), v('password_encryption')],
        [t('admin.status.authenticationTimeout'), v('authentication_timeout') ? `${v('authentication_timeout')} s` : '']
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
      title: t('admin.status.chartTransactionsPerSecond'),
      format: perSecond,
      series: [
        { label: t('admin.status.seriesCommits'), color: 'var(--accent)', values: history.commits },
        { label: t('admin.status.seriesRollbacks'), color: 'var(--warning)', values: history.rollbacks }
      ]
    },
    {
      title: t('admin.status.chartRowsPerSecond'),
      format: perSecond,
      series: [
        { label: t('admin.status.seriesRead'), color: 'var(--accent)', values: history.read },
        { label: t('admin.status.seriesWritten'), color: 'var(--warning)', values: history.written }
      ]
    },
    {
      title: t('admin.status.chartCacheHitRatio'),
      format: percent,
      max: 100,
      series: [{ label: t('admin.status.seriesHits'), color: 'var(--success)', values: history.cacheHit }]
    },
    {
      title: t('admin.status.chartDiskBlockReads'),
      format: perSecond,
      series: [{ label: t('admin.status.seriesBlocks'), color: 'var(--accent)', values: history.diskReads }]
    },
    {
      title: t('admin.status.chartTemporaryFiles'),
      format: bytesPerSecond,
      series: [{ label: t('admin.status.seriesWritten'), color: 'var(--warning)', values: history.tempBytes }]
    }
  ])

  return { error, serverRows, features, sections, charts, loadInfo, sample }
}
