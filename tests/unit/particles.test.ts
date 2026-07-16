import { describe, expect, it } from 'vitest'
import { COUNT_LADDER, hash32, lattice2, snapCountToSide } from '../../src/scenes/families/particles/gpgpu'
import { importanceSampleState, resampleToRGBA8, sampleLuminance } from '../../src/scenes/families/particles/imageSample'
import { seedFlowState } from '../../src/scenes/builtin/flowfield'
import type { SceneSnapshot } from '../../src/scenes/types'

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

// --- Scene handoff ingest helpers (docs/HANDOFF.md §2/§8/§10) ---------------

/** A small deterministic gradient snapshot fixture: red ramps left->right,
 * green ramps top->bottom, so per-pixel luminance/color both vary. */
function gradientSnapshot(width: number, height: number): SceneSnapshot {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      data[i] = Math.round((x / Math.max(1, width - 1)) * 255)
      data[i + 1] = Math.round((y / Math.max(1, height - 1)) * 255)
      data[i + 2] = 64
      data[i + 3] = 255
    }
  }
  return { width, height, data }
}

describe('sampleLuminance (docs/HANDOFF.md §2 ingest helper)', () => {
  it('is a pure function of (snapshot, u, v) — same input, same output twice', () => {
    const snap = gradientSnapshot(16, 16)
    expect(sampleLuminance(snap, 0.3, 0.7)).toBe(sampleLuminance(snap, 0.3, 0.7))
  })

  it('returns higher luminance for brighter pixels', () => {
    const snap = gradientSnapshot(16, 16)
    // (0,0) is darkest (r=0,g=0); the far corner is brightest (r=255,g=255).
    expect(sampleLuminance(snap, 0.99, 0.99)).toBeGreaterThan(sampleLuminance(snap, 0.01, 0.01))
  })

  it('stays within [0, 1]', () => {
    const snap = gradientSnapshot(8, 8)
    for (let i = 0; i < 8; i++) {
      const v = sampleLuminance(snap, i / 8, i / 8)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })
})

describe('resampleToRGBA8 (docs/HANDOFF.md §2 ingest helper — kaleido)', () => {
  it('is a pure function of (snapshot, w, h) — same input, same output twice', () => {
    const snap = gradientSnapshot(20, 12)
    const a = resampleToRGBA8(snap, 32, 32)
    const b = resampleToRGBA8(snap, 32, 32)
    expect(a).toEqual(b)
  })

  it('produces exactly w*h*4 bytes', () => {
    const snap = gradientSnapshot(20, 12)
    expect(resampleToRGBA8(snap, 8, 5).length).toBe(8 * 5 * 4)
  })
})

describe('importanceSampleState (docs/HANDOFF.md §2 ingest helper — grayscott/flowfield)', () => {
  it('is a pure function of (snapshot, seed) — same input, same output twice', () => {
    const snap = gradientSnapshot(16, 16)
    const a = importanceSampleState(snap, 42, 256)
    const b = importanceSampleState(snap, 42, 256)
    expect(a).toEqual(b)
  })

  it('diverges for different seeds', () => {
    const snap = gradientSnapshot(16, 16)
    const a = importanceSampleState(snap, 1, 256)
    const b = importanceSampleState(snap, 2, 256)
    expect(a).not.toEqual(b)
  })

  it('produces count*4 floats with zero velocity (zw=0) and positions within [-1,1]', () => {
    const snap = gradientSnapshot(16, 16)
    const count = 128
    const out = importanceSampleState(snap, 7, count)
    expect(out.length).toBe(count * 4)
    for (let i = 0; i < count; i++) {
      const x = out[i * 4 + 0]
      const y = out[i * 4 + 1]
      const vx = out[i * 4 + 2]
      const vy = out[i * 4 + 3]
      expect(x).toBeGreaterThanOrEqual(-1)
      expect(x).toBeLessThanOrEqual(1)
      expect(y).toBeGreaterThanOrEqual(-1)
      expect(y).toBeLessThanOrEqual(1)
      expect(vx).toBe(0)
      expect(vy).toBe(0)
    }
  })
})

