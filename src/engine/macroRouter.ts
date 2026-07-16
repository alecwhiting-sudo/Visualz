import type { ParamSchema } from '../scenes/types'
import { snapToStep } from '../scenes/paramStep'

/** Fixed in v1 (docs/MACROS.md §7: slot-count config is explicitly deferred) —
 * a real `setMacroSlotCount` API was sketched in the spec's §4 code block but
 * contradicts §7's "not in v1" list, so this ships as an internal constant
 * rather than a settable method; see the architect report for this call. */
export const MACRO_SLOT_COUNT = 8

const SLOT_NAME = /^ctl\.([1-8])$/

/** `ctl.N` (1-8) -> 0-based slot index, or `null` for any other signal name. */
function slotIndexOf(name: string): number | null {
  const m = SLOT_NAME.exec(name)
  return m ? Number(m[1]) - 1 : null
}

/**
 * docs/MACROS.md: eight macro slots (`ctl.1`..`ctl.8`) drive the current
 * scene's params *positionally* (param i <- slot i+1) once a NEW value has
 * arrived for that slot's signal since the last reset — the "engaged" bit
 * per slot (§2, pickup semantics). Deliberately holds no reference to an
 * `Engine`/`SignalBus`/scene instance so it's cheaply unit-testable and so
 * neither `app/` nor `engine/` needs to reach across the other for the
 * shared step-snap helper (see `paramStep.ts`).
 *
 * Reset points (§2/§4): a cold `Engine` construction (a fresh `MacroRouter`
 * per instance already gives this for free), `switchScene`, and
 * `loadSession` all call `reset()`. Between resets, engagement only ever
 * turns on, never off — `noteSignal` is called for EVERY `ctl.N` write,
 * live and replayed alike (`Engine.setInputSignal` and the session player's
 * `setInputSignal` path both call it), so engagement is a pure function of
 * the recorded event/switch stream and replays identically.
 */
export class MacroRouter {
  private engaged: boolean[] = new Array(MACRO_SLOT_COUNT).fill(false)

  /** Clears all engagement. */
  reset(): void {
    this.engaged.fill(false)
  }

  /** Engages the matching slot if `name` is `ctl.N` (1-8); a no-op otherwise.
   * Called for every `inputSignal` write, regardless of source. */
  noteSignal(name: string): void {
    const i = slotIndexOf(name)
    if (i !== null) this.engaged[i] = true
  }

  /** True when the param at `index` (scene.params order) is CURRENTLY macro-
   * driven: its positional slot is engaged and it has no explicit user
   * binding. Used by the UI (`isMacroDriven`) to render live values/hints. */
  isDriven(index: number, params: ParamSchema[], hasBinding: (name: string) => boolean): boolean {
    if (index < 0 || index >= MACRO_SLOT_COUNT) return false
    const param = params[index]
    if (!param) return false
    return this.engaged[index] && !hasBinding(param.name)
  }

  /**
   * Runs after DSL binding evaluation each frame (docs/MACROS.md §4):
   * expressions outrank macros, so a bound param is skipped entirely (no
   * double-write). For every remaining engaged slot with a positional param,
   * range-maps `ctl(slot)` (raw 0..1, read straight off the bus by the
   * caller) onto `[param.min, param.max]` and step-snaps it identically to
   * `RotaryKnob`'s manual commit (`paramStep.ts`). A scene with fewer params
   * than slots simply has no `params[i]` for the high slots — they're inert,
   * not an error.
   */
  route(
    params: ParamSchema[],
    hasBinding: (name: string) => boolean,
    ctl: (slot1: number) => number,
    setParam: (name: string, value: number) => void,
  ): void {
    for (let i = 0; i < MACRO_SLOT_COUNT; i++) {
      if (!this.engaged[i]) continue
      const param = params[i]
      if (!param || hasBinding(param.name)) continue
      const raw = param.min + ctl(i + 1) * (param.max - param.min)
      setParam(param.name, snapToStep(raw, param.min, param.max, param.step))
    }
  }
}
