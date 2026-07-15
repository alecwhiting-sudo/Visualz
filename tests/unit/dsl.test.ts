import { describe, expect, it } from 'vitest'
import { noise } from '../../src/dsl/builtins'
import { compile, type EvalEnv } from '../../src/dsl/compile'
import { DslError } from '../../src/dsl/parse'
import { DslState } from '../../src/dsl/state'

// --- Test harness (see docs/DSL.md §10) -----------------------------------

function signalsStub(map: Record<string, number>) {
  return { get: (n: string, f = 0) => map[n] ?? f }
}

interface EnvPartial {
  time?: number
  dt?: number
  frame?: number
  signals?: Record<string, number>
}

/** Compiles with a fresh DslState and evaluates one frame. */
function EVAL(src: string, envPartial: EnvPartial = {}): number {
  const compiled = compile(src, 'test')
  const env: EvalEnv = {
    time: envPartial.time ?? 0,
    dt: envPartial.dt ?? 1 / 60,
    frame: envPartial.frame ?? 0,
    signals: signalsStub(envPartial.signals ?? {}),
    state: new DslState(),
  }
  return compiled.evaluate(env)
}

/** Compiles once, one DslState, evaluates consecutive frames at fixed dt. */
function SEQ(src: string, framesOfSignals: Record<string, number>[], dt = 1 / 60): number[] {
  const compiled = compile(src, 'test')
  const state = new DslState()
  const out: number[] = []
  for (let i = 0; i < framesOfSignals.length; i++) {
    const env: EvalEnv = {
      time: i * dt,
      dt,
      frame: i,
      signals: signalsStub(framesOfSignals[i]),
      state,
    }
    out.push(compiled.evaluate(env))
  }
  return out
}

/** Asserts DslError thrown by compile(), with a message substring and sane offsets. */
function ERR(src: string, msgSubstring: string): void {
  let threw = false
  try {
    compile(src, 'test')
  } catch (e) {
    threw = true
    expect(e).toBeInstanceOf(DslError)
    const err = e as DslError
    expect(err.message).toContain(msgSubstring)
    expect(err.start).toBeGreaterThanOrEqual(0)
    expect(err.start).toBeLessThanOrEqual(err.end)
    expect(err.end).toBeLessThanOrEqual(src.length)
  }
  expect(threw).toBe(true)
}

// --- 1. Literals / arithmetic / precedence ---------------------------------

describe('literals, arithmetic, precedence', () => {
  it('1) integer literal', () => expect(EVAL('1')).toBe(1))
  it('2) exponent literal', () => expect(EVAL('1.5e2')).toBe(150))
  it('3) leading-dot literal', () => expect(EVAL('.5')).toBe(0.5))
  it('4) precedence: * before +', () => expect(EVAL('1 + 2 * 3')).toBe(7))
  it('5) parens override precedence', () => expect(EVAL('(1 + 2) * 3')).toBe(9))
  it('6) left-to-right at equal precedence', () => expect(EVAL('2 * 3 + 4 * 5')).toBe(26))
  it('7) unary minus binds tighter than *', () => expect(EVAL('-2 * 3')).toBe(-6))
  it('8) unary minus on right operand', () => expect(EVAL('2 * -3')).toBe(-6))
  it('9) double negation', () => expect(EVAL('--3')).toBe(3))
  it('10) division', () => expect(EVAL('7 / 2')).toBe(3.5))
  it('11) division by zero guards to 0', () => expect(EVAL('1 / 0')).toBe(0))
  it('12) modulo', () => expect(EVAL('5 % 3')).toBe(2))
  it('13) floor-based modulo of negative', () => expect(EVAL('-1 % 3')).toBe(2))
  it('14) fractional modulo', () => expect(EVAL('5.5 % 2')).toBe(1.5))
  it('15) modulo by zero guards to 0', () => expect(EVAL('1 % 0')).toBe(0))
})

// --- 2. Comparisons / logical / ternary -------------------------------------

