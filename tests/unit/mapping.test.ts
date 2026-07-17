import { describe, expect, it } from 'vitest'
import { SignalBus } from '../../src/core/signals'
import { MappingRuntime } from '../../src/mapping/runtime'
import { attachKeyboard } from '../../src/mapping/keyboard'
import type { MappingRule, SourceEvent } from '../../src/mapping/types'
import type { ParamSchema } from '../../src/scenes/types'

/** Minimal ParamSchema fixture — only the fields `setPadTargets` reads. */
function param(name: string, min: number, max: number, def = min): ParamSchema {
  return { name, label: name, min, max, default: def }
}

// --- Test harness ------------------------------------------------------------

/** A fake scene param store (params.get/set), recording every set() call. */
function fakeParams(initial: Record<string, number> = {}) {
  const values = new Map(Object.entries(initial))
  const calls: Array<{ name: string; value: number }> = []
  return {
    get: (name: string) => values.get(name) ?? 0,
    set: (name: string, value: number) => {
      values.set(name, value)
      calls.push({ name, value })
    },
    calls,
  }
}

// --- 1. Key signal publishing --------------------------------------------------

describe('key signal publishing', () => {
  it('1) key down publishes key.<k> = 1', () => {
    const runtime = new MappingRuntime([])
    const bus = new SignalBus()
    const params = fakeParams()
    runtime.queue({ type: 'key', key: 'x', edge: 'down' })
    runtime.update(1 / 60, bus, params)
    expect(bus.get('key.x')).toBe(1)
  })

  it('2) key up clears key.<k> back to 0', () => {
    const runtime = new MappingRuntime([])
    const bus = new SignalBus()
    const params = fakeParams()
    runtime.queue({ type: 'key', key: 'x', edge: 'down' })
    runtime.update(1 / 60, bus, params)
    runtime.queue({ type: 'key', key: 'x', edge: 'up' })
    runtime.update(1 / 60, bus, params)
    expect(bus.get('key.x')).toBe(0)
  })

  it('3) a stale key.<k> signal is republished as 0 on later frames with no events', () => {
    const runtime = new MappingRuntime([])
    const bus = new SignalBus()
    const params = fakeParams()
    runtime.queue({ type: 'key', key: 'x', edge: 'down' })
    runtime.update(1 / 60, bus, params)
    runtime.queue({ type: 'key', key: 'x', edge: 'up' })
    runtime.update(1 / 60, bus, params)
    // No new events: signal must stay clamped at 0, not linger stale.
    runtime.update(1 / 60, bus, params)
    expect(bus.get('key.x')).toBe(0)
  })
})

// --- 2. Trigger signal publishing ----------------------------------------------

describe('trigger signal publishing', () => {
  it('4) trigger pulse lasts exactly one update()', () => {
    const runtime = new MappingRuntime([])
    const bus = new SignalBus()
    const params = fakeParams()
    runtime.queue({ type: 'trigger', index: 2 })
    runtime.update(1 / 60, bus, params)
    expect(bus.get('trig.2')).toBe(1)
    runtime.update(1 / 60, bus, params)
    expect(bus.get('trig.2')).toBe(0)
  })
})

// --- 3. Rule matching / edges ---------------------------------------------------

