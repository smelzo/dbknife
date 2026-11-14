import { describe, expect, it } from 'vitest'
import { parseWorkbenchConnections, parseWorkbenchSnippets } from '../../src/main/workbench-format'

// Same structure MySQL Workbench 8.0 writes in connections.xml (GRT format), with made-up values.
const xml = `<?xml version="1.0"?>
<data grt_format="2.0">
  <value _ptr_="0x1" type="list" content-type="object" content-struct-name="db.mgmt.Connection">
    <value type="object" struct-name="db.mgmt.Connection" id="AAAA-1" struct-checksum="0x96ba47d8">
      <link type="object" struct-name="db.mgmt.Driver" key="driver">com.mysql.rdbms.mysql.driver.native</link>
      <value type="string" key="hostIdentifier">Mysql@10.0.0.5:3307</value>
      <value _ptr_="0x2" type="dict" key="parameterValues">
        <value type="string" key="hostName">10.0.0.5</value>
        <value type="int" key="port">3307</value>
        <value type="string" key="schema">sales</value>
        <value type="int" key="useSSL">2</value>
        <value type="string" key="userName">app</value>
      </value>
      <value type="string" key="name">Office/Sales</value>
    </value>
    <value type="object" struct-name="db.mgmt.Connection" id="BBBB-2" struct-checksum="0x96ba47d8">
      <link type="object" struct-name="db.mgmt.Driver" key="driver">com.mysql.rdbms.mysql.driver.native_sshtun</link>
      <value type="string" key="hostIdentifier">Mysql@127.0.0.1:3306@203.0.113.7:22105</value>
      <value _ptr_="0x3" type="dict" key="parameterValues">
        <value type="string" key="hostName">127.0.0.1</value>
        <value type="int" key="port">3306</value>
        <value type="string" key="sshHost">203.0.113.7:22105</value>
        <value type="string" key="sshKeyFile">/Users/me/.ssh/id_rsa</value>
        <value type="string" key="sshUserName">root</value>
        <value type="int" key="useSSL">1</value>
        <value type="string" key="userName">admin</value>
      </value>
      <value type="string" key="name">Remote</value>
    </value>
  </value>
</data>`

describe('parseWorkbenchConnections', () => {
  const [tcp, ssh] = parseWorkbenchConnections(xml)

  it('maps a TCP connection with its SSL mode, schema and keychain service', () => {
    expect(tcp).toMatchObject({
      id: 'AAAA-1',
      name: 'Office/Sales',
      method: 'tcp',
      host: '10.0.0.5',
      port: 3307,
      user: 'app',
      defaultSchema: 'sales',
      workbenchKeychain: 'Mysql@10.0.0.5:3307'
    })
    expect(tcp.ssl.mode).toBe('required')
  })

  it('maps an SSH tunnel connection, splitting the SSH host and port', () => {
    expect(ssh.method).toBe('ssh')
    expect(ssh.ssh).toEqual({ host: '203.0.113.7', port: 22105, user: 'root', keyFile: '/Users/me/.ssh/id_rsa' })
    expect(ssh.ssl.mode).toBe('preferred')
  })
})

describe('parseWorkbenchSnippets', () => {
  it('reads title lines and one-space indented bodies', () => {
    const s = parseWorkbenchSnippets('First\n SELECT 1\n FROM t\n\nSecond\n SELECT 2\n', 'Mine')
    expect(s.map(({ title, sql, category }) => ({ title, sql, category }))).toEqual([
      { title: 'First', sql: 'SELECT 1\nFROM t', category: 'Mine' },
      { title: 'Second', sql: 'SELECT 2', category: 'Mine' }
    ])
  })
})