describe('comparisons, logical, ternary', () => {
  it('16) greater-than true', () => expect(EVAL('2 > 1')).toBe(1))
  it('17) less-than false', () => expect(EVAL('2 < 1')).toBe(0))
  it('18) greater-or-equal true', () => expect(EVAL('2 >= 2')).toBe(1))
  it('19) equal true', () => expect(EVAL('1 == 1')).toBe(1))
  it('20) not-equal false', () => expect(EVAL('1 != 1')).toBe(0))
  it('21) logical not', () => {
    expect(EVAL('!0')).toBe(1)
    expect(EVAL('!5')).toBe(0)
  })
  it('22) logical and', () => {
    expect(EVAL('1 && 0')).toBe(0)
    expect(EVAL('1 && 2')).toBe(1)
  })
  it('23) && binds tighter than ||', () => expect(EVAL('0 || 1 && 0')).toBe(0))
  it('24) relational then equality', () => expect(EVAL('1 < 2 == 1')).toBe(1))
  it('25) ternary', () => {
    expect(EVAL('1 ? 2 : 3')).toBe(2)
    expect(EVAL('0 ? 2 : 3')).toBe(3)
  })
  it('26) right-associative nested ternary', () => expect(EVAL('1 ? 2 : 3 ? 4 : 5')).toBe(2))
})

// --- 3. Signals / env --------------------------------------------------------

describe('signals and env', () => {
  it('27) known signal read', () => expect(EVAL('bass', { signals: { bass: 0.7 } })).toBe(0.7))
  it('28) unknown signal reads as 0', () => expect(EVAL('unknownSig')).toBe(0))
  it('29) dotted signal name', () =>
    expect(EVAL('midi.cc.3', { signals: { 'midi.cc.3': 0.4 } })).toBe(0.4))
  it('30) reserved env values', () => {
    expect(EVAL('time*2', { time: 1.5 })).toBe(3)
    expect(EVAL('frame', { frame: 9 })).toBe(9)
    expect(EVAL('dt', { dt: 1 / 60 })).toBeCloseTo(0.0166667, 5)
  })
  it('31) signalRefs, first-appearance order, de-duplicated', () => {
    const compiled = compile('0.5 + bass*mid + bass', 'test')
    expect(compiled.signalRefs).toEqual(['bass', 'mid'])
  })
})

// --- 4. Pure builtins ---------------------------------------------------------

