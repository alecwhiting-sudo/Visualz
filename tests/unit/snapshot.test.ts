import { describe, expect, it } from 'vitest'
import { INGEST_MAX, readSurfaceSnapshot } from '../../src/gpu/snapshot'

// A real WebGL2 context isn't available under vitest/node (same constraint
// noted in particles.test.ts) — `readSurfaceSnapshot` only ever calls
// `gl.readPixels(...)`, so a minimal fake that copies a hand-built fixture
// buffer into the caller's typed array exercises the pure CPU flip/downscale
// math without a real GPU.
function fakeGl(raw: Uint8Array): WebGL2RenderingContext {
  return {
    RGBA: 6408,
    UNSIGNED_BYTE: 5121,
    readPixels: (
      _x: number,
      _y: number,
      _w: number,
      _h: number,
      _format: number,
      _type: number,
      buf: ArrayBufferView,
    ) => {
      ;(buf as Uint8Array).set(raw)
    },
  } as unknown as WebGL2RenderingContext
}

describe('readSurfaceSnapshot (docs/HANDOFF.md §1/§10)', () => {
  it('flips vertically: readPixels row 0 (GL bottom-up) lands at the bottom of the snapshot', () => {
    // w=1, h=2: GL row 0 (bottom of the rendered image) is BLUE, GL row 1
    // (top of the rendered image, since GL rows increase upward) is RED.
    const raw = new Uint8Array(1 * 2 * 4)
    raw.set([0, 0, 255, 255], 0) // row 0 (GL bottom): blue
    raw.set([255, 0, 0, 255], 4) // row 1 (GL top): red
    const snap = readSurfaceSnapshot(fakeGl(raw), 1, 2)
    expect(snap.width).toBe(1)
    expect(snap.height).toBe(2)
    // Top-down output: row 0 (top) must be the actual top of the render (red);
    // row 1 (bottom) must be the actual bottom (blue).
    expect(Array.from(snap.data.slice(0, 4))).toEqual([255, 0, 0, 255])
    expect(Array.from(snap.data.slice(4, 8))).toEqual([0, 0, 255, 255])
  })

  it('box-averages when downscaling (long axis over INGEST_MAX)', () => {
    // w=300 (> INGEST_MAX), h=1 -> scale = ceil(300/256) = 2, dw = 150.
    // Alternate r=10/r=30 by column so each output pixel averages an exact,
    // rounding-free pair.
    const w = 300
    const raw = new Uint8Array(w * 1 * 4)
    for (let x = 0; x < w; x++) {
      const r = x % 2 === 0 ? 10 : 30
      raw[x * 4 + 0] = r
      raw[x * 4 + 1] = r
      raw[x * 4 + 2] = r
      raw[x * 4 + 3] = 255
    }
    const snap = readSurfaceSnapshot(fakeGl(raw), w, 1)
    expect(snap.width).toBe(150)
    expect(snap.height).toBe(1)
    // Output pixel 0 averages source columns 0 (r=10) and 1 (r=30) -> 20 exactly.
    expect(snap.data[0]).toBe(20)
    expect(snap.data[1]).toBe(20)
    expect(snap.data[2]).toBe(20)
    expect(snap.data[3]).toBe(255)
  })

  it('preserves aspect ratio and caps the long axis at INGEST_MAX', () => {
    const w = 512
    const h = 256 // 2:1, both over INGEST_MAX on the long axis
    const raw = new Uint8Array(w * h * 4)
    const snap = readSurfaceSnapshot(fakeGl(raw), w, h)
    expect(Math.max(snap.width, snap.height)).toBeLessThanOrEqual(INGEST_MAX)
    // Same scale factor applied to both axes -> aspect ratio unchanged.
    expect(snap.width / snap.height).toBeCloseTo(w / h, 6)
  })

  it('does not downscale content already within INGEST_MAX', () => {
    const w = 64
    const h = 36
    const raw = new Uint8Array(w * h * 4)
    const snap = readSurfaceSnapshot(fakeGl(raw), w, h)
    expect(snap.width).toBe(w)
    expect(snap.height).toBe(h)
  })
})
