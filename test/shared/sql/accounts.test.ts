import { describe, expect, it } from 'vitest'
import { t } from '@shared/i18n'
import { accountStatements, collectPrivileges, redactSecrets, type Account } from '@shared/sql/accounts'

const account = (patch: Partial<Account> = {}): Account => ({
  user: 'app',
  host: '%',
  plugin: 'caching_sha2_password',
  limits: { maxQueries: 0, maxUpdates: 0, maxConnections: 0, maxUserConnections: 0 },
  privileges: [],
  schemas: [],
  ...patch
})
const mysql = { isMariaDB: false }

describe('redactSecrets', () => {
  it('masks password literals of MySQL and MariaDB syntaxes, keeping account names', () => {
    expect(redactSecrets("ALTER USER 'bob'@'%' IDENTIFIED WITH caching_sha2_password BY 'p\\'w'")).toBe(
      "ALTER USER 'bob'@'%' IDENTIFIED WITH caching_sha2_password BY '****'"
    )
    expect(redactSecrets("CREATE USER 'a'@'h' IDENTIFIED VIA ed25519 USING PASSWORD('x''y') WITH MAX_USER_CONNECTIONS 2")).toBe(
      "CREATE USER 'a'@'h' IDENTIFIED VIA ed25519 USING PASSWORD('****') WITH MAX_USER_CONNECTIONS 2"
    )
    expect(redactSecrets("SET PASSWORD FOR 'u'@'h' = 'secret'")).toBe("SET PASSWORD FOR 'u'@'h' = '****'")
  })

  it('masks PostgreSQL role passwords, whose literals have no backslash escapes', () => {
    expect(redactSecrets(`CREATE ROLE "r" WITH LOGIN PASSWORD 'a\\' VALID UNTIL 'infinity'`)).toBe(`CREATE ROLE "r" WITH LOGIN PASSWORD '****' VALID UNTIL 'infinity'`)
    expect(redactSecrets(`ALTER ROLE "r" ENCRYPTED PASSWORD 'it''s'`)).toBe(`ALTER ROLE "r" ENCRYPTED PASSWORD '****'`)
  })

  it("masks SQL Server login passwords, N'…' strings with doubled quotes", () => {
    expect(redactSecrets(`ALTER LOGIN [it's] WITH PASSWORD = N'a''b', OLD_PASSWORD=N'c', DEFAULT_DATABASE = [x]`)).toBe(
      `ALTER LOGIN [it's] WITH PASSWORD = N'****', OLD_PASSWORD=N'****', DEFAULT_DATABASE = [x]`
    )
    expect(redactSecrets(`IF SUSER_ID(N'app') IS NULL CREATE LOGIN [app] WITH PASSWORD = N'pw'`)).toBe(
      `IF SUSER_ID(N'app') IS NULL CREATE LOGIN [app] WITH PASSWORD = N'****'`
    )
  })

  it('leaves password columns of queries and DML alone: rerun from the history they would write ****', () => {
    for (const sql of [
      `SELECT * FROM users WHERE password = N'x'`,
      `UPDATE u SET name = N'a', password = N'x' WHERE id = 1`,
      `INSERT INTO users (name, password) SELECT N'a', password FROM old WHERE password='x'`
    ]) {
      expect(redactSecrets(sql)).toBe(sql)
    }
  })
})

describe('collectPrivileges', () => {
  it('drops USAGE and turns any grantable row into GRANT OPTION', () => {
    // GRANT GRANT OPTION ON db.* shows up as a single grantable USAGE row
    expect(collectPrivileges([{ privilege: 'USAGE', grantable: 'YES' }])).toEqual(['GRANT OPTION'])
    expect(collectPrivileges([{ privilege: 'USAGE', grantable: 'NO' }])).toEqual([])
  })
})

describe('accountStatements', () => {
  it('renames first, so the following statements address the new name', () => {
    const before = account()
    const after = account({ user: 'app2', host: 'localhost', limits: { ...before.limits, maxQueries: 10 } })
    expect(accountStatements(before, after, 's3cret', mysql)).toEqual([
      "RENAME USER 'app'@'%' TO 'app2'@'localhost'",
      "ALTER USER 'app2'@'localhost' IDENTIFIED WITH caching_sha2_password BY 's3cret'",
      "ALTER USER 'app2'@'localhost' WITH MAX_QUERIES_PER_HOUR 10"
    ])
  })

  it('grants GRANT OPTION alone through USAGE and revokes only what was removed', () => {
    const before = account({ schemas: [{ schema: 'app\\_%', privileges: ['SELECT', 'INSERT'] }] })
    const after = account({ privileges: ['GRANT OPTION'], schemas: [{ schema: 'app\\_%', privileges: ['SELECT'] }] })
    expect(accountStatements(before, after, null, mysql)).toEqual([
      "GRANT USAGE ON *.* TO 'app'@'%' WITH GRANT OPTION",
      "REVOKE INSERT ON `app\\_%`.* FROM 'app'@'%'"
    ])
  })

  it('revokes GRANT OPTION on its own, so MySQL does not turn it into REVOKE ALL on every level', () => {
    const before = account({ privileges: ['SELECT', 'GRANT OPTION'] })
    expect(accountStatements(before, account(), null, mysql)).toEqual([
      "REVOKE SELECT ON *.* FROM 'app'@'%'",
      "REVOKE GRANT OPTION ON *.* FROM 'app'@'%'"
    ])
  })

  it('on MySQL re-grants kept dynamic privileges when GRANT OPTION is removed', () => {
    // MySQL keeps the grant option of dynamic privileges cached after REVOKE GRANT OPTION
    const before = account({ privileges: ['SELECT', 'GRANT OPTION', 'BACKUP_ADMIN'] })
    const after = account({ privileges: ['SELECT', 'BACKUP_ADMIN'] })
    expect(accountStatements(before, after, null, mysql)).toEqual([
      "REVOKE BACKUP_ADMIN ON *.* FROM 'app'@'%'",
      "REVOKE GRANT OPTION ON *.* FROM 'app'@'%'",
      "GRANT BACKUP_ADMIN ON *.* TO 'app'@'%'"
    ])
    expect(accountStatements(before, after, null, { isMariaDB: true })).toEqual(["REVOKE GRANT OPTION ON *.* FROM 'app'@'%'"])
  })

  it('requires a password to switch to a password plugin and uses VIA on MariaDB', () => {
    const before = account({ plugin: 'unix_socket' })
    const after = account({ plugin: 'mysql_native_password' })
    expect(() => accountStatements(before, after, null, { isMariaDB: true })).toThrow(
      t('sql.account.passwordRequired', { plugin: 'mysql_native_password' })
    )
    expect(accountStatements(before, after, 'pw', { isMariaDB: true })).toEqual([
      "ALTER USER 'app'@'%' IDENTIFIED VIA mysql_native_password USING PASSWORD('pw')"
    ])
  })
})