describe('pure builtins', () => {
  it('32) trig', () => {
    expect(EVAL('sin(0)')).toBe(0)
    expect(EVAL('cos(0)')).toBe(1)
    expect(EVAL('sin(pi/2)')).toBeCloseTo(1, 6)
  })
  it('33) abs, sign', () => {
    expect(EVAL('abs(-3)')).toBe(3)
    expect(EVAL('sign(-2)')).toBe(-1)
    expect(EVAL('sign(0)')).toBe(0)
  })
  it('34) floor, ceil, fract', () => {
    expect(EVAL('floor(2.7)')).toBe(2)
    expect(EVAL('ceil(2.1)')).toBe(3)
    expect(EVAL('fract(2.75)')).toBeCloseTo(0.75, 6)
  })
  it('35) min, max', () => {
    expect(EVAL('min(3,5)')).toBe(3)
    expect(EVAL('max(3,5)')).toBe(5)
  })
  it('36) clamp', () => {
    expect(EVAL('clamp(5, 0, 1)')).toBe(1)
    expect(EVAL('clamp(-1,0,1)')).toBe(0)
    expect(EVAL('clamp(0.3,0,1)')).toBeCloseTo(0.3, 6)
  })
  it('37) mix (unclamped)', () => {
    expect(EVAL('mix(0,10,0.25)')).toBeCloseTo(2.5, 6)
    expect(EVAL('mix(0,10,1.5)')).toBe(15)
  })
  it('38) step', () => {
    expect(EVAL('step(0.5, 0.4)')).toBe(0)
    expect(EVAL('step(0.5, 0.6)')).toBe(1)
  })
  it('39) smoothstep', () => {
    expect(EVAL('smoothstep(0,1,0.5)')).toBeCloseTo(0.5, 6)
    expect(EVAL('smoothstep(0,1,-1)')).toBe(0)
    expect(EVAL('smoothstep(0,1,2)')).toBe(1)
    expect(EVAL('smoothstep(0.2,0.8,0.5)')).toBeCloseTo(0.5, 6)
  })
  it('40) smoothstep with e0==e1', () => {
    expect(EVAL('smoothstep(1,1,2)')).toBe(1)
    expect(EVAL('smoothstep(1,1,0)')).toBe(0)
  })
  it('41) pow, sqrt guards', () => {
    expect(EVAL('pow(2,10)')).toBe(1024)
    expect(EVAL('pow(-2,0.5)')).toBe(0)
    expect(EVAL('sqrt(-4)')).toBe(0)
    expect(EVAL('sqrt(9)')).toBe(3)
  })
  it('42) log, exp guards', () => {
    expect(EVAL('log(0)')).toBe(0)
    expect(EVAL('exp(0)')).toBe(1)
    expect(EVAL('exp(1000)')).toBe(0)
  })
  it('43) noise reference values', () => {
    expect(EVAL('noise(0)')).toBeCloseTo(-0.984469733, 6)
    expect(EVAL('noise(1)')).toBeCloseTo(0.244639182, 6)
    expect(EVAL('noise(2.5)')).toBeCloseTo(-0.909502386, 6)
    expect(EVAL('noise(-1)')).toBeCloseTo(0.288804224, 6)
  })
  it('44) noise is C1-continuous across the integer boundary', () => {
    expect(Math.abs(noise(0.9999999) - noise(1.0000001))).toBeLessThan(1e-4)
  })
  it('45) noise stays within [-1, 1]', () => {
    for (let x = -50; x <= 50; x += 0.1) {
      const v = noise(x)
      expect(v).toBeGreaterThanOrEqual(-1)
      expect(v).toBeLessThanOrEqual(1)
    }
  })
})

// --- 5. Stateful helpers ------------------------------------------------------

describe('stateful helpers', () => {
  it('46) smooth sequence', () => {
    const out = SEQ('smooth(x, 0.3)', [{ x: 1 }, { x: 0 }, { x: 0 }, { x: 0 }])
    expect(out[0]).toBe(1)
    expect(out[1]).toBeCloseTo(0.962223837, 6)
    expect(out[2]).toBeCloseTo(0.925874712, 6)
    expect(out[3]).toBeCloseTo(0.890898718, 6)
  })

  it('47) framerate-independent half-life', () => {
    const framesFast = [{ x: 1 }, ...Array.from({ length: 18 }, () => ({ x: 0 }))]
    const framesSlow = [{ x: 1 }, ...Array.from({ length: 9 }, () => ({ x: 0 }))]
    const fast = SEQ('smooth(x, 0.3)', framesFast, 1 / 60)
    const slow = SEQ('smooth(x, 0.3)', framesSlow, 1 / 30)
    expect(fast[fast.length - 1]).toBeCloseTo(0.5, 9)
    expect(slow[slow.length - 1]).toBeCloseTo(0.5, 9)
    expect(Math.abs(fast[fast.length - 1] - slow[slow.length - 1])).toBeLessThan(1e-9)
  })

  it('48) smooth with halflife 0 tracks input instantly', () => {
    const out = SEQ('smooth(x, 0)', [{ x: 1 }, { x: 5 }])
    expect(out).toEqual([1, 5])
  })

  it('49) env sequence', () => {
    const out = SEQ('env(0.01, 0.3, onset)', [
      { onset: 1 },
      { onset: 1 },
      { onset: 0 },
      { onset: 0 },
    ])
    expect(out[0]).toBeCloseTo(0.685019738, 6)
    expect(out[1]).toBeCloseTo(0.900787434, 6)
    expect(out[2]).toBeCloseTo(0.866759141, 6)
    expect(out[3]).toBeCloseTo(0.834016307, 6)
  })

  it('50) env with attack 0 snaps immediately', () => {
    expect(EVAL('env(0, 0.3, onset)', { signals: { onset: 1 } })).toBe(1)
  })

  it('51) lfo sequence', () => {
    const out = SEQ('lfo(1)', [{}, {}, {}, {}])
    expect(out[0]).toBeCloseTo(0.552264232, 6)
    expect(out[1]).toBeCloseTo(0.603955845, 6)
    expect(out[2]).toBeCloseTo(0.654508497, 6)
    expect(out[3]).toBeCloseTo(0.703368322, 6)
  })

  it('52) lfo(1) after 60 frames of dt=1/60 wraps to phase 0', () => {
    const out = SEQ(
      'lfo(1)',
      Array.from({ length: 60 }, () => ({})),
    )
    expect(out[59]).toBeCloseTo(0.5, 6)
  })

  it('53) lfo(0.25) frame 0', () => {
    expect(EVAL('lfo(0.25)')).toBeCloseTo(0.513088474, 6)
  })

  it('54) two independent smooth slots', () => {
    expect(EVAL('smooth(a,0.1) - smooth(b,0.1)', { signals: { a: 1, b: 0 } })).toBe(1)
  })

  it('55) nested stateful: inner advances before outer reads it', () => {
    expect(EVAL('smooth(lfo(1), 0.001)')).toBeCloseTo(0.552264232, 3)
  })
})

