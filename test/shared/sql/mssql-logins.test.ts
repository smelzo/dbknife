import { describe, expect, it } from 'vitest'
import { loginStatements, newLogin, newUser, userStatements, type DatabaseUser, type Login } from '@shared/sql/mssql-logins'

const login = (patch: Partial<Login> = {}): Login => ({ ...newLogin(), name: 'app', ...patch })
const user = (patch: Partial<DatabaseUser> = {}): DatabaseUser => ({ ...newUser('app'), ...patch })

describe('loginStatements', () => {
  it('creates a SQL login with the password as first option, then its state and server roles', () => {
    const l = login({ defaultDatabase: 'shop', checkPolicy: false, disabled: true, serverRoles: ['dbcreator'] })
    expect(loginStatements(null, l, "it's")).toEqual([
      "CREATE LOGIN [app] WITH PASSWORD = N'it''s', DEFAULT_DATABASE = [shop], CHECK_POLICY = OFF",
      'ALTER LOGIN [app] DISABLE',
      'ALTER SERVER ROLE [dbcreator] ADD MEMBER [app]'
    ])
    expect(() => loginStatements(null, l, null)).toThrow()
  })

  it('creates a Windows login without password or policy options', () => {
    expect(loginStatements(null, login({ name: 'DOM\\bob', windows: true, checkPolicy: false }), null)).toEqual(['CREATE LOGIN [DOM\\bob] FROM WINDOWS'])
  })

  it('renames first and changes only what differs under the new name', () => {
    const before = login({ defaultLanguage: 'Italiano', serverRoles: ['bulkadmin', 'dbcreator'] })
    const after = login({ name: 'app2', defaultLanguage: 'us_english', checkExpiration: true, serverRoles: ['dbcreator', 'setupadmin'] })
    expect(loginStatements(before, after, 'pw')).toEqual([
      'ALTER LOGIN [app] WITH NAME = [app2]',
      "ALTER LOGIN [app2] WITH PASSWORD = N'pw'",
      'ALTER LOGIN [app2] WITH DEFAULT_LANGUAGE = [us_english], CHECK_EXPIRATION = ON',
      'ALTER SERVER ROLE [setupadmin] ADD MEMBER [app2]',
      'ALTER SERVER ROLE [bulkadmin] DROP MEMBER [app2]'
    ])
    expect(loginStatements(before, before, null)).toEqual([])
  })
})

describe('userStatements', () => {
  it('maps a new user to its login without granting CONNECT again, or creates it without login', () => {
    const u = user({ roles: ['db_datareader'], schemas: [{ schema: 'sales', permissions: { SELECT: 'GRANT', EXECUTE: 'GRANT' } }] })
    expect(userStatements(null, u, 'app')).toEqual([
      'CREATE USER [app] FOR LOGIN [app] WITH DEFAULT_SCHEMA = [dbo]',
      'ALTER ROLE [db_datareader] ADD MEMBER [app]',
      'GRANT SELECT, EXECUTE ON SCHEMA::[sales] TO [app]'
    ])
    expect(userStatements(null, user({ defaultSchema: '' }), null)).toEqual(['CREATE USER [app] WITHOUT LOGIN'])
  })

  it('needs CASCADE wherever a grant option is taken away', () => {
    const before = user({
      database: { CONNECT: 'GRANT', 'CREATE TABLE': 'GRANT_WITH_GRANT_OPTION', 'CREATE VIEW': 'DENY' },
      schemas: [{ schema: 'dbo', permissions: { SELECT: 'GRANT_WITH_GRANT_OPTION', INSERT: 'GRANT_WITH_GRANT_OPTION', UPDATE: 'GRANT' } }]
    })
    const after = user({
      database: { CONNECT: 'GRANT', 'CREATE VIEW': 'GRANT', ALTER: 'GRANT_WITH_GRANT_OPTION' },
      schemas: [{ schema: 'dbo', permissions: { SELECT: 'GRANT', INSERT: 'DENY', DELETE: 'DENY' } }]
    })
    expect(userStatements(before, after, null)).toEqual([
      'REVOKE CREATE TABLE FROM [app] CASCADE',
      'GRANT CREATE VIEW TO [app]',
      'GRANT ALTER TO [app] WITH GRANT OPTION',
      'REVOKE GRANT OPTION FOR SELECT ON SCHEMA::[dbo] FROM [app] CASCADE',
      'DENY INSERT ON SCHEMA::[dbo] TO [app] CASCADE',
      'REVOKE UPDATE ON SCHEMA::[dbo] FROM [app]',
      'DENY DELETE ON SCHEMA::[dbo] TO [app]'
    ])
  })

  it('renames and changes the default schema in one ALTER USER, then works on the new name; null drops the user', () => {
    const before = user({ roles: ['db_owner'] })
    expect(userStatements(before, user({ name: 'app2', defaultSchema: 'sales' }), 'app')).toEqual([
      'ALTER USER [app] WITH NAME = [app2], DEFAULT_SCHEMA = [sales]',
      'ALTER ROLE [db_owner] DROP MEMBER [app2]'
    ])
    expect(userStatements(before, null, 'app')).toEqual(['DROP USER [app]'])
  })
})