describe('rule matching', () => {
  it('5) key rules fire on down-edge only, not up', () => {
    const rules: MappingRule[] = [
      { source: { type: 'key', key: 'a' }, action: { type: 'set', param: 'p', value: 9 } },
    ]
    const runtime = new MappingRuntime(rules)
    const bus = new SignalBus()
    const params = fakeParams({ p: 0 })
    runtime.queue({ type: 'key', key: 'a', edge: 'up' })
    runtime.update(1 / 60, bus, params)
    expect(params.get('p')).toBe(0)
    runtime.queue({ type: 'key', key: 'a', edge: 'down' })
    runtime.update(1 / 60, bus, params)
    expect(params.get('p')).toBe(9)
  })

  it("6) trigger rules fire on their index only", () => {
    const rules: MappingRule[] = [
      { source: { type: 'trigger', index: 3 }, action: { type: 'set', param: 'p', value: 9 } },
    ]
    const runtime = new MappingRuntime(rules)
    const bus = new SignalBus()
    const params = fakeParams({ p: 0 })
    runtime.queue({ type: 'trigger', index: 1 })
    runtime.update(1 / 60, bus, params)
    expect(params.get('p')).toBe(0)
    runtime.queue({ type: 'trigger', index: 3 })
    runtime.update(1 / 60, bus, params)
    expect(params.get('p')).toBe(9)
  })

  it("7) 'set' applies once immediately and does not keep re-applying", () => {
    const rules: MappingRule[] = [
      { source: { type: 'key', key: 'a' }, action: { type: 'set', param: 'p', value: 5 } },
    ]
    const runtime = new MappingRuntime(rules)
    const bus = new SignalBus()
    const params = fakeParams({ p: 0 })
    runtime.queue({ type: 'key', key: 'a', edge: 'down' })
    runtime.update(1 / 60, bus, params)
    expect(params.calls.filter((c) => c.name === 'p')).toHaveLength(1)
    params.set('p', 1) // external change (e.g. a slider)
    runtime.update(1 / 60, bus, params)
    expect(params.get('p')).toBe(1) // untouched by the old 'set'
  })
})

// --- 4. Ramps ---------------------------------------------------------------------

describe("'ramp' action", () => {
  it('8) hits target after exactly duration/dt steps', () => {
    const rules: MappingRule[] = [
      {
        source: { type: 'key', key: 'f' },
        action: { type: 'ramp', param: 'trail', target: 0.35, duration: 1 },
      },
    ]
    const runtime = new MappingRuntime(rules)
    const bus = new SignalBus()
    const params = fakeParams({ trail: 0.1 })
    const dt = 0.25 // exact in binary fp: 4 steps of 0.25 sum to 1.0 exactly
    runtime.queue({ type: 'key', key: 'f', edge: 'down' })
    for (let i = 0; i < 3; i++) {
      runtime.update(dt, bus, params)
      expect(params.get('trail')).not.toBe(0.35)
    }
    runtime.update(dt, bus, params)
    expect(params.get('trail')).toBe(0.35)
  })

  it('9) clamps at target and stops advancing past it', () => {
    const rules: MappingRule[] = [
      {
        source: { type: 'key', key: 'f' },
        action: { type: 'ramp', param: 'trail', target: 0.35, duration: 1 },
      },
    ]
    const runtime = new MappingRuntime(rules)
    const bus = new SignalBus()
    const params = fakeParams({ trail: 0.1 })
    runtime.queue({ type: 'key', key: 'f', edge: 'down' })
    for (let i = 0; i < 4; i++) runtime.update(0.25, bus, params)
    expect(params.get('trail')).toBe(0.35)
    runtime.update(0.25, bus, params) // one more frame, ramp already finished
    expect(params.get('trail')).toBe(0.35)
  })

  it('10) a re-fire restarts interpolation from the current value', () => {
    const rules: MappingRule[] = [
      {
        source: { type: 'key', key: 'f' },
        action: { type: 'ramp', param: 'p', target: 1, duration: 1 },
      },
    ]
    const runtime = new MappingRuntime(rules)
    const bus = new SignalBus()
    const params = fakeParams({ p: 0 })
    runtime.queue({ type: 'key', key: 'f', edge: 'down' })
    runtime.update(0.25, bus, params)
    runtime.update(0.25, bus, params)
    expect(params.get('p')).toBeCloseTo(0.5, 9) // halfway after 0.5s

    // Re-fire mid-ramp: restarts from the current value (0.5), not from 0.
    runtime.queue({ type: 'key', key: 'f', edge: 'down' })
    runtime.update(0.25, bus, params)
    runtime.update(0.25, bus, params)
    // Halfway through the *new* ramp: 0.5 -> 1 over 1s, 0.5s elapsed => 0.75.
    expect(params.get('p')).toBeCloseTo(0.75, 9)
  })
})

