// The OpenSSH configuration of the user and of the system: the hosts it names, and the
// connections `ssh -G` says a host is reached through. The files are read here only to
// list the names; what a name means is always asked to ssh, which applies Include, Match
// and `Host *` itself.
import { execFile } from 'node:child_process'
import { glob, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { t } from '@shared/i18n'
import { expandHome } from './session'
import { SshError, type SshHop } from './ssh'

/** A Host name of a configuration file, or a file it includes. */
export type ConfigEntry = { host: string } | { include: string }

/** A host of a ProxyJump value. */
export interface JumpSpec {
  host: string
  user?: string
  port?: number
}

/**
 * The words of a configuration line, keyword first: separated by spaces or by one `=` after
 * the keyword, in double quotes when they contain spaces; `#` starts a comment.
 */
function configWords(line: string): string[] {
  const words: string[] = []
  for (const m of line.replace(/^\s*([^\s="#]+)\s*=\s*/, '$1 ').matchAll(/"([^"]*)"?|[^\s"]+/g)) {
    if (m[1] === undefined && m[0].startsWith('#')) break
    words.push(m[1] ?? m[0])
  }
  return words
}

/**
 * The hosts a configuration text names and the files it includes, in the order they are
 * written. A pattern (`*`, `?`, `!`) names no host.
 */
export function parseConfig(text: string): ConfigEntry[] {
  const entries: ConfigEntry[] = []
  for (const line of text.split(/\r?\n/)) {
    const [keyword, ...args] = configWords(line)
    switch (keyword?.toLowerCase()) {
      case 'host':
        for (const host of args) if (!/[*?!]/.test(host)) entries.push({ host })
        break
      case 'include':
        for (const include of args) entries.push({ include })
    }
  }
  return entries
}

/**
 * The hosts of a ProxyJump value, in the order they are crossed: `[user@]host[:port]` or
 * `ssh://[user@]host[:port]`, separated by commas. None for `none` or an empty value.
 */
export function parseProxyJump(value: string): JumpSpec[] {
  if (!value.trim() || value.trim().toLowerCase() === 'none') return []
  return value.split(',').map((item) => {
    let rest = item.trim().replace(/^ssh:\/\/(.*?)\/?$/i, '$1')
    const at = rest.lastIndexOf('@')
    const user = at > 0 ? rest.slice(0, at) : undefined
    if (at >= 0) rest = rest.slice(at + 1)
    // an IPv6 address is in brackets when a port follows it
    const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(rest) ?? /^([^:]+)(?::(\d+))?$/.exec(rest)
    return m ? { host: m[1], user, port: m[2] ? Number(m[2]) : undefined } : { host: rest, user }
  })
}

/** DBM_SSH_CONFIG (tests): the only configuration file, in place of the user's and the system's. */
const configOverride = (): string | undefined => process.env.DBM_SSH_CONFIG || undefined

/** Adds to `hosts` those of a configuration file and of the files it includes; a file that cannot be read has none. */
async function collectHosts(file: string, base: string, hosts: Set<string>, seen: Set<string>): Promise<void> {
  // a file including itself, or included twice
  if (seen.has(file)) return
  seen.add(file)
  const text = await readFile(file, 'utf8').catch(() => undefined)
  if (text === undefined) return
  for (const entry of parseConfig(text)) {
    if ('host' in entry) {
      hosts.add(entry.host)
      continue
    }
    const pattern = expandHome(entry.include)
    const included: string[] = []
    try {
      for await (const path of glob(isAbsolute(pattern) ? pattern : join(base, pattern))) included.push(path)
    } catch {
      // a pattern that cannot be read includes nothing
    }
    for (const path of included.sort()) await collectHosts(path, base, hosts, seen)
  }
}

/**
 * The hosts named in `~/.ssh/config` and in the system's `ssh_config`, following Include,
 * without patterns and without repetitions, in the order of the files. A relative Include
 * is a path of `~/.ssh` in the user's file and of the system's folder in the system's.
 */
export async function listConfigHosts(): Promise<string[]> {
  const userDir = join(homedir(), '.ssh')
  const systemFile = process.platform === 'win32' ? join(process.env.PROGRAMDATA ?? 'C:\\ProgramData', 'ssh', 'ssh_config') : '/etc/ssh/ssh_config'
  const override = configOverride()
  const hosts = new Set<string>()
  const seen = new Set<string>()
  if (override) await collectHosts(override, userDir, hosts, seen)
  else {
    await collectHosts(join(userDir, 'config'), userDir, hosts, seen)
    await collectHosts(systemFile, dirname(systemFile), hosts, seen)
  }
  return [...hosts]
}

/** What `ssh -G` prints for a host: the values of each keyword, in lower case, of the configuration OpenSSH would use. */
function resolvedConfig(target: JumpSpec): Promise<Map<string, string[]>> {
  return new Promise((resolve, reject) => {
    // never an option: the host is what the user typed, or what a configuration file says
    if (!target.host || target.host.startsWith('-')) {
      reject(new SshError(t('main.ssh.badConfigHost', { host: target.host }), 'network'))
      return
    }
    const override = configOverride()
    const args = [
      ...(override ? ['-F', override] : []),
      // -T: no warning about the terminal among the errors
      '-T',
      '-G',
      ...(target.user ? ['-l', target.user] : []),
      ...(target.port ? ['-p', String(target.port)] : []),
      '--',
      target.host
    ]
    execFile('ssh', args, { encoding: 'utf8', timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const notFound = (err as NodeJS.ErrnoException).code === 'ENOENT'
        reject(new SshError(notFound ? t('main.ssh.notInstalled') : t('main.ssh.error', { error: stderr.trim() || err.message }), 'network'))
        return
      }
      const config = new Map<string, string[]>()
      for (const line of stdout.split(/\r?\n/)) {
        const space = line.indexOf(' ')
        if (space <= 0) continue
        const keyword = line.slice(0, space)
        config.set(keyword, [...(config.get(keyword) ?? []), line.slice(space + 1)])
      }
      resolve(config)
    })
  })
}

/** More connections in a row than this is taken for hosts jumping through each other. */
const maxHops = 10

/**
 * The connections leading to `target`, the first one opened from this machine. `via` are
 * the jump hosts given by the host after it, which replace those of its own configuration.
 */
async function hopsTo(target: JumpSpec, via: JumpSpec[] | undefined, origin: string, left: number): Promise<SshHop[]> {
  if (left === 0) throw new SshError(t('main.ssh.jumpTooMany', { host: origin, max: maxHops }), 'network')
  const config = await resolvedConfig(target)
  const one = (keyword: string): string | undefined => config.get(keyword)?.[0]
  const host = one('hostname') ?? target.host
  const hop: SshHop = {
    alias: target.host,
    host,
    port: Number(one('port')) || 22,
    username: one('user') ?? '',
    keyFiles: (config.get('identityfile') ?? []).map(expandHome),
    agent: one('identitiesonly') !== 'yes',
    hostKeyName: one('hostkeyalias') ?? host
  }
  const jumps = via ?? parseProxyJump(one('proxyjump') ?? '')
  if (!jumps.length) {
    const command = one('proxycommand')
    if (command && command.toLowerCase() !== 'none') throw new SshError(t('main.ssh.proxyCommand', { host: target.host }), 'network')
    return [hop]
  }
  // As OpenSSH does: the last of the list is the one that reaches the target, through the
  // others; only a jump host reached with no other before it follows its own ProxyJump.
  const before = await hopsTo(jumps[jumps.length - 1], jumps.length > 1 ? jumps.slice(0, -1) : undefined, origin, left - 1)
  return [...before, hop]
}

/**
 * The connections a host of the OpenSSH configuration is reached through, as `ssh -G`
 * resolves them now: its ProxyJump hosts in the order they are crossed, then the host itself.
 * Rejects with an SshError: ssh missing, ProxyCommand (not supported), a ProxyJump loop.
 */
export const resolveConfigHost = (alias: string): Promise<SshHop[]> => hopsTo({ host: alias }, undefined, alias, maxHops)
