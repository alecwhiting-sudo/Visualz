import type { SourceEvent } from '../mapping/types'

/**
 * Session data model (ARCHITECTURE.md §3.5): a session recording is the audio
 * reference + the timestamped input-event log. Replaying the log through the
 * identical pipeline at fixed timestep reproduces the performance frame-for-frame.
 *
 * `frame` on every event is the transport frame counter *as it stood when the
 * event was recorded* (the last completed frame) — not the frame it will be
 * applied on. The player applies events with `event.frame <= frame` immediately
 * before stepping to `frame + 1`, which reproduces the exact interleaving the
 * live engine saw when the event was queued (see player.ts).
 */
export type SessionEvent =
  | { frame: number; type: 'input'; event: SourceEvent } // key/trigger
  | { frame: number; type: 'inputSignal'; name: string; value: number } // pad.x etc.
  | { frame: number; type: 'param'; name: string; value: number } // UI knob
  | { frame: number; type: 'binding'; param: string; src: string | null } // null = cleared

export interface SessionDoc {
  version: 1
  seed: number
  fps: number // fixed-timestep rate for replay
  scene: { id: string; params: Record<string, number> } // initial param values
  bindings: Record<string, string> // initial expression bindings
  audio: { kind: 'demo' } // v0: demo-signal sessions only
  durationFrames: number
  events: SessionEvent[] // ascending by frame (stable order within a frame)
}
