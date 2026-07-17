import { describe, expect, it } from 'vitest'
import { MacroRouter, MACRO_SLOT_COUNT } from '../../src/engine/macroRouter'
import type { ParamSchema } from '../../src/scenes/types'

/**
 * docs/MACROS.md: unit tests for the MacroRouter as an extracted, engine-free
 * module (no Engine/scene mock needed — `route`/`isDriven` only ever take
 * plain `ParamSchema[]` + closures, per the module's own docstring on why).
 */

function params(n: number): ParamSchema[] {
  const out: ParamSchema[] = []
  for (let i = 0; i < n; i++) {
    out.push({ name: `p${i}`, label: `P${i}`, min: 0, max: 10, default: 0 })
  }
  return out
}

/** A fake `setParam` that records every call, for assertions. */
function fakeSetParam() {
  const calls: Array<{ name: string; value: number }> = []
  return { setParam: (name: string, value: number) => calls.push({ name, value }), calls }
}

describe('MacroRouter', () => {
  it('1) a fresh router has every slot disengaged — route() is a no-op with no prior noteSignal', () => {
    const router = new MacroRouter()
    const { setParam, calls } = fakeSetParam()
    router.route(params(3), () => false, () => 1, setParam)
    expect(calls).toEqual([])
  })

  it('2) noteSignal("ctl.N") engages slot N-1; route() then drives that positional param', () => {
    const router = new MacroRouter()
    router.noteSignal('ctl.1')
    const { setParam, calls } = fakeSetParam()
    router.route(params(3), () => false, (slot) => (slot === 1 ? 0.5 : 0), setParam)
    // param p0 (index 0, slot 1), min 0 max 10 -> 0 + 0.5*10 = 5
    expect(calls).toEqual([{ name: 'p0', value: 5 }])
  })

  it('3) noteSignal ignores non-ctl signal names entirely', () => {
    const router = new MacroRouter()
    router.noteSignal('bass')
    router.noteSignal('midi.cc.1')
    router.noteSignal('ctl.0') // out of range (slots are 1-8, not 0)
    router.noteSignal('ctl.9') // out of range
    const { setParam, calls } = fakeSetParam()
    router.route(params(8), () => false, () => 1, setParam)
    expect(calls).toEqual([])
  })

  it('4) pickup semantics: reset() dormant a previously-engaged slot until a NEW ctl.N arrives', () => {
    const router = new MacroRouter()
    router.noteSignal('ctl.1')
    router.reset()
    const { setParam, calls } = fakeSetParam()
    router.route(params(1), () => false, () => 0.9, setParam)
    expect(calls).toEqual([]) // dormant post-reset — no setParam call at all
    router.noteSignal('ctl.1') // fresh event after reset re-engages it
    router.route(params(1), () => false, () => 0.9, setParam)
    expect(calls).toEqual([{ name: 'p0', value: 9 }])
  })

  it('5) a user-bound param is skipped by the router even while its slot is engaged', () => {
    const router = new MacroRouter()
    router.noteSignal('ctl.1')
    const { setParam, calls } = fakeSetParam()
    router.route(params(1), (name) => name === 'p0', () => 1, setParam)
    expect(calls).toEqual([])
  })

  it('6) a 5-param scene ignores slots 6-8: engaging them drives nothing (no params[i])', () => {
    const router = new MacroRouter()
    for (let i = 1; i <= MACRO_SLOT_COUNT; i++) router.noteSignal(`ctl.${i}`)
    const { setParam, calls } = fakeSetParam()
    router.route(params(5), () => false, () => 1, setParam)
    expect(calls.map((c) => c.name).sort()).toEqual(['p0', 'p1', 'p2', 'p3', 'p4'])
  })

  it('7) range-maps ctl(slot) onto [min,max] per param, independent of other params', () => {
    const router = new MacroRouter()
    router.noteSignal('ctl.1')
    router.noteSignal('ctl.2')
    const schema: ParamSchema[] = [
      { name: 'a', label: 'A', min: -5, max: 5, default: 0 },
      { name: 'b', label: 'B', min: 100, max: 200, default: 100 },
    ]
    const { setParam, calls } = fakeSetParam()
    router.route(schema, () => false, (slot) => (slot === 1 ? 0 : 1), setParam)
    expect(calls).toEqual([
      { name: 'a', value: -5 }, // slot 1 ctl=0 -> min
      { name: 'b', value: 200 }, // slot 2 ctl=1 -> max
    ])
  })

  it('8) step-snaps the range-mapped value identically to RotaryKnob\'s commit formula', () => {
    const router = new MacroRouter()
    router.noteSignal('ctl.1')
    const schema: ParamSchema[] = [{ name: 'freqX', label: 'X', min: 1, max: 12, default: 3, step: 1 }]
    const { setParam, calls } = fakeSetParam()
    // ctl=0.5 -> raw = 1 + 0.5*11 = 6.5 -> snaps to step=1 -> round((6.5-1)/1)*1+1 = 7
    router.route(schema, () => false, () => 0.5, setParam)
    expect(calls).toEqual([{ name: 'freqX', value: 7 }])
  })

  it('9) a schema with no step passes the range-mapped value through unsnapped', () => {
    const router = new MacroRouter()
    router.noteSignal('ctl.1')
    const schema: ParamSchema[] = [{ name: 'drift', label: 'Drift', min: 0, max: 2, default: 0.35 }]
    const { setParam, calls } = fakeSetParam()
    router.route(schema, () => false, () => 0.3, setParam)
    expect(calls).toEqual([{ name: 'drift', value: 0.6 }])
  })

  it('10) isDriven is true only for an engaged slot whose param has no binding', () => {
    const router = new MacroRouter()
    router.noteSignal('ctl.1')
    const schema = params(2)
    expect(router.isDriven(0, schema, () => false)).toBe(true) // engaged, unbound
    expect(router.isDriven(0, schema, (n) => n === 'p0')).toBe(false) // engaged but bound
    expect(router.isDriven(1, schema, () => false)).toBe(false) // slot 2 never engaged
  })

  it('11) isDriven is false for an out-of-range index or a missing param at that index', () => {
    const router = new MacroRouter()
    router.noteSignal('ctl.1')
    expect(router.isDriven(-1, params(2), () => false)).toBe(false)
    expect(router.isDriven(MACRO_SLOT_COUNT, params(2), () => false)).toBe(false)
    expect(router.isDriven(0, params(0), () => false)).toBe(false) // engaged slot, but no param at all
  })

  it('13) edge-triggered: an unchanged ctl value routes once, not every frame (UI edits stick)', () => {
    const router = new MacroRouter()
    router.noteSignal('ctl.1')
    const { setParam, calls } = fakeSetParam()
    router.route(params(1), () => false, () => 0.5, setParam)
    router.route(params(1), () => false, () => 0.5, setParam) // same value again — no re-assert
    expect(calls).toEqual([{ name: 'p0', value: 5 }])
    router.route(params(1), () => false, () => 0.7, setParam) // hardware actually moved
    expect(calls).toEqual([
      { name: 'p0', value: 5 },
      { name: 'p0', value: 7 },
    ])
  })

  it('14) reset() clears the edge memory: the same ctl value routes again after re-engagement', () => {
    const router = new MacroRouter()
    router.noteSignal('ctl.1')
    const { setParam, calls } = fakeSetParam()
    router.route(params(1), () => false, () => 0.5, setParam)
    router.reset()
    router.noteSignal('ctl.1')
    router.route(params(1), () => false, () => 0.5, setParam)
    expect(calls).toEqual([
      { name: 'p0', value: 5 },
      { name: 'p0', value: 5 },
    ])
  })

  it('15) a bound param does not consume the edge: clearing the binding lets the value land', () => {
    const router = new MacroRouter()
    router.noteSignal('ctl.1')
    const { setParam, calls } = fakeSetParam()
    router.route(params(1), () => true, () => 0.5, setParam) // bound: skipped, edge NOT consumed
    expect(calls).toEqual([])
    router.route(params(1), () => false, () => 0.5, setParam) // binding cleared: pending value lands
    expect(calls).toEqual([{ name: 'p0', value: 5 }])
  })

  it('12) engagement only ever turns on across a stream of noteSignal calls, never off (short of reset)', () => {
    const router = new MacroRouter()
    router.noteSignal('ctl.3')
    router.noteSignal('ctl.3') // repeated arrivals stay engaged, not toggled
    const { setParam, calls } = fakeSetParam()
    router.route(params(3), () => false, (slot) => (slot === 3 ? 1 : 0), setParam)
    expect(calls).toEqual([{ name: 'p2', value: 10 }])
  })
})
