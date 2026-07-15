import { describe, expect, it } from 'vitest'
import { COUNT_LADDER, hash32, lattice2, snapCountToSide } from '../../src/scenes/families/particles/gpgpu'
import { seedFlowState } from '../../src/scenes/builtin/flowfield'

// A WebGL context isn't available under vitest/node (tests/unit/targets.test.ts
// is not feasible per the task), so this file covers the CPU-side pieces of the
// particles family that don't need one: the count quality-ladder snap, the
// flow-field CPU seeding function, and the hash32/lattice2 GLSL cross-check
// (docs/PARTICLES.md §10).

describe('snapCountToSide (docs/PARTICLES.md §3 quality ladder)', () => {
  it('snaps exact ladder values to themselves', () => {
    for (const rung of COUNT_LADDER) {
      expect(snapCountToSide(rung.count)).toBe(rung.side)
    }
  })

  it('clamps below the floor and above the ceiling', () => {
    expect(snapCountToSide(1)).toBe(64)
    expect(snapCountToSide(0)).toBe(64)
    expect(snapCountToSide(-100)).toBe(64)
    expect(snapCountToSide(10_000_000)).toBe(512)
  })

  it('snaps the default 65536 to side 256', () => {
    expect(snapCountToSide(65536)).toBe(256)
  })

  it('splits evenly at the log-midpoint between adjacent rungs', () => {
    // sqrt(4096*16384) = 8192 is the log-midpoint between the 64² and 128² rungs.
    const mid1 = Math.sqrt(4096 * 16384)
    expect(snapCountToSide(mid1 - 1)).toBe(64)
    expect(snapCountToSide(mid1 + 1)).toBe(128)

    const mid2 = Math.sqrt(16384 * 65536)
    expect(snapCountToSide(mid2 - 1)).toBe(128)
    expect(snapCountToSide(mid2 + 1)).toBe(256)

    const mid3 = Math.sqrt(65536 * 262144)
    expect(snapCountToSide(mid3 - 1)).toBe(256)
    expect(snapCountToSide(mid3 + 1)).toBe(512)
  })
})

describe('hash32/lattice2 GLSL cross-check (docs/PARTICLES.md §10)', () => {
  it('matches the spec bit-exact hash32 references', () => {
    expect(hash32(0)).toBe(33350994)
    expect(hash32(1)).toBe(2672842292)
    expect(hash32(2)).toBe(127880910)
    expect(hash32(1000)).toBe(937878766)
    expect(hash32(4294967295)).toBe(2767685996)
  })

  it('matches the spec bit-exact lattice2 references', () => {
    expect(lattice2(0, 0)).toBeCloseTo(0.250534, 6)
    expect(lattice2(1, 0)).toBeCloseTo(-0.461619, 6)
    expect(lattice2(0, 1)).toBeCloseTo(0.244613, 6)
    expect(lattice2(-1, -1)).toBeCloseTo(0.354086, 6)
    expect(lattice2(5, 7)).toBeCloseTo(-0.673272, 6)
  })
})

describe('seedFlowState (docs/PARTICLES.md §5 CPU init)', () => {
  it('is byte-identical for the same seed', () => {
    const a = seedFlowState(42, 4096)
    const b = seedFlowState(42, 4096)
    expect(a).toEqual(b)
  })

  it('diverges for different seeds', () => {
    const a = seedFlowState(1, 4096)
    const b = seedFlowState(2, 4096)
    expect(a).not.toEqual(b)
  })

  it('places positions in [-1.5, 1.5] and velocities at zero', () => {
    const n = 4096
    const s = seedFlowState(7, n)
    for (let i = 0; i < n; i++) {
      const px = s[i * 4 + 0]
      const py = s[i * 4 + 1]
      const vx = s[i * 4 + 2]
      const vy = s[i * 4 + 3]
      expect(px).toBeGreaterThanOrEqual(-1.5)
      expect(px).toBeLessThanOrEqual(1.5)
      expect(py).toBeGreaterThanOrEqual(-1.5)
      expect(py).toBeLessThanOrEqual(1.5)
      expect(vx).toBe(0)
      expect(vy).toBe(0)
    }
  })
})

