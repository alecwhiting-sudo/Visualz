import { describe, expect, it } from 'vitest'
import { easeInOut, easedValue } from '../../src/app/frameGlide'

describe('easeInOut', () => {
  it('is 0 at t=0 and 1 at t=1', () => {
    expect(easeInOut(0)).toBe(0)
    expect(easeInOut(1)).toBe(1)
  })

  it('is 0.5 at the midpoint (symmetric curve)', () => {
    expect(easeInOut(0.5)).toBeCloseTo(0.5)
  })

  it('is monotonically increasing across [0, 1]', () => {
    let prev = -Infinity
    for (let t = 0; t <= 1; t += 0.1) {
      const v = easeInOut(t)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })

  it('eases in and out: slower near both ends than a linear ramp, faster in the middle', () => {
    // Smoothstep sits below the line y=t for t<0.5 and above it for t>0.5,
    // meeting only at 0, 0.5, and 1.
    expect(easeInOut(0.1)).toBeLessThan(0.1)
    expect(easeInOut(0.9)).toBeGreaterThan(0.9)
  })

  it('clamps defensively outside [0, 1]', () => {
    expect(easeInOut(-0.5)).toBe(0)
    expect(easeInOut(1.5)).toBe(1)
  })
})

describe('easedValue', () => {
  it('starts at "from" and ends at "to"', () => {
    expect(easedValue(2, 10, 0)).toBe(2)
    expect(easedValue(2, 10, 1)).toBe(10)
  })

  it('interpolates through the middle', () => {
    expect(easedValue(0, 10, 0.5)).toBeCloseTo(5)
  })

  it('handles a "to" less than "from" (gliding downward)', () => {
    expect(easedValue(10, 0, 0)).toBe(10)
    expect(easedValue(10, 0, 1)).toBe(0)
    expect(easedValue(10, 0, 0.5)).toBeCloseTo(5)
  })

  it('progress past 1 still lands exactly on the target (no overshoot)', () => {
    expect(easedValue(0, 10, 1.3)).toBe(10)
  })

  it('a degenerate from === to glide stays constant throughout', () => {
    expect(easedValue(5, 5, 0)).toBe(5)
    expect(easedValue(5, 5, 0.5)).toBe(5)
    expect(easedValue(5, 5, 1)).toBe(5)
  })
})
