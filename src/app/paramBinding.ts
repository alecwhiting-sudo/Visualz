import { useEffect, useRef, useState } from 'react'
import type { Engine } from '../engine/engine'

export interface ParamBinding {
  /** True while `name` has a live binding (an expression, or a signal name
   * such as `midi.cc.3` from MIDI-learn — both go through the same
   * `engine.setBinding` path). Consumers must disable direct interaction and
   * render the engine's live polled value instead of local interactive state
   * while this is true (App.tsx's live-hardware-sync requirement). */
  bound: boolean
  /** The raw bound expression text — '' when unbound. Only the studio
   * slider's expression text field needs this; the rotary only needs `bound`. */
  exprText: string
  setExprText: (text: string) => void
  /** Compiles and applies `text` as `name`'s binding, clearing it on an empty
   * string. On a compile error the previous binding (or plain value) stays
   * active and `error` is set — mirrors `engine.setBinding`'s own contract. */
  applyExpr: (text: string) => void
  error: string | null
}

/**
 * Tracks param `name`'s binding state on `engine`, reacting both to changes
 * made through this hook's own `applyExpr` and to changes made OUTSIDE it —
 * a MIDI-learn bind landing via `engine.setBinding` from the learn-mode
 * activity callback, or a fresh engine/scene after a switch, handoff, or
 * session load. Shared by the studio slider (`Knob`) and the perform strip's
 * `RotaryKnob` so the binding bookkeeping lives in exactly one place.
 */
export function useParamBinding(engine: Engine, name: string): ParamBinding {
  const [exprText, setExprText] = useState(engine.getBinding(name) ?? '')
  const [bound, setBound] = useState(engine.getBinding(name) !== undefined)
  const [error, setError] = useState<string | null>(null)
  // The last binding this hook itself observed, so the effect below can tell
  // "the engine's binding changed under us" apart from our own applyExpr
  // calls, which already keep exprText/bound in sync synchronously.
  const lastSeenBindingRef = useRef(engine.getBinding(name))

  useEffect(() => {
    const current = engine.getBinding(name)
    if (current !== lastSeenBindingRef.current) {
      lastSeenBindingRef.current = current
      setExprText(current ?? '')
      setBound(current !== undefined)
      setError(null)
    }
  })

  const applyExpr = (text: string) => {
    const src = text.trim()
    if (src === '') {
      engine.clearBinding(name)
      lastSeenBindingRef.current = undefined
      setBound(false)
      setError(null)
      return
    }
    try {
      engine.setBinding(name, src)
      lastSeenBindingRef.current = src
      setBound(true)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return { bound, exprText, setExprText, applyExpr, error }
}
