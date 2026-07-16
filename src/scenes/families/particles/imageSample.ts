/**
 * Shared handoff-ingest sampling helpers (docs/HANDOFF.md §2/§8), used by
 * grayscott/kaleido/flowfield's `ingest(snapshot)`. Pure functions of
 * (snapshot, seed) — no `Math.random`/`Date.now` — so a scene's ingest stays
 * a deterministic function of (snapshot, that scene's seed) per invariant I4.
 *
 * `importanceSampleState` mirrors photoswarm.ts's own luminance-CDF home
 * sampler (docs/PARTICLES.md-style seeded CPU sampling) but returns a bare
 * GPGPU particle-state array (xy=position, zw=0 velocity) instead of a
 * home/color texture pair, so flowfield's ingest can reuse it directly.
 */

import { mulberry32 } from '../../../core/prng'
import type { SceneSnapshot } from '../../types'

/** Weight floor added to every pixel's luminance before CDF sampling, so dark
 * regions still get a few samples instead of being completely empty — same
 * constant photoswarm.ts uses for its own home sampling. */
const LUMINANCE_FLOOR = 0.12

function sampleNearest(snap: SceneSnapshot, u: number, v: number): { r: number; g: number; b: number; a: number } {
  const x = Math.min(snap.width - 1, Math.max(0, Math.floor(u * snap.width)))
  const y = Math.min(snap.height - 1, Math.max(0, Math.floor(v * snap.height)))
  const i = (y * snap.width + x) * 4
  return { r: snap.data[i], g: snap.data[i + 1], b: snap.data[i + 2], a: snap.data[i + 3] }
}

/** Nearest-sample normalized luminance ([0,1]) at normalized coordinates
 * `(u, v)` in `[0, 1)` (top-down, matching `SceneSnapshot`'s convention). */
export function sampleLuminance(snap: SceneSnapshot, u: number, v: number): number {
  const { r, g, b } = sampleNearest(snap, u, v)
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

/** Nearest-neighbor stretch-resample `snap` to a `w`×`h` RGBA8 buffer (no
 * aspect preservation — a straight stretch, adequate for priming a square
 * feedback buffer like kaleido's). */
export function resampleToRGBA8(snap: SceneSnapshot, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w
      const s = sampleNearest(snap, u, v)
      const o = (y * w + x) * 4
      out[o] = s.r
      out[o + 1] = s.g
      out[o + 2] = s.b
      out[o + 3] = s.a
    }
  }
  return out
}

/** Binary search for the first cdf entry >= target (cdf is non-decreasing). */
function lowerBound(cdf: Float64Array, target: number): number {
  let lo = 0
  let hi = cdf.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (cdf[mid] < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Luminance-weighted (+ uniform floor) importance sampling of `count`
 * particle positions from `snap`'s pixels — bright regions get denser
 * sampling. Each position is min-axis-fit into the canonical `[-1,1]` world
 * square (image aspect preserved, same convention as photoswarm.ts's home
 * derivation), with velocity zero. Returns a `Float32Array` of
 * `count*4` floats: xy=position, zw=0.
 */
export function importanceSampleState(snap: SceneSnapshot, seed: number, count: number): Float32Array {
  const { width, height, data } = snap
  const n = width * height
  const cdf = new Float64Array(n)
  let acc = 0
  for (let i = 0; i < n; i++) {
    const idx = i * 4
    const lum = (0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2]) / 255
    acc += lum + LUMINANCE_FLOOR
    cdf[i] = acc
  }
  const total = acc

  const imgAspect = width / height
  const rng = mulberry32(seed)
  const out = new Float32Array(count * 4)

  for (let p = 0; p < count; p++) {
    const target = rng() * total
    // LUMINANCE_FLOOR keeps total > 0, so the uniform fallback never runs in
    // practice; if the floor were ever removed, note it draws a DIFFERENT
    // number of rng() values than the taken branch, forking determinism.
    const pixelIndex = total > 0 ? lowerBound(cdf, target) : Math.floor(rng() * n)
    const px = pixelIndex % width
    const py = Math.floor(pixelIndex / width)

    const jx = rng() - 0.5
    const jy = rng() - 0.5
    const cx = ((px + 0.5 + jx) / width) * 2 - 1
    const cy = ((py + 0.5 + jy) / height) * 2 - 1

    let hx: number
    let hy: number
    if (imgAspect >= 1) {
      hx = cx
      hy = -cy / imgAspect
    } else {
      hx = cx * imgAspect
      hy = -cy
    }

    const o = p * 4
    out[o] = hx
    out[o + 1] = hy
    out[o + 2] = 0
    out[o + 3] = 0
  }

  return out
}
