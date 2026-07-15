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

  /** Live mode: advance to the externally-supplied clock (normally the audio clock). */
  advanceTo(time: number): Frame {
    if (this.mode !== 'live') throw new Error('advanceTo() is live-mode only')
    const dt = Math.max(0, time - this.t)
    this.t = time
    this.n += 1
    return { time: this.t, dt, frame: this.n }
  }

  /** Rewind/seek. Downstream per-frame state (DSL helpers, trails) must reset with it. */
  reset(time = 0): void {
    this.t = time
    this.n = 0
  }
}
