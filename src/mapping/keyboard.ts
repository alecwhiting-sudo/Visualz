import type { SourceEvent } from './types'

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  const tag = el && typeof el.tagName === 'string' ? el.tagName.toLowerCase() : ''
  return tag === 'input' || tag === 'textarea'
}

/**
 * Keyboard frontend for the mapping layer (ARCHITECTURE.md §3.4). Lowercases
 * `KeyboardEvent.key`, drops OS auto-repeat, and ignores keystrokes aimed at
 * text inputs (the expression fields) so typing there never triggers visuals.
 */
export function attachKeyboard(target: Window, queue: (e: SourceEvent) => void): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat || isEditableTarget(e.target)) return
    queue({ type: 'key', key: e.key.toLowerCase(), edge: 'down' })
  }
  const onKeyUp = (e: KeyboardEvent) => {
    if (isEditableTarget(e.target)) return
    queue({ type: 'key', key: e.key.toLowerCase(), edge: 'up' })
  }

  target.addEventListener('keydown', onKeyDown as EventListener)
  target.addEventListener('keyup', onKeyUp as EventListener)

  return () => {
    target.removeEventListener('keydown', onKeyDown as EventListener)
    target.removeEventListener('keyup', onKeyUp as EventListener)
  }
}