// --- 5. Pulses ---------------------------------------------------------------------

describe("'pulse' action", () => {
  it('11) adds the full amount at the fire frame', () => {
    const rules: MappingRule[] = [
      {
        source: { type: 'key', key: ' ' },
        action: { type: 'pulse', param: 'drift', amount: 1, halflife: 0.4 },
      },
    ]
    const runtime = new MappingRuntime(rules)
    const bus = new SignalBus()
    const params = fakeParams({ drift: 2 })
    runtime.queue({ type: 'key', key: ' ', edge: 'down' })
    runtime.update(1 / 60, bus, params)
    expect(params.get('drift')).toBeCloseTo(3, 9)
  })

  it('12) decays with halflife: amount/2 on top of base after exactly one halflife', () => {
    const halflife = 0.4
    const amount = 1
    const base = 2
    const rules: MappingRule[] = [
      {
        source: { type: 'key', key: ' ' },
        action: { type: 'pulse', param: 'drift', amount, halflife },
      },
    ]
    const runtime = new MappingRuntime(rules)
    const bus = new SignalBus()
    const params = fakeParams({ drift: base })
    runtime.queue({ type: 'key', key: ' ', edge: 'down' })
    const steps = 40
    const dt = halflife / steps // many small steps so the formula is exercised, not skipped
    // Elapsed advances *after* each frame's offset is applied (fire frame uses
    // elapsed=0), so the call that reports elapsed == halflife exactly is call
    // number steps+1.
    for (let i = 0; i < steps + 1; i++) runtime.update(dt, bus, params)
    expect(params.get('drift')).toBeCloseTo(base + amount * Math.pow(2, -1), 9)
  })

  it('13) two overlapping pulses on one param sum', () => {
    const rules: MappingRule[] = [
      {
        source: { type: 'key', key: 'a' },
        action: { type: 'pulse', param: 'p', amount: 1, halflife: 1 },
      },
      {
        source: { type: 'key', key: 'b' },
        action: { type: 'pulse', param: 'p', amount: 2, halflife: 1 },
      },
    ]
    const runtime = new MappingRuntime(rules)
    const bus = new SignalBus()
    const params = fakeParams({ p: 0 })
    runtime.queue({ type: 'key', key: 'a', edge: 'down' })
    runtime.queue({ type: 'key', key: 'b', edge: 'down' })
    runtime.update(1 / 60, bus, params)
    expect(params.get('p')).toBeCloseTo(3, 9) // both fire this frame: 1 + 2
  })

  it('14) a pulse expires once its offset falls below 0.001 * |amount| and stops applying', () => {
    const rules: MappingRule[] = [
      {
        source: { type: 'key', key: ' ' },
        action: { type: 'pulse', param: 'p', amount: 1, halflife: 0.05 },
      },
    ]
    const runtime = new MappingRuntime(rules)
    const bus = new SignalBus()
    const params = fakeParams({ p: 0 })
    runtime.queue({ type: 'key', key: ' ', edge: 'down' })
    const dt = 0.05
    for (let i = 0; i < 40; i++) runtime.update(dt, bus, params)
    const valueAtExpiry = params.get('p')
    expect(valueAtExpiry).toBeGreaterThan(0)
    expect(valueAtExpiry).toBeLessThan(0.001)
    // Further frames must not change it any more (pulse has been removed).
    runtime.update(dt, bus, params)
    expect(params.get('p')).toBe(valueAtExpiry)
  })
})

// --- 6. reset() ----------------------------------------------------------------------

