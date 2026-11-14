/**
 * Keyboard of a role="tablist": ←/→ move the focus to the previous/next tab,
 * without activating it (Enter/Space on the tab does that).
 */
export function moveTabFocus(e: KeyboardEvent): void {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  const tabs = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="tab"]')]
  const at = tabs.findIndex((tab) => tab.contains(document.activeElement))
  const next = tabs[at + (e.key === 'ArrowLeft' ? -1 : 1)]
  if (at < 0 || !next) return
  e.preventDefault()
  next.focus()
}
