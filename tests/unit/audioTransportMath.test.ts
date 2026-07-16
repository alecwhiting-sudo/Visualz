import { describe, expect, it } from 'vitest'
import { clampSeek, computeAudioTime } from '../../src/audio/transportMath'

describe('computeAudioTime', () => {
  it('is 0 with no file loaded, regardless of other fields', () => {
    expect(
      computeAudioTime({ hasFile: false, playing: true, offsetSeconds: 5, ctxCurrentTime: 10, startedAt: 2 }),
    ).toBe(0)
  })

  it('advances with the context clock while playing', () => {
    const t = computeAudioTime({ hasFile: true, playing: true, offsetSeconds: 3, ctxCurrentTime: 10, startedAt: 4 })
    // offset (3) + elapsed since this segment started (10 - 4 = 6)
    expect(t).toBeCloseTo(9)
  })

  it('is exactly the offset the instant a segment starts (ctxCurrentTime === startedAt)', () => {
    const t = computeAudioTime({ hasFile: true, playing: true, offsetSeconds: 3, ctxCurrentTime: 4, startedAt: 4 })
    expect(t).toBe(3)
  })

  it('freezes at the held offset while paused, independent of ctxCurrentTime', () => {
    const paused = (ctxCurrentTime: number) =>
      computeAudioTime({ hasFile: true, playing: false, offsetSeconds: 7, ctxCurrentTime, startedAt: 4 })
    expect(paused(4)).toBe(7)
    expect(paused(100)).toBe(7) // wall/context time moving on doesn't move the frozen position
    expect(paused(100)).toBe(paused(4)) // repeated sampling is identical -> no discontinuity
  })

  it('freezes at 0 (the reset offset) after a stop', () => {
    expect(
      computeAudioTime({ hasFile: true, playing: false, offsetSeconds: 0, ctxCurrentTime: 999, startedAt: 4 }),
    ).toBe(0)
  })
})

describe('clampSeek', () => {
  it('clamps within [0, duration]', () => {
    expect(clampSeek(-5, 10)).toBe(0)
    expect(clampSeek(5, 10)).toBe(5)
    expect(clampSeek(15, 10)).toBe(10)
  })

  it('treats non-finite input as 0', () => {
    expect(clampSeek(NaN, 10)).toBe(0)
    expect(clampSeek(Infinity, 10)).toBe(0)
  })

  it('handles a zero-duration (no file) target', () => {
    expect(clampSeek(5, 0)).toBe(0)
    expect(clampSeek(-5, 0)).toBe(0)
  })
})
