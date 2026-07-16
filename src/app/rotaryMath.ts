/**
 * Pure math for the SampleArk-style rotary knob (RotaryKnob.tsx): value↔angle
 * mapping and drag/wheel-to-value conversion. Kept dependency-free (no React,
 * no DOM) so it's cheaply unit-testable and so the SVG geometry helpers below
 * can be reasoned about independently of pointer-event wiring.
 *
 * Angle convention throughout: degrees measured CLOCKWISE FROM 12 O'CLOCK
 * (0° = straight up, 90° = 3 o'clock/right, 180° = 6 o'clock/down). The knob's
 * value arc sweeps 270° total, from -135° (~7:30, min) through 0° (12 o'clock,
 * midpoint) to +135° (~4:30, max) — the standard hardware-synth knob layout,
 * leaving a 90° dead zone at the bottom (spec: "~7 o'clock to ~5 o'clock").
 */

export const KNOB_START_ANGLE = -135
export const KNOB_END_ANGLE = 135
export const KNOB_SWEEP = KNOB_END_ANGLE - KNOB_START_ANGLE // 270

/** Vertical pixels of drag needed to cover the param's full range at normal
 * (non-fine) sensitivity. */
export const DRAG_PIXELS_FOR_FULL_RANGE = 150
/** Shift-held drag divides sensitivity by this factor (10x finer). */
export const FINE_DRAG_MULTIPLIER = 10
/** Fraction of the full range one wheel "notch" (~100 deltaY in most
 * browsers/OSes) moves the value. */
export const WHEEL_NOTCH_FRACTION = 0.02

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** Normalizes `value` to [0, 1] over [min, max], clamped. A degenerate
 * min === max range reads as 0 rather than dividing by zero. */
export function normalize(value: number, min: number, max: number): number {
  const range = max - min
  if (range === 0) return 0
  return clamp((value - min) / range, 0, 1)
}

/** Maps a param value to the knob's needle/value-arc angle (see module
 * doc for the angle convention). */
export function valueToAngle(value: number, min: number, max: number): number {
  return KNOB_START_ANGLE + normalize(value, min, max) * KNOB_SWEEP
}

/**
 * Vertical-drag-to-value: dragging UP (negative `deltaY`) increases the
 * value, matching hardware rotary encoders and every DAW's knob convention.
 * `deltaY` is the accumulated pixel delta from the drag's start (not a
 * per-move delta) so repeated calls during one continuous drag stay anchored
 * to `startValue` — re-basing against the previous call's rounded/clamped
 * result would drift under clamping. `fine` (Shift held) scales the pixel
 * distance needed for the full range by `FINE_DRAG_MULTIPLIER`.
 */
export function dragDeltaToValue(
  startValue: number,
  deltaY: number,
  min: number,
  max: number,
  fine: boolean,
): number {
  const pixelsForFullRange = DRAG_PIXELS_FOR_FULL_RANGE * (fine ? FINE_DRAG_MULTIPLIER : 1)
  const range = max - min
  const delta = (-deltaY / pixelsForFullRange) * range
  return clamp(startValue + delta, min, max)
}

/** Mouse-wheel-to-value: wheel-up (negative `deltaY`, same direction as
 * drag-up) increases the value by `WHEEL_NOTCH_FRACTION` of the range per
 * ~100-unit notch, scaled continuously for trackpads that report finer deltas. */
export function wheelDeltaToValue(value: number, wheelDeltaY: number, min: number, max: number): number {
  const range = max - min
  const notches = wheelDeltaY / 100
  return clamp(value - notches * range * WHEEL_NOTCH_FRACTION, min, max)
}

export interface Point {
  x: number
  y: number
}

/** A point at `radius` from (`cx`,`cy`) at `angleDeg` (clockwise-from-12). */
export function polarToCartesian(cx: number, cy: number, radius: number, angleDeg: number): Point {
  const rad = (angleDeg * Math.PI) / 180
  return { x: cx + radius * Math.sin(rad), y: cy - radius * Math.cos(rad) }
}

/** SVG path `d` for an arc from `startAngle` to `endAngle` (clockwise-from-12,
 * degrees) at `radius` around (`cx`,`cy`). Handles the >180° large-arc case
 * (the knob's full track is a 270° arc) and degenerate zero-length arcs. */
export function describeArc(cx: number, cy: number, radius: number, startAngle: number, endAngle: number): string {
  if (startAngle === endAngle) {
    const p = polarToCartesian(cx, cy, radius, startAngle)
    return `M ${p.x} ${p.y}`
  }
  const start = polarToCartesian(cx, cy, radius, startAngle)
  const end = polarToCartesian(cx, cy, radius, endAngle)
  const largeArcFlag = Math.abs(endAngle - startAngle) > 180 ? 1 : 0
  // sweep-flag 1: our angle convention increases clockwise on screen, same
  // sense SVG's arc sweep-flag=1 draws in.
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`
}
