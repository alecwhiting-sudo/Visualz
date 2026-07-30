/**
 * All time in the engine flows from here. Scenes and signal producers must never
 * read Date.now()/performance.now() — that is what makes live sessions replayable
 * as deterministic offline renders (ARCHITECTURE.md §1).
 */

export type TransportMode = 'live' | 'render'

export interface Frame {
  /** Seconds since transport start. */
  time: number
  /** Seconds since previous frame. */
  dt: number
  /** Monotonic frame counter since start/seek. */
  frame: number
}

export class Transport {
  readonly mode: TransportMode
  /** Fixed timestep rate used in render mode. */
  readonly fps: number

  private t = 0
  private n = 0

  constructor(mode: TransportMode, fps = 60) {
    this.mode = mode
    this.fps = fps
  }

  get time(): number {
    return this.t
  }

  get frame(): number {
    return this.n
  }

  /** Render mode: advance by exactly one fixed timestep. */
  step(): Frame {
    if (this.mode !== 'render') throw new Error('step() is render-mode only')
    const dt = 1 / this.fps
    this.t += dt
    this.n += 1
    return { time: this.t, dt, frame: this.n }
  }

  /**
   * Live mode: advance the simulation by exactly ONE fixed timestep (1/fps),
   * same as render mode's `step()`. The engine's live loop drives this in a
   * catch-up loop (see `framesToCatchUp`) to track the audio clock, so that
   * `update()` runs the SAME number of times per second of audio in live and
   * render — which is what makes per-call-clocked scene simulations (terrain
   * scroll, whip physics, GPGPU ping-pong, DSL env/lfo helpers) look identical
   * live and on export. `dt` is the fixed step, never a real-elapsed value, so
   * a jittery/high-refresh rAF can't smear the simulation. `time` is pinned to
   * `frame/fps` (not accumulated) so a long performance can't drift.
   */
  stepLive(): Frame {
    if (this.mode !== 'live') throw new Error('stepLive() is live-mode only')
    const dt = 1 / this.fps
    this.n += 1
    this.t = this.n / this.fps
    return { time: this.t, dt, frame: this.n }
  }

  /**
   * Live mode: advance to the externally-supplied clock (normally the audio clock).
   *
   * The frame counter is time-derived (`floor(time * fps)`), not a per-call tick —
   * a rAF-paced live loop calls this once per animation frame, which on a 120Hz
   * display fires ~2x as often as a 60fps assumption expects and on a slow/
   * throttled tab fires less often, either of which used to desync "frame count"
   * from "seconds elapsed" (the take-duration/export-length regression this fixes).
   * Monotonic via `Math.max(this.n, ...)`: live seeks backward (`seekAudio`) exist
   * outside recording and must never rewind the counter consumers key state off
   * (the session recorder, the player's cursor). Two rAF ticks landing inside the
   * same `1/fps` bucket therefore share one frame number — same-frame-repeat is
   * already a case every frame-number consumer must tolerate (the recorder allows
   * non-decreasing event frames, the player's cursor only ever moves forward); a
   * slow tick can equally jump `n` by 2 or more in one call.
   */
  advanceTo(time: number): Frame {
    if (this.mode !== 'live') throw new Error('advanceTo() is live-mode only')
    const dt = Math.max(0, time - this.t)
    this.t = time
    // Follows time in BOTH directions — no monotonic clamp. The clamp seemed
    // protective but broke the flagship flow (user bug: "Last take 0:00"):
    // rehearse to t=133s, stop (audio rewinds to 0), arm, play — the counter
    // froze at floor(133*fps) until the track re-passed 133s, so the whole
    // take measured zero frames and exporting the empty take crashed the
    // muxer. Backward time only happens from stop/seek, which are locked out
    // during recording — so within any take the counter is monotonic anyway,
    // which is the only place order matters (recorder events, player cursor).
    this.n = Math.floor(time * this.fps)
    return { time: this.t, dt, frame: this.n }
  }

  /**
   * Rewind/seek. Downstream per-frame state (DSL helpers, trails) must reset with it.
   * Seeds the frame counter from `time` too (`round`, not `floor` — a reset target
   * is normally an exact take-start boundary, e.g. `startSeconds` recorded via the
   * same `round4` the session recorder uses, so round-tripping it should land back
   * on the same integer frame rather than one short from float noise), so resetting
   * to a take's recorded start position numbers frames the same way the live take
   * that recorded it did.
   */
  reset(time = 0): void {
    this.t = time
    this.n = Math.round(time * this.fps)
  }
}

/**
 * How many fixed `1/fps` steps the live loop should run this rAF to catch the
 * simulation frame up to the audio clock at `targetTime`, bounded by `cap`
 * (so a long stall recovers over several rAFs instead of one giant burst).
 *
 * This is THE fix for live-vs-export divergence: the answer depends ONLY on the
 * elapsed audio time, never on how often the rAF loop happened to fire — so a
 * 60Hz monitor, a 120Hz monitor, and a jittery/throttled tab all run the SAME
 * total number of `update()` calls to reach a given audio time (== `floor(time*
 * fps)`), which is exactly what a fixed-fps export does. Per-call-clocked scene
 * state is therefore reproduced on export instead of racing ahead live.
 */
export function framesToCatchUp(currentFrame: number, targetTime: number, fps: number, cap: number): number {
  const targetFrame = Math.floor(targetTime * fps + 1e-9)
  return Math.max(0, Math.min(cap, targetFrame - currentFrame))
}
