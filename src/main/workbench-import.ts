import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { t } from '@shared/i18n'
import type { ImportedConnections, Snippet } from '@shared/types'
import { parseWorkbenchConnections, parseWorkbenchSnippets } from './workbench-format'
import { listConnections, saveConnection } from './store'

const workbenchDir = join(homedir(), 'Library/Application Support/MySQL/Workbench')

export function importWorkbenchConnections(): ImportedConnections {
  const path = join(workbenchDir, 'connections.xml')
  if (!existsSync(path)) return { imported: 0, skipped: 0, error: t('workbench.connectionsNotFound') }
  const existing = new Set(listConnections().map((c) => c.id))
  let imported = 0
  let skipped = 0
  for (const conn of parseWorkbenchConnections(readFileSync(path, 'utf8'))) {
    if (existing.has(conn.id)) {
      skipped++
      continue
    }
    saveConnection(conn)
    imported++
  }
  return { imported, skipped }
}

/**
 * Reads a password MySQL Workbench stored in the login keychain
 * (service "Mysql@host:port[@sshhost:sshport]", account = user name).
 * macOS asks the user to allow the access.
 */
export function readWorkbenchPassword(service: string, account: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account, '-w'], (err, stdout) =>
      resolve(err ? undefined : stdout.replace(/\n$/, ''))
    )
  })
}

export function importWorkbenchSnippets(): Snippet[] | null {
  const dir = join(workbenchDir, 'snippets')
  if (!existsSync(dir)) return null
  const out: Snippet[] = []
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.txt'))) {
    const category = file.replace(/\.txt$/, '').replace(/^User Snippets$/, 'My Snippets')
    out.push(...parseWorkbenchSnippets(readFileSync(join(dir, file), 'utf8'), category))
  }
  return out
}
