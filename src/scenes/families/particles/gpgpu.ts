/**
 * Shared helpers for the particles family (docs/PARTICLES.md), used by both
 * `flowfield.ts` and `lorenz.ts` (ARCHITECTURE.md §3.3 — the family is a shared
 * library scenes import, not an engine special case).
 */

import { hash32 } from '../../../dsl/builtins'

/**
 * Particle-count quality ladder (docs/PARTICLES.md §3): particle i lives at
 * texel (i % side, i / side) of a square RGBA32F state texture, side = 2^k,
 * N = side². 64² mobile floor / 128² / 256² default / 512² desktop "100k+".
 */
export const COUNT_LADDER: ReadonlyArray<{ side: number; count: number }> = [
  { side: 64, count: 4096 },
  { side: 128, count: 16384 },
  { side: 256, count: 65536 },
  { side: 512, count: 262144 },
]

export const DEFAULT_COUNT = 65536
export const DEFAULT_SIDE = 256

/**
 * Snaps a raw `count` knob value to the nearest ladder rung. Rungs are spaced by
 * powers of 4, so nearest-by-log2 (not nearest-by-raw-distance) splits the
 * knob's range evenly between rungs instead of the top rung swallowing most of
 * it. Values outside [4096, 262144] clamp to the nearest end rung.
 */
export function snapCountToSide(value: number): number {
  const v = Math.max(1, value)
  let best = COUNT_LADDER[0]
  let bestDist = Infinity
  for (const rung of COUNT_LADDER) {
    const d = Math.abs(Math.log2(v) - Math.log2(rung.count))
    if (d < bestDist) {
      bestDist = d
      best = rung
    }
  }
  return best.side
}

/**
 * TS mirror of the GLSL `lattice2` in docs/PARTICLES.md §5/§10 (bit-exact —
 * verified against the spec's cross-check values in tests/unit/particles.test.ts).
 * Not used by CPU seeding (both scenes seed by uniform/trajectory sampling, not
 * lattice noise) — exists purely so the GLSL/DSL hash agreement is unit-testable
 * without a WebGL context.
 */
export function lattice2(ix: number, iy: number): number {
  const k = (hash32(ix >>> 0) ^ Math.imul(iy >>> 0, 0x9e3779b9)) >>> 0
  return (hash32(k) / 4294967296) * 2 - 1
}

export { hash32 }
