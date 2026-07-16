/**
 * Pure time/offset arithmetic behind `AudioEngine.time`/`seek` (ARCHITECTURE.md
 * §1: no `Date.now()`/`performance.now()` in engine code — this module doesn't
 * even touch `AudioContext`, so it's testable without one). Kept separate from
 * `engine.ts` purely so the arithmetic can be unit-tested directly; the shape
 * mirrors the fields `AudioEngine` actually holds (`offsetSeconds`, `startedAt`,
 * `ctx.currentTime`), it's not a new public concept.
 */

export interface AudioTimeState {
  /** Whether a file has been decoded (`AudioEngine`'s `decoded !== null`). No
   * file loaded means "no audio clock at all" — callers fall back to their own
   * clock (e.g. the live engine's demo-mode rAF clock). */
  hasFile: boolean
  /** True while a `AudioBufferSourceNode` is actually running (i.e.
   * `source !== null && !paused`). */
  playing: boolean
  /** Position captured at the start of the current playing segment, or the
   * held position while paused/stopped. */
  offsetSeconds: number
  /** `ctx.currentTime` at the moment being queried. */
  ctxCurrentTime: number
  /** `ctx.currentTime` when the current segment's source was started. */
  startedAt: number
}

/**
 * `time = offsetSeconds` when there's no file, or when paused/stopped (the
 * frozen position); `offsetSeconds + elapsed-since-start` while playing. This
 * is what makes pausing freeze the Transport with no discontinuity: the same
 * formula, sampled repeatedly with an unmoving `ctxCurrentTime`, returns the
 * same value every time.
 */
export function computeAudioTime(s: AudioTimeState): number {
  if (!s.hasFile) return 0
  if (s.playing) return s.offsetSeconds + (s.ctxCurrentTime - s.startedAt)
  return s.offsetSeconds
}

/** Clamps a requested seek target to `[0, duration]`. Non-finite input clamps to 0. */
export function clampSeek(seconds: number, duration: number): number {
  if (!Number.isFinite(seconds)) return 0
  return Math.min(duration, Math.max(0, seconds))
}
