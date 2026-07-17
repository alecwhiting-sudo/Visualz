/**
 * Pure progress→eased-value mapping for Frame F1-F8 glides (task #35, PERFORM
 * tab): shift+press interpolates each affected param from its current value
 * to the stored frame's target over the transition-speed knob's duration,
 * ease-in-out (smoothstep) rather than linear, so a glide visibly settles
 * instead of snapping to a constant rate. Kept dependency-free (no DOM/rAF)
 * so it's cheaply unit-testable — App.tsx's own rAF-driven glide animator
 * only ever calls `easedValue`, never computes the curve inline.
 */

/** Clamped smoothstep: eases in and out, flat-tangent at both ends. `t` is
 * elapsed/duration and is expected in [0, 1], but clamped defensively (a
 * `t` past 1 — the tick that notices the glide finished — must still land
 * exactly on the target, not overshoot it). */
export function easeInOut(t: number): number {
  const c = Math.min(1, Math.max(0, t))
  return c * c * (3 - 2 * c)
}

/** The value at `progress` (elapsed/duration) along an ease-in-out glide from
 * `from` to `to`. `progress` <= 0 stays at `from`; `progress` >= 1 lands
 * exactly on `to`. */
export function easedValue(from: number, to: number, progress: number): number {
  return from + (to - from) * easeInOut(progress)
}
