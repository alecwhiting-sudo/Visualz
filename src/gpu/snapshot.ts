/**
 * Scene handoff capture (docs/HANDOFF.md §1). CPU readback of the currently
 * bound drawing buffer, flipped vertically (`readPixels` returns rows
 * bottom-up; `ImageData`/scene `setImage`/`ingest` consumers are top-down) and
 * box-downscaled to fit `INGEST_MAX` on its long axis, aspect preserved. This
 * is a *rare, user-triggered* capture (one per scene switch, not per frame),
 * so the CPU averaging cost is irrelevant — see the module doc for why this
 * is the one capture mechanism used by both live and export.
 *
 * Determinism (invariant I3): pure given the pixels — on a fixed GPU/driver,
 * identical rendered content reads back identical bytes, and the
 * downscale/flip below is ordinary CPU float math, deterministic everywhere.
 * The caller must bind the surface to read (the default framebuffer, or an
 * offscreen target) before calling this.
 */

import type { SceneSnapshot } from '../scenes/types'

export type { SceneSnapshot }

/** Long-axis cap for a handoff snapshot — matches Photo Swarm's existing
 * 256px fallback-image/import cap and the session `MAX_IMAGE_PIXELS` ceiling. */
export const INGEST_MAX = 256

/** Read the bound drawing buffer, flip vertically, box-downscale to fit
 * `INGEST_MAX`. Pure given the pixels; the caller binds the target surface first. */
export function readSurfaceSnapshot(gl: WebGL2RenderingContext, w: number, h: number): SceneSnapshot {
  const raw = new Uint8Array(w * h * 4)
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw) // bottom-up
  const scale = Math.max(1, Math.ceil(Math.max(w, h) / INGEST_MAX))
  const dw = Math.max(1, Math.floor(w / scale))
  const dh = Math.max(1, Math.floor(h / scale))
  const out = new Uint8ClampedArray(dw * dh * 4)
  for (let dy = 0; dy < dh; dy++) {
    for (let dx = 0; dx < dw; dx++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let sy = dy * scale; sy < (dy + 1) * scale && sy < h; sy++) {
        const flippedY = h - 1 - sy // vertical flip
        for (let sx = dx * scale; sx < (dx + 1) * scale && sx < w; sx++) {
          const s = (flippedY * w + sx) * 4
          r += raw[s]
          g += raw[s + 1]
          b += raw[s + 2]
          a += raw[s + 3]
          n++
        }
      }
      const d = (dy * dw + dx) * 4
      out[d] = r / n
      out[d + 1] = g / n
      out[d + 2] = b / n
      out[d + 3] = a / n
    }
  }
  return { width: dw, height: dh, data: out }
}
