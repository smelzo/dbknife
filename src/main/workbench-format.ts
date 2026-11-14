// Parsers for MySQL Workbench's data files (no Electron dependency, unit tested).
import { XMLParser } from 'fast-xml-parser'
import type { ConnectionConfig, Snippet, SslMode } from '@shared/types'

interface XmlValue {
  '@_key'?: string
  '@_type'?: string
  '@_struct-name'?: string
  '@_id'?: string
  '#text'?: string | number
  value?: XmlValue[]
  link?: XmlValue[]
}

const sslModes: SslMode[] = ['disabled', 'preferred', 'required', 'verify_ca', 'verify_identity']

function byKey(node: XmlValue): Record<string, XmlValue> {
  const out: Record<string, XmlValue> = {}
  for (const child of [...(node.value ?? []), ...(node.link ?? [])]) if (child['@_key']) out[child['@_key']] = child
  return out
}

const text = (node: XmlValue | undefined): string => (node?.['#text'] === undefined ? '' : String(node['#text']))

/** Converts the connections of MySQL Workbench's connections.xml (GRT format). */
export function parseWorkbenchConnections(xml: string): ConnectionConfig[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false,
    isArray: (name) => name === 'value' || name === 'link'
  })
  const doc = parser.parse(xml) as { data?: { value?: XmlValue[] } }
  const list = doc.data?.value?.[0]?.value ?? []
  const out: ConnectionConfig[] = []
  for (const node of list) {
    if (node['@_struct-name'] !== 'db.mgmt.Connection') continue
    const fields = byKey(node)
    const params = fields.parameterValues ? byKey(fields.parameterValues) : {}
    const p = (key: string): string => text(params[key])
    const driver = text(fields.driver)
    const method = driver.endsWith('sshtun') ? 'ssh' : driver.endsWith('socket') ? 'socket' : 'tcp'
    const [sshHost, sshPort] = p('sshHost').split(':')
    out.push({
      id: node['@_id'] ?? crypto.randomUUID(),
      name: text(fields.name) || p('hostName'),
      engine: 'mysql',
      method,
      host: p('hostName') || '127.0.0.1',
      port: Number(p('port') || 3306),
      socket: p('socket'),
      user: p('userName'),
      database: '',
      file: '',
      defaultSchema: p('schema'),
      ssl: {
        mode: sslModes[Number(p('useSSL') || 0)] ?? 'preferred',
        ca: p('sslCA'),
        cert: p('sslCert'),
        key: p('sslKey'),
        cipher: p('sslCipher')
      },
      ssh: { host: sshHost ?? '', port: Number(sshPort || 22), user: p('sshUserName'), keyFile: p('sshKeyFile') },
      options: {
        compress: p('CLIENT_COMPRESS') === '1',
        connectTimeout: Number(p('timeout') || 10) || 10,
        sqlMode: p('SQL_MODE'),
        others: p('OPT_OTHERS') ?? ''
      },
      workbenchKeychain: text(fields.hostIdentifier) || undefined
    })
  }
  return out
}

/**
 * Parses a MySQL Workbench snippets file: a title line, then the snippet body
 * with every line indented by one space; snippets are separated by blank lines.
 * Workbench's snippets are MySQL's.
 */
export function parseWorkbenchSnippets(text: string, category: string): Snippet[] {
  const out: Snippet[] = []
  let current: Snippet | undefined
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith(' ') && current) current.sql += (current.sql ? '\n' : '') + line.slice(1)
    else if (line.trim() && !line.startsWith(' ')) {
      current = { id: crypto.randomUUID(), engine: 'mysql', category, title: line.trim(), sql: '' }
      out.push(current)
    }
  }
  return out
}
