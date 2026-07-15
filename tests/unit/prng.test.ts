import { describe, expect, it } from 'vitest'
import { hashString, mulberry32 } from '../../src/core/prng'

describe('mulberry32', () => {
  it('same seed produces identical sequences', () => {
    const a = mulberry32(42)
    const b = mulberry32(42)
    for (let i = 0; i < 1000; i++) expect(a()).toBe(b())
  })

  it('different seeds diverge', () => {
    const a = mulberry32(1)
    const b = mulberry32(2)
    const seqA = Array.from({ length: 10 }, a)
    const seqB = Array.from({ length: 10 }, b)
    expect(seqA).not.toEqual(seqB)
  })

  it('outputs stay in [0, 1)', () => {
    const r = mulberry32(1234)
    for (let i = 0; i < 10000; i++) {
      const v = r()
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('hashString', () => {
  it('is stable and distinguishes strings', () => {
    expect(hashString('lissajous')).toBe(hashString('lissajous'))
    expect(hashString('lissajous')).not.toBe(hashString('lissajouz'))
  })
})