describe('reset()', () => {
  it('15) clears held keys — a re-press after reset starts from the down-edge, not held state', () => {
    const runtime = new MappingRuntime([])
    const bus = new SignalBus()
    const params = fakeParams()
    runtime.queue({ type: 'key', key: 'x', edge: 'down' })
    runtime.update(1 / 60, bus, params)
    expect(bus.get('key.x')).toBe(1)
    runtime.reset()
    // Cold-start semantics: the runtime forgets the key entirely and publishes
    // nothing until an input actually occurs (clearing stale bus values on reset
    // is the engine's job, alongside bus/scene state). A fresh down-edge then
    // publishes 1 again — proving the held state didn't survive.
    const fresh = new SignalBus()
    runtime.update(1 / 60, fresh, params)
    expect(fresh.has('key.x')).toBe(false)
    runtime.queue({ type: 'key', key: 'x', edge: 'down' })
    runtime.update(1 / 60, fresh, params)
    expect(fresh.get('key.x')).toBe(1)
  })

  it('16) clears active ramps — an in-progress ramp stops advancing', () => {
    const rules: MappingRule[] = [
      {
        source: { type: 'key', key: 'f' },
        action: { type: 'ramp', param: 'p', target: 1, duration: 1 },
      },
    ]
    const runtime = new MappingRuntime(rules)
    const bus = new SignalBus()
    const params = fakeParams({ p: 0 })
    runtime.queue({ type: 'key', key: 'f', edge: 'down' })
    runtime.update(0.25, bus, params)
    const midValue = params.get('p')
    expect(midValue).toBeGreaterThan(0)
    runtime.reset()
    runtime.update(0.25, bus, params)
    expect(params.get('p')).toBe(midValue) // no further ramp progress applied
  })

  it('17) clears active pulses — a decaying pulse stops contributing', () => {
    const rules: MappingRule[] = [
      {
        source: { type: 'key', key: ' ' },
        action: { type: 'pulse', param: 'p', amount: 1, halflife: 1 },
      },
    ]
    const runtime = new MappingRuntime(rules)
    const bus = new SignalBus()
    const params = fakeParams({ p: 0 })
    runtime.queue({ type: 'key', key: ' ', edge: 'down' })
    runtime.update(1 / 60, bus, params)
    const midValue = params.get('p')
    runtime.reset()
    runtime.update(1 / 60, bus, params)
    expect(params.get('p')).toBe(midValue) // pulse no longer active, no more deltas
  })
})

// --- 7. Determinism ----------------------------------------------------------------

describe('determinism', () => {
  it('18) two runtimes fed identical event/update sequences produce identical params.set calls', () => {
    const rules: MappingRule[] = [
      { source: { type: 'key', key: '1' }, action: { type: 'set', param: 'freqX', value: 1 } },
      {
        source: { type: 'key', key: ' ' },
        action: { type: 'pulse', param: 'drift', amount: 1.2, halflife: 0.4 },
      },
      {
        source: { type: 'key', key: 'f' },
        action: { type: 'ramp', param: 'trail', target: 0.35, duration: 0.15 },
      },
      {
        source: { type: 'trigger', index: 1 },
        action: { type: 'pulse', param: 'hueSpeed', amount: 0.6, halflife: 0.5 },
      },
    ]

    const script: Array<{ before?: SourceEvent[]; dt: number }> = [
      { before: [{ type: 'key', key: '1', edge: 'down' }], dt: 1 / 30 },
      { dt: 1 / 30 },
      { before: [{ type: 'key', key: 'f', edge: 'down' }], dt: 1 / 30 },
      { dt: 1 / 30 },
      { before: [{ type: 'trigger', index: 1 }, { type: 'key', key: ' ', edge: 'down' }], dt: 1 / 30 },
      { dt: 1 / 30 },
      { dt: 1 / 30 },
      { before: [{ type: 'key', key: '1', edge: 'up' }], dt: 1 / 30 },
    ]

    const run = () => {
      const runtime = new MappingRuntime(rules)
      const bus = new SignalBus()
      const params = fakeParams({ freqX: 3, drift: 0.35, trail: 0.08, hueSpeed: 0.12 })
      for (const step of script) {
        for (const e of step.before ?? []) runtime.queue(e)
        runtime.update(step.dt, bus, params)
      }
      return params.calls
    }

    expect(run()).toEqual(run())
  })
})