// --- 6. Eager branching / determinism / reset ----------------------------------

describe('eager branching, determinism, reset', () => {
  it('56) untaken ternary branch still advances its stateful helper', () => {
    const out = SEQ('cond > 0.5 ? lfo(1) : 0', [
      { cond: 0 },
      { cond: 0 },
      { cond: 0 },
      { cond: 1 },
    ])
    expect(out[3]).toBeCloseTo(0.703368322, 6)
  })

  it('57) both ternary branches get distinct slots and both advance', () => {
    const both = SEQ('0 ? lfo(1) : lfo(1)', [{}, {}, {}, {}])
    const lone = SEQ('lfo(1)', [{}, {}, {}, {}])
    for (let i = 0; i < 4; i++) expect(both[i]).toBeCloseTo(lone[i], 9)
  })

  it('58) two independent compiles driven identically produce identical output', () => {
    const src = '0.5 + bass*env(0.01,0.3,onset) + lfo(2)'
    const a = compile(src, 'a')
    const b = compile(src, 'b')
    const stateA = new DslState()
    const stateB = new DslState()
    const dt = 1 / 60
    for (let i = 0; i < 100; i++) {
      const bass = 0.5 + 0.4 * Math.sin(i * 0.13)
      const onset = i % 10 === 0 ? 1 : 0
      const signals = signalsStub({ bass, onset })
      const envA: EvalEnv = { time: i * dt, dt, frame: i, signals, state: stateA }
      const envB: EvalEnv = { time: i * dt, dt, frame: i, signals, state: stateB }
      expect(a.evaluate(envA)).toBe(b.evaluate(envB))
    }
  })

  it('59) reset() restores frame-0 behavior', () => {
    const compiled = compile('lfo(1)', 'test')
    const state = new DslState()
    const dt = 1 / 60
    for (let i = 0; i < 30; i++) {
      compiled.evaluate({ time: i * dt, dt, frame: i, signals: signalsStub({}), state })
    }
    state.reset()
    const out: number[] = []
    for (let i = 0; i < 4; i++) {
      out.push(compiled.evaluate({ time: i * dt, dt, frame: i, signals: signalsStub({}), state }))
    }
    expect(out[0]).toBeCloseTo(0.552264232, 6)
    expect(out[1]).toBeCloseTo(0.603955845, 6)
    expect(out[2]).toBeCloseTo(0.654508497, 6)
    expect(out[3]).toBeCloseTo(0.703368322, 6)
  })

  it('60) reset() before next eval makes smooth re-snap', () => {
    const compiled = compile('smooth(x, 0.3)', 'test')
    const state = new DslState()
    const dt = 1 / 60
    for (let i = 0; i < 10; i++) {
      compiled.evaluate({ time: i * dt, dt, frame: i, signals: signalsStub({ x: 1 }), state })
    }
    state.reset()
    const v = compiled.evaluate({ time: 0, dt, frame: 0, signals: signalsStub({ x: 5 }), state })
    expect(v).toBe(5)
  })
})

