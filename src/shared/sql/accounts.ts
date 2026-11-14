// User accounts and privileges: the model edited by the Users and Privileges
// page and the statements that turn one state of an account into another.
import { t, type MessageKey } from '../i18n'
import { significantTokens, tsqlRules } from './lexer'
import { quoteIdentifier, quoteString } from './quote'

export interface AccountLimits {
  maxQueries: number
  maxUpdates: number
  maxConnections: number
  maxUserConnections: number
}

export interface SchemaGrant {
  /** Schema name or LIKE pattern exactly as stored by the server, e.g. `%` or `app\_%`. */
  schema: string
  privileges: string[]
}

export interface Account {
  user: string
  host: string
  plugin: string
  limits: AccountLimits
  /** Global privileges (ON *.*); GRANT OPTION is listed like any other privilege. */
  privileges: string[]
  schemas: SchemaGrant[]
}

/** Authentication plugins that take no password (the OS identity is checked instead). */
export const passwordlessPlugins = new Set(['unix_socket', 'auth_socket'])

interface AdminRole {
  name: string
  readonly description: string
  privileges: string[] | 'all'
}

/** The description is read in the active language each time it is used. */
const adminRole = (name: string, description: MessageKey, privileges: AdminRole['privileges']): AdminRole => ({
  name,
  get description() {
    return t(description)
  },
  privileges
})

/** Administrative roles: shortcuts that toggle sets of global privileges. */
export const adminRoles: AdminRole[] = [
  adminRole('DBA', 'sql.adminRole.dba', 'all'),
  adminRole('MaintenanceAdmin', 'sql.adminRole.maintenanceAdmin', ['EVENT', 'RELOAD', 'SHOW DATABASES', 'SHUTDOWN', 'SUPER']),
  adminRole('ProcessAdmin', 'sql.adminRole.processAdmin', ['RELOAD', 'SUPER']),
  adminRole('UserAdmin', 'sql.adminRole.userAdmin', ['CREATE USER', 'RELOAD']),
  adminRole('SecurityAdmin', 'sql.adminRole.securityAdmin', ['GRANT OPTION', 'CREATE USER', 'PROCESS', 'RELOAD']),
  adminRole('MonitorAdmin', 'sql.adminRole.monitorAdmin', ['PROCESS']),
  adminRole('DBManager', 'sql.adminRole.dbManager', [
    'ALTER', 'ALTER ROUTINE', 'CREATE', 'CREATE ROUTINE', 'CREATE TEMPORARY TABLES', 'CREATE VIEW', 'DELETE', 'DROP',
    'EVENT', 'GRANT OPTION', 'INDEX', 'INSERT', 'LOCK TABLES', 'SELECT', 'SHOW DATABASES', 'SHOW VIEW', 'TRIGGER', 'UPDATE'
  ]),
  adminRole('DBDesigner', 'sql.adminRole.dbDesigner', [
    'ALTER', 'ALTER ROUTINE', 'CREATE', 'CREATE ROUTINE', 'CREATE VIEW', 'INDEX', 'SHOW DATABASES', 'SHOW VIEW', 'TRIGGER'
  ]),
  // BINLOG MONITOR is MariaDB's name for REPLICATION CLIENT
  adminRole('ReplicationAdmin', 'sql.adminRole.replicationAdmin', ['REPLICATION CLIENT', 'BINLOG MONITOR', 'REPLICATION SLAVE', 'SUPER']),
  adminRole('BackupAdmin', 'sql.adminRole.backupAdmin', ['EVENT', 'LOCK TABLES', 'SELECT', 'SHOW DATABASES'])
]

export interface PrivilegeCatalog {
  global: { name: string; comment: string }[]
  schema: string[]
}