// --- 8. keyboard.ts frontend ---------------------------------------------------------

/** Minimal fake `Window` that captures addEventListener handlers. */
function fakeWindow() {
  const handlers = new Map<string, Set<(e: unknown) => void>>()
  return {
    addEventListener: (type: string, handler: (e: unknown) => void) => {
      const set = handlers.get(type) ?? new Set()
      set.add(handler)
      handlers.set(type, set)
    },
    removeEventListener: (type: string, handler: (e: unknown) => void) => {
      handlers.get(type)?.delete(handler)
    },
    dispatch: (type: string, event: unknown) => {
      for (const h of handlers.get(type) ?? []) h(event)
    },
  }
}

function fakeKeyboardEvent(key: string, opts: { repeat?: boolean; target?: unknown } = {}) {
  return { key, repeat: opts.repeat ?? false, target: opts.target ?? { tagName: 'DIV' } }
}

describe('attachKeyboard', () => {
  it('19) queues lowercased key down/up events', () => {
    const win = fakeWindow()
    const events: SourceEvent[] = []
    attachKeyboard(win as unknown as Window, (e) => events.push(e))
    win.dispatch('keydown', fakeKeyboardEvent('A'))
    win.dispatch('keyup', fakeKeyboardEvent('A'))
    expect(events).toEqual([
      { type: 'key', key: 'a', edge: 'down' },
      { type: 'key', key: 'a', edge: 'up' },
    ])
  })

  it('20) ignores OS auto-repeat keydowns', () => {
    const win = fakeWindow()
    const events: SourceEvent[] = []
    attachKeyboard(win as unknown as Window, (e) => events.push(e))
    win.dispatch('keydown', fakeKeyboardEvent('a', { repeat: true }))
    expect(events).toHaveLength(0)
  })

  it('21) ignores keystrokes targeting input/textarea elements', () => {
    const win = fakeWindow()
    const events: SourceEvent[] = []
    attachKeyboard(win as unknown as Window, (e) => events.push(e))
    win.dispatch('keydown', fakeKeyboardEvent('a', { target: { tagName: 'INPUT' } }))
    win.dispatch('keydown', fakeKeyboardEvent('a', { target: { tagName: 'TEXTAREA' } }))
    win.dispatch('keydown', fakeKeyboardEvent('a', { target: { tagName: 'DIV' } }))
    expect(events).toEqual([{ type: 'key', key: 'a', edge: 'down' }])
  })

  it('22) detach() stops further events from being queued', () => {
    const win = fakeWindow()
    const events: SourceEvent[] = []
    const detach = attachKeyboard(win as unknown as Window, (e) => events.push(e))
    detach()
    win.dispatch('keydown', fakeKeyboardEvent('a'))
    expect(events).toHaveLength(0)
  })
})

// --- 7. Review follow-ups: pulse composition with external overwrites ------------

