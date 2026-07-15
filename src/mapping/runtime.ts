import type { SignalBus } from '../core/signals'
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
   * of tracing a clean decay curve on top of it. Tracking `applied` makes the
   * telescoping sum of deltas equal the envelope's current value exactly, so a
   * pulse still literally "adds ... to the param each frame" while its net
   * contribution stays framerate-independent and bounded by `amount`.
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
 * each frame (see Engine.updateAndRender), so a 'set'/'ramp' action's write gets
 * overwritten by the binding on the very next frame (binding wins). 'pulse' still
 * composes visibly because it reads the param fresh (post-binding) and adds its
 * decaying offset on top, every frame, for as long as it's active.
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

    for (let i = this.activePulses.length - 1; i >= 0; i--) {
      const pulse = this.activePulses[i]
      const offset = pulse.amount * Math.pow(2, -pulse.elapsed / pulse.halflife)
      params.set(pulse.param, params.get(pulse.param) + (offset - pulse.applied))
      pulse.applied = offset
      if (Math.abs(offset) < 0.001 * Math.abs(pulse.amount)) {
        this.activePulses.splice(i, 1)
      } else {
        pulse.elapsed += dt
      }
    }
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

  /** Clears queue, held keys, and active ramps/pulses — for deterministic replay. */
  reset(): void {
    this.queued = []
    this.heldKeys.clear()
    this.activeRamps.clear()
    this.activePulses.length = 0
  }
}
