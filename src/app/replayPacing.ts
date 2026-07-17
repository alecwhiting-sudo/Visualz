/**
 * Pure math behind audio-synced session replay (App.tsx's `replaySession`):
 * when the live `AudioEngine` still has the take's track loaded, replay paces
 * the render-mode engine off the real audio clock instead of one frame per
 * rAF tick, so the video chases the actual audio position and self-corrects
 * after a slow/dropped rAF rather than drifting. Kept dependency-free (no
 * DOM/AudioContext) so it's cheaply unit-testable, mirroring
 * `audio/transportMath.ts`'s split of pure arithmetic from the stateful class
 * that uses it.
 *
 * Determinism (ARCHITECTURE.md §1) is untouched by this: it only decides
 * *when* `Engine.renderFrames` is called and with what `n`, never what a
 * frame contains — the render-mode engine is still fixed-timestep underneath.
 */

/**
 * How many frames (in total, from the take's own start) should have been
 * rendered by the time `elapsedAudioSeconds` of the track has played past the
 * take's start, at `fps`. Derived from "step while (framesStepped / fps) <=
 * elapsedAudioSeconds": the loop keeps incrementing `framesStepped` as long as
 * that holds, so the total once it stops is `floor(elapsedAudioSeconds * fps) + 1`
 * — i.e. frame 0 renders immediately once elapsed reaches (or is) 0, matching
 * today's "render immediately on start" behavior.
 *
 * Returns 0 for negative/non-finite input (audio not yet at the take's start,
 * or a transient bad reading) rather than a negative or NaN frame count.
 */
export function framesDueForAudioTime(elapsedAudioSeconds: number, fps: number): number {
  if (!Number.isFinite(elapsedAudioSeconds) || elapsedAudioSeconds < 0 || !Number.isFinite(fps) || fps <= 0) {
    return 0
  }
  return Math.floor(elapsedAudioSeconds * fps) + 1
}

/**
 * How many ADDITIONAL frames `replaySession`'s rAF step should render this
 * tick to catch the replay engine up to the audio clock, clamped so it never
 * renders past the take's own `durationFrames` (the audio may keep playing a
 * moment past the take's recorded end) and never goes negative (audio clock
 * momentarily behind where the engine already is — a no-op tick, not a
 * rewind).
 */
export function framesToRenderForAudioSync(
  framesAlreadyRendered: number,
  elapsedAudioSeconds: number,
  fps: number,
  durationFrames: number,
): number {
  const due = Math.min(framesDueForAudioTime(elapsedAudioSeconds, fps), durationFrames)
  return Math.max(0, due - framesAlreadyRendered)
}