describe('pulse composition (review follow-ups)', () => {
  const rules: MappingRule[] = [
    { source: { type: 'key', key: 'p' }, action: { type: 'pulse', param: 'drift', amount: 1, halflife: 0.4 } },
  ]

  it('23) pulse on a binding-overwritten param decays onto the base, never below it', () => {
    const runtime = new MappingRuntime(rules)
    const bus = new SignalBus()
    const params = fakeParams({ drift: 2 })
    const dt = 1 / 60
    runtime.queue({ type: 'key', key: 'p', edge: 'down' })

    let elapsed = 0
    const observed: number[] = []
    for (let f = 0; f < 30; f++) {
      // Simulate an expression binding: it rewrites the param to base=2 every
      // frame BEFORE the mapping update (matching Engine.updateAndRender order).
      params.set('drift', 2)
      runtime.update(dt, bus, params)
      observed.push(params.get('drift'))
      const expected = 2 + Math.pow(2, -elapsed / 0.4)
      expect(params.get('drift')).toBeCloseTo(expected, 9)
      expect(params.get('drift')).toBeGreaterThanOrEqual(2)
      elapsed += dt
    }
    // Sanity: it actually decays.
    expect(observed[0]).toBeCloseTo(3, 9)
    expect(observed[29]).toBeLessThan(observed[0])
  })

  it('24) pulse on an unbound param still telescopes exactly (no geometric runaway)', () => {
    const runtime = new MappingRuntime(rules)
    const bus = new SignalBus()
    const params = fakeParams({ drift: 2 })
    const dt = 1 / 60
    runtime.queue({ type: 'key', key: 'p', edge: 'down' })
    let elapsed = 0
    for (let f = 0; f < 30; f++) {
      runtime.update(dt, bus, params)
      expect(params.get('drift')).toBeCloseTo(2 + Math.pow(2, -elapsed / 0.4), 9)
      elapsed += dt
    }
  })

  it('25) pulse with halflife 0 applies once and never produces NaN', () => {
    const runtime = new MappingRuntime([
      { source: { type: 'key', key: 'p' }, action: { type: 'pulse', param: 'x', amount: 0.5, halflife: 0 } },
    ])
    const bus = new SignalBus()
    const params = fakeParams({ x: 1 })
    runtime.queue({ type: 'key', key: 'p', edge: 'down' })
    runtime.update(1 / 60, bus, params)
    expect(params.get('x')).toBeCloseTo(1.5, 12)
    runtime.update(1 / 60, bus, params)
    expect(params.get('x')).toBeCloseTo(1, 12)
    for (let f = 0; f < 5; f++) {
      runtime.update(1 / 60, bus, params)
      expect(Number.isFinite(params.get('x'))).toBe(true)
    }
    expect(params.get('x')).toBeCloseTo(1, 12)
  })

  it('26) reset() also forgets known key/trigger signals (cold-start bus contents)', () => {
    const runtime = new MappingRuntime([])
    const params = fakeParams()
    const before = new SignalBus()
    runtime.queue({ type: 'key', key: 'x', edge: 'down' })
    runtime.queue({ type: 'trigger', index: 2 })
    runtime.update(1 / 60, before, params)
    expect(before.has('key.x')).toBe(true)
    expect(before.has('trig.2')).toBe(true)

    runtime.reset()
    const after = new SignalBus()
    runtime.update(1 / 60, after, params)
    expect(after.has('key.x')).toBe(false)
    expect(after.has('trig.2')).toBe(false)
  })
})

// --- 8. setPadTargets (Pads/PERFORM batch: positional pad targeting) -------------

