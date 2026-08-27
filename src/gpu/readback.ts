/**
 * GPU readback helpers (ARCHITECTURE.md §3.7). `pixelHash` is the one place the
 * FNV-1a frame hash is computed — used by the test harness (`src/testing/hooks.ts`,
 * exact-replay assertions) and by the export pipeline (`src/export/render.ts`,
 * frame-hash determinism checks), so both stay byte-for-byte the same algorithm.
 */

/** FNV-1a hash of the given RGBA pixel buffer, as a zero-padded 8-hex-digit string. */
export function fnv1aHex(pixels: Uint8Array): string {
  let h = 0x811c9dc5
  for (let i = 0; i < pixels.length; i++) {
    h ^= pixels[i]
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** FNV-1a hash of the current contents of `gl`'s drawing buffer. */
export function pixelHash(gl: WebGL2RenderingContext, width: number, height: number): string {
  const pixels = new Uint8Array(width * height * 4)
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
  return fnv1aHex(pixels)
}

/**
 * Per-horizontal-band mean luminance of `gl`'s current drawing buffer — the
 * portrait "band coverage" probe behind the Scene Contract's F4 rule
 * (docs/SCENE_CONTRACT.md, tests/e2e/framing.spec.ts): does a `'field'`
 * scene's content genuinely reach every band of a tall (9:16) frame, or does
 * it only fill a centred strip? Splits the frame into `bands` equal-height
 * horizontal strips and returns each strip's mean of `max(r,g,b)` per pixel
 * (0-255). Index 0 is the TOP of the frame — image order, top-to-bottom, the
 * same direction a screenshot reads — even though `gl.readPixels` itself
 * returns rows bottom-up; this function flips it. Pure read: same
 * `gl.readPixels` call as `pixelHash`, no framebuffer bind and no GL state
 * touched, so it never perturbs a render that depends on it.
 */
export function bandCoverage(gl: WebGL2RenderingContext, width: number, height: number, bands: number): number[] {
  const pixels = new Uint8Array(width * height * 4)
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
  const sums = new Float64Array(bands)
  const counts = new Uint32Array(bands)
  for (let glRow = 0; glRow < height; glRow++) {
    // gl.readPixels row 0 is the BOTTOM of the frame; flip to top-down image order.
    const imageRow = height - 1 - glRow
    const band = Math.min(bands - 1, Math.floor((imageRow * bands) / height))
    const rowOffset = glRow * width * 4
    for (let x = 0; x < width; x++) {
      const i = rowOffset + x * 4
      sums[band] += Math.max(pixels[i], pixels[i + 1], pixels[i + 2])
      counts[band]++
    }
  }
  const out: number[] = new Array(bands)
  for (let b = 0; b < bands; b++) out[b] = counts[b] > 0 ? sums[b] / counts[b] : 0
  return out
}
