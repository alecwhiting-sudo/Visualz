/**
 * Base64 codec for the image-driven-scene snapshot (`SessionDoc.scene.image`,
 * `src/session/types.ts`). Used by `Engine.startRecording`/`loadSession` and
 * the test harness (`src/testing/hooks.ts`).
 *
 * Chunked on the encode side: a 256x256 RGBA image is 256KB raw, and calling
 * `String.fromCharCode(...bytes)` on the whole array in one go spreads every
 * byte as a function argument — comfortably over the call-stack/argument-count
 * ceiling some JS engines enforce. `btoa` itself takes a single string
 * argument regardless of length, so it only needs to run once over the fully
 * assembled binary string. Decode uses the standard `Uint8ClampedArray.from(
 * atob(...), mapFn)` form, which walks the decoded string one character at a
 * time (no variadic call), so it needs no chunking.
 */

const ENCODE_CHUNK = 0x8000 // 32KB slices for String.fromCharCode.apply-style chunking

export function encodeImageBase64(data: Uint8ClampedArray): string {
  let binary = ''
  for (let i = 0; i < data.length; i += ENCODE_CHUNK) {
    binary += String.fromCharCode(...data.subarray(i, i + ENCODE_CHUNK))
  }
  return btoa(binary)
}

export function decodeImageBase64(base64: string): Uint8ClampedArray {
  return Uint8ClampedArray.from(atob(base64), (c) => c.charCodeAt(0))
}
