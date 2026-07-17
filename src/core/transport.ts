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
    this.n = Math.max(this.n, Math.floor(time * this.fps))
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
