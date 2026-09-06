import { describe, expect, it } from 'vitest'
import { creditsActive, creditsAlpha } from '../../src/export/credits'

describe('creditsAlpha', () => {
  const durationSec = 30

  it('is 0 before the fade window starts', () => {
    // window default 5s, fade 1s -> starts fading at duration-5 = 25s
    expect(creditsAlpha(0, durationSec)).toBe(0)
    expect(creditsAlpha(24.999, durationSec)).toBe(0)
    expect(creditsAlpha(25, durationSec)).toBe(0)
  })

  it('is 0.5 mid-fade at the right time', () => {
    // start = 25, fade = 1s -> midpoint at 25.5
    expect(creditsAlpha(25.5, durationSec)).toBeCloseTo(0.5, 10)
  })

  it('is 1 at the last frame', () => {
    const fps = 30
    const lastFrameTime = durationSec - 1 / fps
    expect(creditsAlpha(lastFrameTime, durationSec)).toBe(1)
  })

  it('is 1 well after the fade completes and stays there through the end', () => {
    expect(creditsAlpha(26, durationSec)).toBe(1)
    expect(creditsAlpha(durationSec, durationSec)).toBe(1)
  })

  it('clamps the window start to 0 for short videos, fading from t=0', () => {
    const shortDuration = 3 // shorter than the default 5s window
    expect(creditsAlpha(0, shortDuration)).toBe(0)
    expect(creditsAlpha(0.5, shortDuration)).toBeCloseTo(0.5, 10)
    expect(creditsAlpha(1, shortDuration)).toBe(1)
    expect(creditsAlpha(shortDuration, shortDuration)).toBe(1)
  })

  it('respects custom windowSec/fadeSec', () => {
    // start = 10 - 2 = 8
    expect(creditsAlpha(8, 10, { windowSec: 2, fadeSec: 0.5 })).toBe(0)
    expect(creditsAlpha(8.25, 10, { windowSec: 2, fadeSec: 0.5 })).toBeCloseTo(0.5, 10)
    expect(creditsAlpha(8.5, 10, { windowSec: 2, fadeSec: 0.5 })).toBe(1)
  })
})

describe('creditsActive', () => {
  it('is false when both lines are blank or whitespace-only', () => {
    expect(creditsActive('', '')).toBe(false)
    expect(creditsActive('   ', '\t\n')).toBe(false)
  })

  it('is true when at least one line is non-blank after trim', () => {
    expect(creditsActive('Alec', '')).toBe(true)
    expect(creditsActive('', 'divurj.com')).toBe(true)
    expect(creditsActive('  Alec  ', '')).toBe(true)
  })
})
