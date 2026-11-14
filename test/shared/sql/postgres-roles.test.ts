import { describe, expect, it } from 'vitest'
import { newRoleAttributes, roleStatements, type Role } from '@shared/sql/postgres-roles'

const role = (patch: Partial<Role> = {}): Role => ({
  name: 'app',
  attributes: { ...newRoleAttributes },
  connectionLimit: -1,
  validUntil: '',
  memberOf: [],
  database: [],
  schemas: [],
  ...patch
})

describe('roleStatements', () => {
  it('creates a login role with its password, membership and privileges', () => {
    const r = role({ connectionLimit: 5, memberOf: ['pg_read_all_data'], database: ['CONNECT'], schemas: [{ schema: 'Sales', privileges: ['USAGE'] }] })
    expect(roleStatements(null, r, "it's", 'shop')).toEqual([
      `CREATE ROLE "app" WITH LOGIN CONNECTION LIMIT 5 PASSWORD 'it''s'`,
      'GRANT "pg_read_all_data" TO "app"',
      'GRANT CONNECT ON DATABASE "shop" TO "app"',
      'GRANT USAGE ON SCHEMA "Sales" TO "app"'
    ])
  })

  it('renames first and changes only what differs, revoking what was taken away', () => {
    const before = role({ memberOf: ['a', 'b'], database: ['CONNECT', 'TEMPORARY'], schemas: [{ schema: 's', privileges: ['USAGE', 'CREATE'] }] })
    const after = role({
      name: 'app2',
      attributes: { ...newRoleAttributes, login: false, createdb: true },
      validUntil: '2030-01-01',
      memberOf: ['b', 'c'],
      database: ['CONNECT'],
      schemas: [{ schema: 's', privileges: ['USAGE'] }]
    })
    expect(roleStatements(before, after, null, 'shop')).toEqual([
      'ALTER ROLE "app" RENAME TO "app2"',
      `ALTER ROLE "app2" WITH NOLOGIN CREATEDB VALID UNTIL '2030-01-01'`,
      'GRANT "c" TO "app2"',
      'REVOKE "a" FROM "app2"',
      'REVOKE TEMPORARY ON DATABASE "shop" FROM "app2"',
      'REVOKE CREATE ON SCHEMA "s" FROM "app2"'
    ])
  })

  it('has nothing to do for an unchanged role, and removes a password with NULL', () => {
    expect(roleStatements(role(), role(), null, 'shop')).toEqual([])
    expect(roleStatements(role(), role(), '', 'shop')).toEqual(['ALTER ROLE "app" WITH PASSWORD NULL'])
  })
})
