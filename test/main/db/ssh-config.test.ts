import { describe, expect, it } from 'vitest'
import { expandTokens, parseConfig, parseProxyJump } from '../../../src/main/db/ssh-config'

// Expected values from ssh_config(5): keywords are case-insensitive, separated from their
// arguments by spaces or by one `=`; arguments may be in double quotes; Host takes several
// patterns; `#` starts a comment.
describe('parseConfig', () => {
  const hosts = (text: string): string[] => parseConfig(text).flatMap((e) => ('host' in e ? [e.host] : []))

  it.each([
    // bug: the whole line dropped because of one pattern, or the pattern offered as a host
    ['several names with a pattern among them', 'Host alpha *.example.org beta', ['alpha', 'beta']],
    ['patterns only', 'Host *\nHost !gamma web-??', []],
    // bug: only the spelling "Host " followed by a space recognised
    ['= and case of the keyword', 'Host=alpha\nhost beta\n  HOST = gamma delta', ['alpha', 'beta', 'gamma', 'delta']],
    // bug: a keyword that only begins with Host taken for it
    ['HostName, HostKeyAlias and Match are not Host', 'Host alpha\n  HostName real.example.org\n  HostKeyAlias other\nMatch host beta', ['alpha']],
    ['quotes and comments', '# Host hidden\nHost "two words" alpha # Host trailing\r\n', ['two words', 'alpha']]
  ])('names the hosts: %s', (_case, text, expected) => {
    expect(hosts(text)).toEqual(expected)
  })

  // bug: the hosts of an included file listed after those of the including one, or an Include with two paths read as one
  it('keeps the Include entries where they are written, one per path', () => {
    expect(parseConfig('Host first\nInclude conf.d/* "~/more hosts"\nHost last')).toEqual([
      { host: 'first' },
      { include: 'conf.d/*' },
      { include: '~/more hosts' },
      { host: 'last' }
    ])
  })
})

// bug: `IdentityFile ~/.ssh/keys/%h_%r_key` taken as a file name, which does not exist: the key is skipped and a password asked
it('expandTokens replaces the tokens of an IdentityFile, %% with a percent sign, and leaves those it has no value for', () => {
  expect(expandTokens('/home/keys/%h_%r_key-%p%%-%C', { h: 'real.example.org', r: 'ann', p: '2201' })).toBe('/home/keys/real.example.org_ann_key-2201%-%C')
})

// ssh_config(5), ProxyJump: [user@]host[:port] or an ssh URI, several separated by commas and
// visited in that order; "none" disables it.
describe('parseProxyJump', () => {
  it.each([
    ['gate', [{ host: 'gate' }]],
    // bug: the user or the port left in the host name, which ssh -G would then resolve as another host
    ['ann@gate.example.org:2222', [{ host: 'gate.example.org', user: 'ann', port: 2222 }]],
    ['ssh://ann@gate:2022', [{ host: 'gate', user: 'ann', port: 2022 }]],
    ['[2001:db8::1]:2200', [{ host: '2001:db8::1', port: 2200 }]],
    // bug: the hosts crossed in the wrong order
    ['first,ann@second:22', [{ host: 'first' }, { host: 'second', user: 'ann', port: 22 }]],
    ['none', []],
    ['', []]
  ])('reads %j', (value, expected) => {
    expect(parseProxyJump(value)).toEqual(expected)
  })
})
