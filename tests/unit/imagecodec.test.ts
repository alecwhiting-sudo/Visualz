import { describe, expect, it } from 'vitest'
import { decodeImageBase64, encodeImageBase64 } from '../../src/engine/imageCodec'
import { mulberry32 } from '../../src/core/prng'

describe('imageCodec', () => {
  it('round-trips a full-size 256x256 RGBA image across encode chunk boundaries', () => {
    // 262144 bytes = 8 x 32KB encode chunks — exercises the chunked
    // String.fromCharCode path the module exists for.
    const bytes = new Uint8ClampedArray(256 * 256 * 4)
    const rng = mulberry32(42)
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(rng() * 256)

    const decoded = decodeImageBase64(encodeImageBase64(bytes))
    expect(decoded.length).toBe(bytes.length)
    expect(decoded).toEqual(bytes)
  })

  it('round-trips lengths straddling the 32KB chunk boundary and odd sizes', () => {
    for (const len of [0, 1, 3, 0x7fff, 0x8000, 0x8001, 0x8000 * 2 + 2]) {
      const bytes = new Uint8ClampedArray(len)
      for (let i = 0; i < len; i++) bytes[i] = (i * 31) % 256
      expect(decodeImageBase64(encodeImageBase64(bytes))).toEqual(bytes)
    }
  })
})
