// PostgreSQL roles for the Users and Privileges page: attributes, membership
// and the privileges on the current database and its schemas, turned into
// CREATE/ALTER ROLE, GRANT and REVOKE statements.

import { t } from '../i18n'
import { postgresDialect } from './dialect'

const { quoteIdentifier: q, quoteString } = postgresDialect

export interface RoleAttributes {
  login: boolean
  superuser: boolean
  createdb: boolean
  createrole: boolean
  inherit: boolean
  replication: boolean
  bypassrls: boolean
}

export interface Role {
  name: string
  attributes: RoleAttributes
  /** -1: no limit. */
  connectionLimit: number
  /** Password expiry as the server prints it; '' for none. */
  validUntil: string
  memberOf: string[]
  /** Privileges on the session's database: CONNECT, CREATE, TEMPORARY. */
  database: string[]
  /** Privileges on schemas: USAGE, CREATE. */
  schemas: { schema: string; privileges: string[] }[]
}

/** CREATE ROLE keyword of each attribute (the negation prefixes NO). */
export const attributeKeywords: Record<keyof RoleAttributes, string> = {
  login: 'LOGIN',
  superuser: 'SUPERUSER',
  createdb: 'CREATEDB',
  createrole: 'CREATEROLE',
  inherit: 'INHERIT',
  replication: 'REPLICATION',
  bypassrls: 'BYPASSRLS'
}

export const databasePrivileges = ['CONNECT', 'CREATE', 'TEMPORARY']
export const schemaPrivileges = ['USAGE', 'CREATE']

/** Attributes CREATE ROLE gives by default. */
const serverDefaults: RoleAttributes = {
  login: false,
  superuser: false,
  createdb: false,
  createrole: false,
  inherit: true,
  replication: false,
  bypassrls: false
}

/** Attributes of a role added in the editor: a user that can log in. */
export const newRoleAttributes: RoleAttributes = { ...serverDefaults, login: true }

function grants(target: string, role: string, before: string[], after: string[]): string[] {
  const added = after.filter((p) => !before.includes(p))
  const removed = before.filter((p) => !after.includes(p))
  return [
    ...(added.length ? [`GRANT ${added.join(', ')} ON ${target} TO ${q(role)}`] : []),
    ...(removed.length ? [`REVOKE ${removed.join(', ')} ON ${target} FROM ${q(role)}`] : [])
  ]
}

/**
 * Statements turning role `before` (null: a new role) into `after`. A null
 * password keeps the current one; '' removes it.
 */
export function roleStatements(before: Role | null, after: Role, password: string | null, database: string): string[] {
  if (!after.name.trim()) throw new Error(t('sql.role.noName'))
  const role = after.name
  const options: string[] = []
  for (const key of Object.keys(attributeKeywords) as (keyof RoleAttributes)[]) {
    const on = after.attributes[key]
    const was = (before ?? { attributes: serverDefaults }).attributes[key]
    if (on !== was) options.push(`${on ? '' : 'NO'}${attributeKeywords[key]}`)
  }
  if (after.connectionLimit !== (before?.connectionLimit ?? -1)) options.push(`CONNECTION LIMIT ${after.connectionLimit}`)
  if (password !== null) options.push(`PASSWORD ${password ? quoteString(password) : 'NULL'}`)
  if (after.validUntil !== (before?.validUntil ?? '')) options.push(`VALID UNTIL ${quoteString(after.validUntil || 'infinity')}`)

  const out: string[] = []
  if (!before) out.push(`CREATE ROLE ${q(role)}${options.length ? ` WITH ${options.join(' ')}` : ''}`)
  else {
    if (before.name !== role) out.push(`ALTER ROLE ${q(before.name)} RENAME TO ${q(role)}`)
    if (options.length) out.push(`ALTER ROLE ${q(role)} WITH ${options.join(' ')}`)
  }
  const memberOf = before?.memberOf ?? []
  for (const r of after.memberOf.filter((m) => !memberOf.includes(m))) out.push(`GRANT ${q(r)} TO ${q(role)}`)
  for (const r of memberOf.filter((m) => !after.memberOf.includes(m))) out.push(`REVOKE ${q(r)} FROM ${q(role)}`)
  out.push(...grants(`DATABASE ${q(database)}`, role, before?.database ?? [], after.database))
  const old = new Map((before?.schemas ?? []).map((s) => [s.schema, s.privileges]))
  const now = new Map(after.schemas.map((s) => [s.schema, s.privileges]))
  for (const schema of new Set([...old.keys(), ...now.keys()])) {
    out.push(...grants(`SCHEMA ${q(schema)}`, role, old.get(schema) ?? [], now.get(schema) ?? []))
  }
  return out
}
