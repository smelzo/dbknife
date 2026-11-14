// SQL Server principals for the Users and Privileges page: server logins and
// their server roles, the user of the session's database (mapped to a login
// or without one) with its roles and its permissions on the database and its
// schemas, turned into CREATE/ALTER LOGIN, CREATE/ALTER USER, ALTER ROLE,
// GRANT, DENY and REVOKE statements.

import { t } from '../i18n'
import { mssqlDialect } from './dialect'

const { quoteIdentifier: q, quoteString } = mssqlDialect

export interface Login {
  name: string
  /** Windows login or group (DOMAIN\name, FROM WINDOWS): no password nor policy. */
  windows: boolean
  defaultDatabase: string
  /** '' (new logins only): the server's default language. */
  defaultLanguage: string
  disabled: boolean
  /** CHECK_POLICY: the Windows password policy applies (SQL logins). */
  checkPolicy: boolean
  /** CHECK_EXPIRATION: the password expires (SQL logins, with checkPolicy). */
  checkExpiration: boolean
  serverRoles: string[]
}

/** sys.database_permissions.state_desc; a permission absent from the map is neither granted nor denied. */
export type PermissionState = 'GRANT' | 'GRANT_WITH_GRANT_OPTION' | 'DENY'
export type Permissions = Record<string, PermissionState>

export interface DatabaseUser {
  name: string
  /** '' for none (dbo). */
  defaultSchema: string
  roles: string[]
  /** Permissions on the database itself (GRANT CREATE TABLE TO …). */
  database: Permissions
  schemas: { schema: string; permissions: Permissions }[]
}

export const databasePermissions = [
  'CONNECT',
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'EXECUTE',
  'VIEW DEFINITION',
  'SHOWPLAN',
  'CREATE TABLE',
  'CREATE VIEW',
  'CREATE PROCEDURE',
  'CREATE FUNCTION',
  'CREATE SCHEMA',
  'ALTER',
  'CONTROL'
]
export const schemaPermissions = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'EXECUTE', 'REFERENCES', 'VIEW DEFINITION', 'ALTER', 'CONTROL']

/** Options CREATE LOGIN gives by default. */
const loginDefaults: Login = {
  name: '',
  windows: false,
  defaultDatabase: 'master',
  defaultLanguage: '',
  disabled: false,
  checkPolicy: true,
  checkExpiration: false,
  serverRoles: []
}

/** Permissions CREATE USER grants by itself. */
const userDefaults: Pick<DatabaseUser, 'database'> = { database: { CONNECT: 'GRANT' } }

export const newLogin = (): Login => ({ ...loginDefaults, serverRoles: [] })

export const newUser = (name: string): DatabaseUser => ({ name, defaultSchema: 'dbo', roles: [], database: { ...userDefaults.database }, schemas: [] })

const onOff = (on: boolean): string => (on ? 'ON' : 'OFF')

/**
 * Statements turning login `before` (null: a new login) into `after`. A null
 * password keeps the current one; a new SQL login needs one.
 */
export function loginStatements(before: Login | null, after: Login, password: string | null): string[] {
  if (!after.name.trim()) throw new Error(t('sql.login.noName'))
  const login = q(after.name)
  const was = before ?? loginDefaults
  const options: string[] = []
  if (after.defaultDatabase !== was.defaultDatabase) options.push(`DEFAULT_DATABASE = ${q(after.defaultDatabase)}`)
  if (after.defaultLanguage && after.defaultLanguage !== was.defaultLanguage) options.push(`DEFAULT_LANGUAGE = ${q(after.defaultLanguage)}`)
  if (!after.windows) {
    if (after.checkPolicy !== was.checkPolicy) options.push(`CHECK_POLICY = ${onOff(after.checkPolicy)}`)
    if (after.checkExpiration !== was.checkExpiration) options.push(`CHECK_EXPIRATION = ${onOff(after.checkExpiration)}`)
  }

  const out: string[] = []
  if (!before) {
    if (after.windows) out.push(`CREATE LOGIN ${login} FROM WINDOWS${options.length ? ` WITH ${options.join(', ')}` : ''}`)
    else {
      if (password === null) throw new Error(t('sql.login.passwordRequired'))
      out.push(`CREATE LOGIN ${login} WITH ${[`PASSWORD = ${quoteString(password)}`, ...options].join(', ')}`)
    }
  } else {
    if (before.name !== after.name) out.push(`ALTER LOGIN ${q(before.name)} WITH NAME = ${login}`)
    if (password !== null && !after.windows) out.push(`ALTER LOGIN ${login} WITH PASSWORD = ${quoteString(password)}`)
    if (options.length) out.push(`ALTER LOGIN ${login} WITH ${options.join(', ')}`)
  }
  if (after.disabled !== was.disabled) out.push(`ALTER LOGIN ${login} ${after.disabled ? 'DISABLE' : 'ENABLE'}`)
  for (const r of after.serverRoles.filter((r) => !was.serverRoles.includes(r))) out.push(`ALTER SERVER ROLE ${q(r)} ADD MEMBER ${login}`)
  for (const r of was.serverRoles.filter((r) => !after.serverRoles.includes(r))) out.push(`ALTER SERVER ROLE ${q(r)} DROP MEMBER ${login}`)
  return out
}