describe('setPadTargets', () => {
  it('28) pad T_n (trigger index n-1) pulses the scene param at position n-1', () => {
    const runtime = new MappingRuntime([])
    const bus = new SignalBus()
    const params = fakeParams({ a: 0, b: 0, c: 0, d: 0 })
    runtime.setPadTargets([param('a', 0, 1), param('b', 0, 1), param('c', 0, 1), param('d', 0, 1)])

    runtime.queue({ type: 'trigger', index: 2 }) // T3 -> 'c' (0-based index 2)
    runtime.update(1 / 60, bus, params)

    expect(params.get('c')).toBeGreaterThan(0)
    expect(params.get('a')).toBe(0)
    expect(params.get('b')).toBe(0)
    expect(params.get('d')).toBe(0)
  })

  it('29) pulse amount is exactly 0.3 * (max - min), full amount on the fire frame', () => {
    const runtime = new MappingRuntime([])
    const bus = new SignalBus()
    const params = fakeParams({ p: 5 })
    runtime.setPadTargets([param('p', 2, 22)]) // range 20 -> amount 6
    runtime.queue({ type: 'trigger', index: 0 })
    runtime.update(1 / 60, bus, params)
    expect(params.get('p')).toBeCloseTo(5 + 0.3 * 20, 9)
  })

  it('30) fewer than 4 params yields fewer rules — spare pads are inert', () => {
    const runtime = new MappingRuntime([])
    const bus = new SignalBus()
    const params = fakeParams({ a: 1, b: 1 })
    runtime.setPadTargets([param('a', 0, 10), param('b', 0, 10)])

    // T3/T4 (indices 2, 3) have no backing param — pressing them changes nothing.
    runtime.queue({ type: 'trigger', index: 2 })
    runtime.queue({ type: 'trigger', index: 3 })
    runtime.update(1 / 60, bus, params)
    expect(params.get('a')).toBe(1)
    expect(params.get('b')).toBe(1)
    expect(params.calls).toHaveLength(0)

    // T1/T2 still work.
    runtime.queue({ type: 'trigger', index: 0 })
    runtime.update(1 / 60, bus, params)
    expect(params.get('a')).toBeGreaterThan(1)
  })

  it('31) keyboard rules are untouched by a pad retarget', () => {
    const rules: MappingRule[] = [
      { source: { type: 'key', key: '1' }, action: { type: 'set', param: 'freqX', value: 4 } },
    ]
    const runtime = new MappingRuntime(rules)
    const bus = new SignalBus()
    const params = fakeParams({ freqX: 0 })
    runtime.setPadTargets([param('a', 0, 1)])

    runtime.queue({ type: 'key', key: '1', edge: 'down' })
    runtime.update(1 / 60, bus, params)
    expect(params.get('freqX')).toBe(4)
  })

  it('32) idempotent: calling it twice with the same schema does not double-fire a pad', () => {
    const runtime = new MappingRuntime([])
    const bus = new SignalBus()
    const params = fakeParams({ p: 0 })
    const schema = [param('p', 0, 10)]
    runtime.setPadTargets(schema)
    runtime.setPadTargets(schema) // repeated call — must replace, not accumulate

    runtime.queue({ type: 'trigger', index: 0 })
    runtime.update(1 / 60, bus, params)
    expect(params.get('p')).toBeCloseTo(0.3 * 10, 9) // exactly one pulse's worth, not two
  })

  it('33) retargeting to a new schema replaces the old rule outright (no leftover old-param rule)', () => {
    const runtime = new MappingRuntime([])
    const bus = new SignalBus()
    const params = fakeParams({ old: 0, fresh: 0 })
    runtime.setPadTargets([param('old', 0, 10)])
    runtime.setPadTargets([param('fresh', 0, 10)]) // scene switch: index 0 now targets 'fresh'

    runtime.queue({ type: 'trigger', index: 0 })
    runtime.update(1 / 60, bus, params)
    expect(params.get('old')).toBe(0)
    expect(params.get('fresh')).toBeGreaterThan(0)
  })
})

// --- 9. pulseOffset (session-snapshot support) -----------------------------------

describe('pulseOffset', () => {
  it('27) reports the summed live pulse contribution, 0 when idle or expired', () => {
    const runtime = new MappingRuntime([
      { source: { type: 'key', key: 'p' }, action: { type: 'pulse', param: 'drift', amount: 1, halflife: 0.4 } },
      { source: { type: 'key', key: 'q' }, action: { type: 'pulse', param: 'drift', amount: 0.5, halflife: 0.4 } },
    ])
    const bus = new SignalBus()
    const params = fakeParams({ drift: 2 })
    expect(runtime.pulseOffset('drift')).toBe(0)

    runtime.queue({ type: 'key', key: 'p', edge: 'down' })
    runtime.queue({ type: 'key', key: 'q', edge: 'down' })
    runtime.update(1 / 60, bus, params)
    // Both pulses fired this frame: applied = full amounts, param = base + 1.5.
    expect(runtime.pulseOffset('drift')).toBeCloseTo(1.5, 9)
    expect(params.get('drift') - runtime.pulseOffset('drift')).toBeCloseTo(2, 9)
    expect(runtime.pulseOffset('other')).toBe(0)

    // The base reconstruction holds mid-decay too.
    for (let f = 0; f < 30; f++) runtime.update(1 / 60, bus, params)
    expect(params.get('drift') - runtime.pulseOffset('drift')).toBeCloseTo(2, 9)
  })
})
