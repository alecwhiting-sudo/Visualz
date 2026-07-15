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