// --- 7. Totality / guards --------------------------------------------------------

describe('totality and guards', () => {
  it('61) division/modulo by zero never produce NaN/Infinity', () => {
    expect(EVAL('0/0')).toBe(0)
    expect(EVAL('1/0 + 1')).toBe(1)
  })

  it('62) pow(0, -1) guards to 0 and stays finite', () => {
    const v = EVAL('pow(0, -1)')
    expect(v).toBe(0)
    expect(Number.isFinite(v)).toBe(true)
  })

  it('63) a NaN-producing stateful arg never poisons state', () => {
    const out = SEQ('smooth(1/0, 0.3)', [{}, {}, {}, {}])
    expect(out[0]).toBe(0)
    for (const v of out) {
      expect(Number.isFinite(v)).toBe(true)
      expect(v).toBe(0)
    }
  })

  it('64) pathological expressions stay finite', () => {
    // Per-op guards (pow/exp overflow, div-by-zero) plus the final boundary sanitize
    // together guarantee finiteness for every expression, even when an intermediate
    // per-op guard doesn't itself trip (e.g. pow(9,9)**9 ~= 1.97e77 is large but still
    // a representable finite float64 — it's the final sanitize that isn't even needed
    // there, only the *totality* guarantee is exercised).
    for (const src of ['pow(pow(9,9),9)', 'exp(exp(9))', '0/0*1e300', '1e300*1e300']) {
      expect(Number.isFinite(EVAL(src))).toBe(true)
    }
    // These three are additionally guarded/sanitized all the way to exactly 0.
    expect(EVAL('exp(exp(9))')).toBe(0)
    expect(EVAL('0/0*1e300')).toBe(0)
    expect(EVAL('1e300*1e300')).toBe(0)
  })
})

// --- 8. Errors --------------------------------------------------------------------

describe('errors', () => {
  it('65) empty expression', () => ERR('', 'empty expression'))
  it('66) unexpected character', () => ERR('1 @ 2', 'unexpected character'))
  it('67) expected expression', () => ERR('1 +', 'expected expression'))
  it("68) unterminated paren", () => ERR('(1 + 2', "expected ')'"))
  it('69) unexpected token', () => ERR('1 2', 'unexpected token'))
  it('70) unknown function', () => ERR('foo(1)', 'unknown function'))
  it('71) wrong arity, too many', () => ERR('sin(1, 2)', 'expects 1 argument'))
  it('72) wrong arity, too few', () => ERR('mix(1, 2)', 'expects 3 arguments'))
  it('73) builtin used as a value', () => ERR('sin + 1', 'builtin function'))
  it("74) ternary missing ':'", () => ERR('1 ? 2', "expected ':'"))
  it('75) misplaced comma', () => ERR('min(1,)', 'expected expression'))
  it("76) assignment attempt", () => ERR('x = 1', "unexpected token '='"))

  // Compile-time totality bounds (review follow-up): pathological input must produce
  // DslError, never a stack-exhaustion RangeError.
  it('77) deep nesting is a DslError, not a stack overflow', () => {
    ERR('('.repeat(1000) + '1' + ')'.repeat(1000), 'too deeply nested')
  })
  it('78) over-long source is a DslError', () => {
    ERR('1+'.repeat(3000) + '1', 'expression too long')
  })
  it('79) depth just under the cap still parses', () => {
    const depth = 200
    expect(EVAL('('.repeat(depth) + '7' + ')'.repeat(depth))).toBe(7)
  })
})
