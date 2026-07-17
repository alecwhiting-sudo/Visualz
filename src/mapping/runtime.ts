import type { SignalBus } from '../core/signals'
import type { ParamSchema } from '../scenes/types'
import type { Action, MappingRule, SourceEvent } from './types'

interface ParamAccess {
  get(name: string): number
  set(name: string, v: number): void
}

interface ActiveRamp {
  start: number
  target: number
  duration: number
  elapsed: number
}

interface ActivePulse {
  param: string
  amount: number
  halflife: number
  elapsed: number
  /**
   * Offset already folded into the param by this pulse. Each frame we compute
   * the envelope's *current* value (amount * 2^(-elapsed/halflife)) and add only
   * the delta since last frame, not the whole envelope value again — otherwise
   * a one-shot pulse would sum an entire geometric series into the param instead
   * of tracing a clean decay curve on top of it. The telescoping only holds while
   * the param still contains our previous write; see `lastPulseWrite`.
   */
  applied: number
}

/**
 * Drives the mapping table (ARCHITECTURE.md §3.4): frontends (keyboard, touch,
 * MIDI, audio events) call `queue()` whenever a `SourceEvent` happens; the engine
 * calls `update()` once per frame with the current dt. Everything downstream of
 * `queue()` advances by dt only — no wall clock — so a recorded event log replays
 * frame-identically.
 *
 * Params with an expression binding: bindings run before `MappingRuntime.update()`
 * each frame (see Engine.updateAndRender), so a 'set' action's one-shot write gets
 * overwritten by the binding on the very next frame (binding wins). A 'ramp'
 * re-writes the param every frame after the binding for its whole duration, so a
 * ramp wins over a binding until it completes. 'pulse' composes: it adds its
 * decaying envelope on top of whatever wrote the param this frame (binding, knob,
 * or nothing), for as long as it's active.
 */
export class MappingRuntime {
  private keyRules = new Map<string, MappingRule[]>()
  private triggerRules = new Map<number, MappingRule[]>()

  private queued: SourceEvent[] = []
  private heldKeys = new Set<string>()
  private knownKeySignals = new Set<string>()
  private knownTriggerSignals = new Set<number>()

  private activeRamps = new Map<string, ActiveRamp>()
  private activePulses: ActivePulse[] = []
  /**
   * The exact value we last wrote to each pulsed param. If the param no longer
   * holds it at the next update, something external (an expression binding, a
   * knob, a set/ramp) rewrote the param and wiped our previous contribution — so
   * the telescoping `applied` bookkeeping is void and the full envelope value
   * belongs on top of the new base. Without this, a pulse on a bound param
   * over-subtracts and dips *below* baseline instead of decaying onto it.
   */
  private lastPulseWrite = new Map<string, number>()

  constructor(rules: MappingRule[]) {
    for (const rule of rules) {
      if (rule.source.type === 'key') {
        const list = this.keyRules.get(rule.source.key) ?? []
        list.push(rule)
        this.keyRules.set(rule.source.key, list)
      } else {
        const list = this.triggerRules.get(rule.source.index) ?? []
        list.push(rule)
        this.triggerRules.set(rule.source.index, list)
      }
    }
  }

  /** Called by frontends any time; events are buffered until the next update(). */
  queue(event: SourceEvent): void {
    this.queued.push(event)
  }

