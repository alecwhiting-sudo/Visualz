/**
 * Persistent per-expression state for the stateful helpers (`smooth`, `env`, `lfo`).
 * Slot indices are assigned at compile time by the resolve pass in compile.ts — a pure
 * function of the parse tree, so the same source always keys the same slots. `reset()`
 * drops all slots so the next frame re-initializes exactly as a fresh state would
 * (smooth re-snaps, env resets to 0, lfo resets to phase 0). See docs/DSL.md §6.
 */

export type HelperState =
  | { kind: 'smooth'; y: number; value?: number }
  | { kind: 'env'; y: number; value?: number }
  | { kind: 'lfo'; phase: number; value?: number }

export class DslState {
  readonly slots: HelperState[] = []

  reset(): void {
    this.slots.length = 0
  }
}
