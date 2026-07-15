/**
 * Pure builtin function table for the expression DSL — the v1 GLSL-subset builtins,
 * each 1:1 with its GLSL counterpart. Per-op guards here are layer 1 of the three-layer
 * totality strategy (docs/DSL.md §8): cheap, targeted checks where non-finites commonly
 * arise (division, domain errors, pow/exp overflow). They are not a substitute for the
 * final `Number.isFinite` sanitize in compile.ts — this table intentionally lets some
 * ops (e.g. sin/cos/tan of huge inputs) return whatever Math gives; the boundary
 * sanitize catches the rest.
 */

export interface BuiltinDef {
  arity: number
  call(args: readonly number[]): number
}

/**
 * 1-D hash value noise. 32-bit integer hash (Wellons "lowbias32"), uint32 via
 * Math.imul. Input offset by a golden-ratio constant so hash(0) != 0. Table-free and
 * transpiles verbatim to GLSL ES 3.0 (integer ops, `uint`, two's-complement cast all
 * exist), so v2 golden images stay identical to v1 CPU evaluation. Exported separately
 * so tests can exercise it directly.
 */
export function hash32(x: number): number {
  x = (x + 0x9e3779b9) >>> 0
  x ^= x >>> 16
  x = Math.imul(x, 0x7feb352d)
  x ^= x >>> 15
  x = Math.imul(x, 0x846ca68b)
  x ^= x >>> 16
  return x >>> 0
}

/** Value at lattice point `i`, in [-1, 1). */
function lattice(i: number): number {
  const u = (i | 0) >>> 0 // wrap negative to uint32
  return (hash32(u) / 4294967296) * 2 - 1
}

/** 1-D hash value noise, C1-continuous across integer boundaries. Output in [-1, 1]. */
export function noise(x: number): number {
  const i = Math.floor(x)
  const f = x - i
  const u = f * f * (3 - 2 * f) // Hermite fade
  const a = lattice(i)
  const b = lattice(i + 1)
  return a + (b - a) * u
}

export const builtins: Record<string, BuiltinDef> = {
  sin: { arity: 1, call: ([x]) => Math.sin(x) },
  cos: { arity: 1, call: ([x]) => Math.cos(x) },
  tan: { arity: 1, call: ([x]) => Math.tan(x) },
  abs: { arity: 1, call: ([x]) => Math.abs(x) },
  sign: { arity: 1, call: ([x]) => (x < 0 ? -1 : x > 0 ? 1 : 0) },
  floor: { arity: 1, call: ([x]) => Math.floor(x) },
  ceil: { arity: 1, call: ([x]) => Math.ceil(x) },
  fract: { arity: 1, call: ([x]) => x - Math.floor(x) },
  sqrt: { arity: 1, call: ([x]) => Math.sqrt(Math.max(x, 0)) },
  exp: {
    arity: 1,
    call: ([x]) => {
      const r = Math.exp(x)
      return Number.isFinite(r) ? r : 0
    },
  },
  log: { arity: 1, call: ([x]) => (x <= 0 ? 0 : Math.log(x)) },
  min: { arity: 2, call: ([a, b]) => Math.min(a, b) },
  max: { arity: 2, call: ([a, b]) => Math.max(a, b) },
  pow: {
    arity: 2,
    call: ([a, b]) => {
      const r = Math.pow(a, b)
      return Number.isFinite(r) ? r : 0
    },
  },
  mod: {
    arity: 2,
    call: ([a, b]) => (b === 0 ? 0 : a - b * Math.floor(a / b)),
  },
  step: { arity: 2, call: ([edge, x]) => (x < edge ? 0 : 1) },
  clamp: { arity: 3, call: ([x, lo, hi]) => Math.min(Math.max(x, lo), hi) },
  mix: { arity: 3, call: ([a, b, t]) => a + (b - a) * t },
  smoothstep: {
    arity: 3,
    call: ([e0, e1, x]) => {
      if (e0 === e1) return x < e0 ? 0 : 1
      const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1)
      return t * t * (3 - 2 * t)
    },
  },
  noise: { arity: 1, call: ([x]) => noise(x) },
}
