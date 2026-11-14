const isMac = navigator.userAgent.includes('Macintosh')

const macSymbols: Record<string, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Cmd: '⌘', Enter: '↩' }

/** A shortcut written as a menu accelerator with Cmd ('Cmd+Shift+Enter'), as the user reads it
 * on this platform: ⇧⌘↩ on macOS, Ctrl+Shift+Enter elsewhere. */
export function shortcut(accelerator: string): string {
  const parts = accelerator.split('+')
  const key = parts.pop() as string
  if (isMac) return [...['Ctrl', 'Alt', 'Shift', 'Cmd'].filter((m) => parts.includes(m)), key].map((p) => macSymbols[p] ?? p).join('')
  const mods = ['Ctrl', 'Alt', 'Shift'].filter((m) => parts.includes(m) || (m === 'Ctrl' && parts.includes('Cmd')))
  return [...mods, key].join('+')
}
