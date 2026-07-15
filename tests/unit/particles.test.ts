import { describe, expect, it } from 'vitest'
import { COUNT_LADDER, hash32, lattice2, snapCountToSide } from '../../src/scenes/families/particles/gpgpu'
import { seedLorenzState } from '../../src/scenes/builtin/lorenz'
import { seedFlowState } from '../../src/scenes/builtin/flowfield'

// A WebGL context isn't available under vitest/node (tests/unit/targets.test.ts
// is not feasible per the task), so this file covers the CPU-side pieces of the
// particles family that don't need one: the count quality-ladder snap, the
// Lorenz CPU seeding function, and the hash32/lattice2 GLSL cross-check
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

describe('seedLorenzState (docs/PARTICLES.md §7 CPU init)', () => {
  it('is byte-identical for the same seed', () => {
    const a = seedLorenzState(42, 4096)
    const b = seedLorenzState(42, 4096)
    expect(a).toEqual(b)
  })

  it('diverges for different seeds', () => {
    const a = seedLorenzState(1, 4096)
    const b = seedLorenzState(2, 4096)
    expect(a).not.toEqual(b)
  })

  it('places the whole swarm along the attractor within the validated extent', () => {
    // docs/PARTICLES.md §7 validates x∈[-18.7,18], y∈[-25.5,24.3], z∈[3.6,46.2] for
    // this seeding scheme at N=65536. Generous bounds here (the spec's own
    // prototype and this port can differ in unspecified details — RNG draw order,
    // exact warm-up starting point — while landing on the same bounded attractor).
    const n = 65536
    const s = seedLorenzState(42, n)
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity
    for (let i = 0; i < n; i++) {
      const x = s[i * 4 + 0]
      const y = s[i * 4 + 1]
      const z = s[i * 4 + 2]
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      if (z < minZ) minZ = z
      if (z > maxZ) maxZ = z
    }
    expect(minX).toBeGreaterThan(-25)
    expect(maxX).toBeLessThan(25)
    expect(minY).toBeGreaterThan(-30)
    expect(maxY).toBeLessThan(30)
    expect(minZ).toBeGreaterThan(0)
    expect(maxZ).toBeLessThan(55)
    // Sanity: the swarm actually spans the attractor, not a single point/blob.
    expect(maxX - minX).toBeGreaterThan(20)
    expect(maxZ - minZ).toBeGreaterThan(20)
  })

  it('age runs from 0 to just under 1 across the swarm', () => {
    const n = 1024
    const s = seedLorenzState(42, n)
    expect(s[0 * 4 + 3]).toBe(0)
    expect(s[(n - 1) * 4 + 3]).toBeCloseTo((n - 1) / n, 10)
  })
})