/** Privileges grantable ON *.* and ON db.*, from the rows of SHOW PRIVILEGES. */
export function privilegeCatalog(rows: { Privilege: string; Context: string; Comment: string }[]): PrivilegeCatalog {
  const all = rows.map((r) => ({ name: r.Privilege.toUpperCase(), context: r.Context, comment: r.Comment ?? '' }))
  // USAGE means "no privileges"; PROXY is granted ON a user account, not on a level
  const global = all.filter((p) => p.name !== 'USAGE' && p.name !== 'PROXY').map(({ name, comment }) => ({ name, comment }))
  const schema = all.filter((p) => /Databases|Tables|Functions|Procedures/.test(p.context) || p.name === 'EVENT').map((p) => p.name)
  return { global, schema }
}

/**
 * Privilege names of one level from information_schema USER_PRIVILEGES or
 * SCHEMA_PRIVILEGES rows: USAGE is dropped, IS_GRANTABLE becomes GRANT OPTION.
 */
export function collectPrivileges(rows: { privilege: string; grantable: string }[]): string[] {
  const out = new Set<string>()
  for (const r of rows) {
    if (r.privilege !== 'USAGE') out.add(r.privilege)
    if (r.grantable === 'YES') out.add('GRANT OPTION')
  }
  return [...out]
}

/** Account name for statements: 'user'@'host'. */
export const accountName = (user: string, host: string): string => `${quoteString(user)}@${quoteString(host)}`

const limitClauses: [keyof AccountLimits, string][] = [
  ['maxQueries', 'MAX_QUERIES_PER_HOUR'],
  ['maxUpdates', 'MAX_UPDATES_PER_HOUR'],
  ['maxConnections', 'MAX_CONNECTIONS_PER_HOUR'],
  ['maxUserConnections', 'MAX_USER_CONNECTIONS']
]

function identifiedBy(plugin: string, password: string, isMariaDB: boolean): string {
  if (passwordlessPlugins.has(plugin)) return isMariaDB ? `IDENTIFIED VIA ${plugin}` : `IDENTIFIED WITH ${plugin}`
  return isMariaDB
    ? `IDENTIFIED VIA ${plugin} USING PASSWORD(${quoteString(password)})`
    : `IDENTIFIED WITH ${plugin} BY ${quoteString(password)}`
}

/**
 * GRANT/REVOKE statements turning the privileges of one level into `after`.
 * GRANT OPTION is revoked by its own statement, after the other privileges,
 * because of two MySQL 8.4 behaviours:
 * - REVOKE <every static privilege>, GRANT OPTION ON *.* acts as REVOKE ALL
 *   PRIVILEGES, GRANT OPTION and drops the schema-level grants too;
 * - REVOKE GRANT OPTION does not drop the per-privilege grant option of
 *   dynamic privileges (`dynamic`) from the privilege cache, only from
 *   mysql.global_grants: the kept ones are revoked before it and granted again.
 */
function levelChanges(level: string, account: string, before: string[], after: string[], dynamic: (p: string) => boolean): string[] {
  const added = after.filter((p) => !before.includes(p))
  const removed = before.filter((p) => !after.includes(p) && p !== 'GRANT OPTION')
  const revokeGrantOption = before.includes('GRANT OPTION') && !after.includes('GRANT OPTION')
  const out: string[] = []
  let grants = added.filter((p) => p !== 'GRANT OPTION')
  if (revokeGrantOption) {
    const kept = after.filter((p) => dynamic(p) && !added.includes(p))
    removed.push(...kept)
    grants = [...grants, ...kept]
  }
  if (removed.length) out.push(`REVOKE ${removed.join(', ')} ON ${level} FROM ${account}`)
  if (revokeGrantOption) out.push(`REVOKE GRANT OPTION ON ${level} FROM ${account}`)
  if (grants.length || added.includes('GRANT OPTION')) {
    const withGrant = after.includes('GRANT OPTION') ? ' WITH GRANT OPTION' : ''
    out.push(`GRANT ${grants.join(', ') || 'USAGE'} ON ${level} TO ${account}${withGrant}`)
  }
  return out
}

/**
 * Statements that create the account (`before` null) or change it from
 * `before` to `after`. `password` null keeps the current password.
 */
