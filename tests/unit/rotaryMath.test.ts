import { describe, expect, it } from 'vitest'
import {
  clamp,
  dragDeltaToValue,
  normalize,
  valueToAngle,
  wheelDeltaToValue,
  DRAG_PIXELS_FOR_FULL_RANGE,
  FINE_DRAG_MULTIPLIER,
} from '../../src/app/rotaryMath'

describe('clamp', () => {
  it('passes through in-range values', () => {
    expect(clamp(5, 0, 10)).toBe(5)
  })
  it('clamps below min and above max', () => {
    expect(clamp(-5, 0, 10)).toBe(0)
    expect(clamp(15, 0, 10)).toBe(10)
  })
})

describe('normalize', () => {
  it('maps min/mid/max to 0/0.5/1', () => {
    expect(normalize(0, 0, 10)).toBe(0)
    expect(normalize(5, 0, 10)).toBe(0.5)
    expect(normalize(10, 0, 10)).toBe(1)
  })
  it('clamps out-of-range values', () => {
    expect(normalize(-5, 0, 10)).toBe(0)
    expect(normalize(15, 0, 10)).toBe(1)
  })
  it('never divides by zero for a degenerate min === max range', () => {
    expect(normalize(3, 5, 5)).toBe(0)
  })
})

describe('valueToAngle', () => {
  it('maps min to -135deg (~7 o\'clock) and max to +135deg (~5 o\'clock)', () => {
    expect(valueToAngle(0, 0, 10)).toBeCloseTo(-135)
    expect(valueToAngle(10, 0, 10)).toBeCloseTo(135)
  })
  it('maps the midpoint to 0deg (12 o\'clock)', () => {
    expect(valueToAngle(5, 0, 10)).toBeCloseTo(0)
  })
  it('clamps values outside [min, max]', () => {
    expect(valueToAngle(-100, 0, 10)).toBeCloseTo(-135)
    expect(valueToAngle(100, 0, 10)).toBeCloseTo(135)
  })
})

describe('dragDeltaToValue', () => {
  it('dragging up (negative deltaY) increases the value', () => {
    const v = dragDeltaToValue(5, -DRAG_PIXELS_FOR_FULL_RANGE / 2, 0, 10, false)
    expect(v).toBeCloseTo(10) // half the full-range distance, up, over half the range = +5
  })
  it('dragging down (positive deltaY) decreases the value', () => {
    const v = dragDeltaToValue(5, DRAG_PIXELS_FOR_FULL_RANGE / 2, 0, 10, false)
    expect(v).toBeCloseTo(0)
  })
  it('clamps at the range boundaries rather than overshooting', () => {
    const v = dragDeltaToValue(5, -10_000, 0, 10, false)
    expect(v).toBe(10)
    const v2 = dragDeltaToValue(5, 10_000, 0, 10, false)
    expect(v2).toBe(0)
  })
  it('fine mode (Shift) is 10x less sensitive per pixel', () => {
    const deltaY = -30
    const normal = dragDeltaToValue(5, deltaY, 0, 10, false)
    const fine = dragDeltaToValue(5, deltaY, 0, 10, true)
    const normalDelta = normal - 5
    const fineDelta = fine - 5
    expect(normalDelta).toBeCloseTo(fineDelta * FINE_DRAG_MULTIPLIER)
  })
  it('zero delta leaves the value unchanged', () => {
    expect(dragDeltaToValue(5, 0, 0, 10, false)).toBe(5)
  })
})

describe('wheelDeltaToValue', () => {
  it('wheel-up (negative deltaY) increases the value', () => {
    expect(wheelDeltaToValue(5, -100, 0, 10)).toBeGreaterThan(5)
  })
  it('wheel-down (positive deltaY) decreases the value', () => {
    expect(wheelDeltaToValue(5, 100, 0, 10)).toBeLessThan(5)
  })
  it('clamps at the range boundaries', () => {
    expect(wheelDeltaToValue(9.99, -100_000, 0, 10)).toBe(10)
    expect(wheelDeltaToValue(0.01, 100_000, 0, 10)).toBe(0)
  })
})