/**
 * GRANT/DENY/REVOKE statements turning the permissions `before` of `user` on
 * `on` (an ON clause, '' for the database) into `after`, one statement per
 * kind of change. Taking a grant option away (REVOKE, DENY, REVOKE GRANT
 * OPTION) needs CASCADE.
 */
function permissionStatements(on: string, user: string, before: Permissions, after: Permissions): string[] {
  const statements = new Map<string, string[]>()
  for (const permission of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const was = before[permission]
    const now = after[permission]
    if (was === now) continue
    const cascade = was === 'GRANT_WITH_GRANT_OPTION' ? ' CASCADE' : ''
    const template = !now
      ? `REVOKE %${on} FROM ${user}${cascade}`
      : now === 'DENY'
        ? `DENY %${on} TO ${user}${cascade}`
        : now === 'GRANT_WITH_GRANT_OPTION'
          ? `GRANT %${on} TO ${user} WITH GRANT OPTION`
          : was === 'GRANT_WITH_GRANT_OPTION'
            ? `REVOKE GRANT OPTION FOR %${on} FROM ${user} CASCADE`
            : `GRANT %${on} TO ${user}`
    statements.set(template, [...(statements.get(template) ?? []), permission])
  }
  return [...statements].map(([template, permissions]) => template.replace('%', permissions.join(', ')))
}

/**
 * Statements turning the database user `before` (null: none) into `after`
 * (null: dropped). `login` maps a new user to that login; null creates it
 * WITHOUT LOGIN.
 */
export function userStatements(before: DatabaseUser | null, after: DatabaseUser | null, login: string | null): string[] {
  if (!after) return before ? [`DROP USER ${q(before.name)}`] : []
  if (!after.name.trim()) throw new Error(t('sql.login.noUserName'))
  const user = q(after.name)
  const out: string[] = []
  if (!before) {
    const schema = after.defaultSchema ? ` WITH DEFAULT_SCHEMA = ${q(after.defaultSchema)}` : ''
    out.push(`CREATE USER ${user} ${login === null ? 'WITHOUT LOGIN' : `FOR LOGIN ${q(login)}`}${schema}`)
  } else {
    const options: string[] = []
    if (before.name !== after.name) options.push(`NAME = ${user}`)
    if (before.defaultSchema !== after.defaultSchema) options.push(`DEFAULT_SCHEMA = ${after.defaultSchema ? q(after.defaultSchema) : 'NULL'}`)
    if (options.length) out.push(`ALTER USER ${q(before.name)} WITH ${options.join(', ')}`)
  }
  const roles = before?.roles ?? []
  for (const r of after.roles.filter((r) => !roles.includes(r))) out.push(`ALTER ROLE ${q(r)} ADD MEMBER ${user}`)
  for (const r of roles.filter((r) => !after.roles.includes(r))) out.push(`ALTER ROLE ${q(r)} DROP MEMBER ${user}`)
  out.push(...permissionStatements('', user, (before ?? userDefaults).database, after.database))
  const old = new Map((before?.schemas ?? []).map((s) => [s.schema, s.permissions]))
  const now = new Map(after.schemas.map((s) => [s.schema, s.permissions]))
  for (const schema of new Set([...old.keys(), ...now.keys()])) {
    out.push(...permissionStatements(` ON SCHEMA::${q(schema)}`, user, old.get(schema) ?? {}, now.get(schema) ?? {}))
  }
  return out
}