export function accountStatements(
  before: Account | null,
  after: Account,
  password: string | null,
  options: { isMariaDB: boolean }
): string[] {
  const { isMariaDB } = options
  if (!after.user.trim()) throw new Error(t('sql.account.emptyLogin'))
  const account = accountName(after.user, after.host)
  const needsPassword = !passwordlessPlugins.has(after.plugin)
  const out: string[] = []
  if (!before) {
    const limits = limitClauses.filter(([k]) => after.limits[k]).map(([k, clause]) => `${clause} ${after.limits[k]}`)
    out.push(
      `CREATE USER ${account} ${identifiedBy(after.plugin, password ?? '', isMariaDB)}` +
        (limits.length ? ` WITH ${limits.join(' ')}` : '')
    )
  } else {
    if (before.user !== after.user || before.host !== after.host) {
      out.push(`RENAME USER ${accountName(before.user, before.host)} TO ${account}`)
    }
    if (before.plugin !== after.plugin && needsPassword && password === null) {
      throw new Error(t('sql.account.passwordRequired', { plugin: after.plugin }))
    }
    if (before.plugin !== after.plugin || (password !== null && needsPassword)) {
      out.push(`ALTER USER ${account} ${identifiedBy(after.plugin, password ?? '', isMariaDB)}`)
    }
    const limits = limitClauses
      .filter(([k]) => before.limits[k] !== after.limits[k])
      .map(([k, clause]) => `${clause} ${after.limits[k]}`)
    if (limits.length) out.push(`ALTER USER ${account} WITH ${limits.join(' ')}`)
  }

  // MySQL dynamic privileges are named with underscores (BACKUP_ADMIN); static ones never are
  const dynamic = (p: string): boolean => !isMariaDB && p.includes('_')
  out.push(...levelChanges('*.*', account, before?.privileges ?? [], after.privileges, dynamic))
  const old = new Map((before?.schemas ?? []).map((s) => [s.schema, s.privileges]))
  const now = new Map(after.schemas.map((s) => [s.schema, s.privileges]))
  for (const schema of new Set([...old.keys(), ...now.keys()])) {
    out.push(...levelChanges(`${quoteIdentifier(schema)}.*`, account, old.get(schema) ?? [], now.get(schema) ?? [], () => false))
  }
  return out
}

const secretPattern =
  /(\bIDENTIFIED\b[^']*?\b(?:BY|AS|USING)(?:\s+PASSWORD)?\s*|\bPASSWORD\s*\(\s*|\bSET\s+PASSWORD\b.*?=\s*)'(?:[^'\\]|\\.|'')*'/gis

/** PostgreSQL's [ENCRYPTED] PASSWORD '…' of CREATE/ALTER ROLE: a standard string, without backslash escapes. */
const postgresSecretPattern = /(\bPASSWORD\s+)'(?:[^']|'')*'/gi

/** SQL Server's [OLD_]PASSWORD = N'…' of CREATE/ALTER LOGIN, USER and APPLICATION ROLE: a standard string. */
const mssqlSecretPattern = /(\b(?:OLD_)?PASSWORD\s*=\s*N?)'(?:[^']|'')*'/gi

/**
 * Whether `sql` (a T-SQL batch) creates or alters a login, user or application
 * role, the statements taking PASSWORD = '…': elsewhere (WHERE password = '…')
 * the value is data, and a statement rerun from the history would write '****'.
 */
function mssqlAccountStatement(sql: string): boolean {
  const words = significantTokens(sql, tsqlRules).map((t) => (t.type === 'word' ? t.text.toUpperCase() : ''))
  return words.some(
    (w, i) => (w === 'CREATE' || w === 'ALTER') && (words[i + 1] === 'LOGIN' || words[i + 1] === 'USER' || (words[i + 1] === 'APPLICATION' && words[i + 2] === 'ROLE'))
  )
}

/** Masks password literals (IDENTIFIED BY '…', PASSWORD('…'), SET PASSWORD = '…', PASSWORD '…', PASSWORD = N'…') for logs and history. */
export function redactSecrets(sql: string): string {
  const redacted = sql.replace(secretPattern, "$1'****'").replace(postgresSecretPattern, "$1'****'")
  return mssqlAccountStatement(sql) ? redacted.replace(mssqlSecretPattern, "$1'****'") : redacted
}