  /** Called once per frame by the engine. */
  update(dt: number, bus: SignalBus, params: ParamAccess): void {
    // Drain the buffered events: update held-key state, note which triggers hit
    // this frame, and start any matching rules' actions.
    const events = this.queued
    this.queued = []
    const triggeredThisFrame = new Set<number>()

    for (const event of events) {
      if (event.type === 'key') {
        this.knownKeySignals.add(event.key)
        if (event.edge === 'down') {
          this.heldKeys.add(event.key)
          for (const rule of this.keyRules.get(event.key) ?? []) {
            this.startAction(rule.action, params)
          }
        } else {
          this.heldKeys.delete(event.key)
        }
      } else {
        this.knownTriggerSignals.add(event.index)
        triggeredThisFrame.add(event.index)
        for (const rule of this.triggerRules.get(event.index) ?? []) {
          this.startAction(rule.action, params)
        }
      }
    }

    // Publish input signals for the DSL. Every name ever published is republished
    // every frame (1 or 0) so a stale 1 never lingers once its key/trigger passes.
    for (const key of this.knownKeySignals) {
      bus.set(`key.${key}`, this.heldKeys.has(key) ? 1 : 0)
    }
    for (const index of this.knownTriggerSignals) {
      bus.set(`trig.${index}`, triggeredThisFrame.has(index) ? 1 : 0)
    }

    // Advance active ramps and pulses by dt (including ones started this frame,
    // so a fired ramp takes its first step now and a fired pulse applies its
    // full amount now).
    for (const [param, ramp] of this.activeRamps) {
      ramp.elapsed += dt
      const t = ramp.duration <= 0 ? 1 : Math.min(1, ramp.elapsed / ramp.duration)
      if (t >= 1) {
        // Clamp to the exact target rather than trusting the lerp at t=1, which
        // can drift by float rounding.
        params.set(param, ramp.target)
        this.activeRamps.delete(param)
      } else {
        params.set(param, ramp.start + (ramp.target - ramp.start) * t)
      }
    }

    // Pulses are processed grouped by param so an external overwrite (binding,
    // knob, set/ramp) is detected once per param and voids every pulse's
    // `applied` on it together.
    if (this.activePulses.length > 0) {
      const byParam = new Map<string, ActivePulse[]>()
      for (const pulse of this.activePulses) {
        const list = byParam.get(pulse.param) ?? []
        list.push(pulse)
        byParam.set(pulse.param, list)
      }
      for (const [param, pulses] of byParam) {
        const current = params.get(param)
        const wiped = this.lastPulseWrite.get(param) !== current
        let value = current
        for (const pulse of pulses) {
          const applied = wiped ? 0 : pulse.applied
          // halflife <= 0 means instantaneous: full amount on the fire frame,
          // gone the next (guards the 2^(-x/0) = NaN path).
          const offset =
            pulse.halflife > 0
              ? pulse.amount * Math.pow(2, -pulse.elapsed / pulse.halflife)
              : pulse.elapsed === 0
                ? pulse.amount
                : 0
          value += offset - applied
          pulse.applied = offset
          if (Math.abs(offset) < 0.001 * Math.abs(pulse.amount)) {
            this.activePulses.splice(this.activePulses.indexOf(pulse), 1)
          } else {
            pulse.elapsed += dt
          }
        }
        params.set(param, value)
        if (pulses.some((p) => this.activePulses.includes(p))) {
          this.lastPulseWrite.set(param, value)
        } else {
          this.lastPulseWrite.delete(param)
        }
      }
    }
  }

  /**
   * Pads/PERFORM batch: (re)generates ONLY the trigger-sourced rules —
   * keyboard rules are untouched — so pad T_n (trigger index n-1) pulses the
   * CURRENT scene's (n-1)th param, positionally, instead of the old
   * hardcoded-to-Lissajous defaults (`drift`/`hueSpeed`/`freqX`/`freqY`, dead
   * on every other scene). Each rule pulses its param by 30% of the param's
   * own range (`amount: 0.3 * (max - min)`) with a 0.4s halflife decay —
   * consistent, positional "kick" semantics regardless of scene.
   *
   * Fewer than 4 params yields fewer trigger rules (`Math.min(4, params.length)`)
   * — spare pads (T_(n+1)..T4) are left with no rule at all, i.e. inert: a
   * press queues a `trigger` SourceEvent (still publishes `trig.N` on the bus
   * for the DSL) but drives nothing.
   *
   * A pure function of `params` — same schema in, same rules out, so calling
   * it from both `Engine`'s constructor and the end of `switchScene` keeps
   * live and replay identical (replay's `switchScene` call is the same method,
   * invariant I6) and repeated calls with the same schema are idempotent
   * (this clears `triggerRules` before repopulating, never accumulates).
   */
  setPadTargets(params: ParamSchema[]): void {
    this.triggerRules.clear()
    const count = Math.min(4, params.length)
    for (let i = 0; i < count; i++) {
      const p = params[i]
      this.triggerRules.set(i, [
        {
          source: { type: 'trigger', index: i },
          action: { type: 'pulse', param: p.name, amount: 0.3 * (p.max - p.min), halflife: 0.4 },
        },
      ])
    }
  }

  /**
   * Sum of the decaying contributions currently applied to `param` by active
   * pulses. Lets a session recording snapshot the param's underlying base value
   * instead of baking a transient into the session's initial state.
   */
  pulseOffset(param: string): number {
    let sum = 0
    for (const pulse of this.activePulses) {
      if (pulse.param === param) sum += pulse.applied
    }
    return sum
  }

  private startAction(action: Action, params: ParamAccess): void {
    switch (action.type) {
      case 'set':
        params.set(action.param, action.value)
        break
      case 'ramp':
        // Re-fire restarts from whatever the param holds right now.
        this.activeRamps.set(action.param, {
          start: params.get(action.param),
          target: action.target,
          duration: action.duration,
          elapsed: 0,
        })
        break
      case 'pulse':
        this.activePulses.push({
          param: action.param,
          amount: action.amount,
          halflife: action.halflife,
          elapsed: 0,
          applied: 0,
        })
        break
    }
  }

  /**
   * Restores cold-start state for deterministic replay: queue, held keys, active
   * ramps/pulses, pulse write-tracking, and the known-signal sets (so a reset
   * runtime republishes nothing until inputs actually occur, exactly like a
   * fresh instance).
   */
  reset(): void {
    this.queued = []
    this.heldKeys.clear()
    this.knownKeySignals.clear()
    this.knownTriggerSignals.clear()
    this.activeRamps.clear()
    this.activePulses.length = 0
    this.lastPulseWrite.clear()
  }
}
