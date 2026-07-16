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
  | { frame: number; type: 'shader'; key: string; source: string } // code-layer hot-recompile
  | { frame: number; type: 'switch'; toScene: string } // scene handoff (docs/HANDOFF.md)

/**
 * `demo` sessions drive signals from `publishDemoSignals`/the live detector, same
 * as v0. `file` sessions carry a whole-track offline `FeatureTimeline`
 * (docs/ANALYSIS.md) — `timeline` is `serializeTimeline()`'s output, typed
 * `unknown` here to keep this module decoupled from `audio/timeline.ts`; the
 * engine validates/decodes it via `parseTimeline` at load time (Engine.loadSession).
 */
export type SessionAudio = { kind: 'demo' } | { kind: 'file'; name: string; timeline: unknown }

export interface SessionDoc {
  version: 1
  seed: number
  fps: number // fixed-timestep rate for replay
  scene: {
    id: string
    params: Record<string, number> // initial param values
    /** Initial code-layer sources per shader stage; omitted (not even {})
     * when the recording snapshot had none (ARCHITECTURE.md §3.3 code layer). */
    shaders?: Record<string, string>
    /** Downscaled RGBA snapshot for image-driven scenes; omitted when none was set. */
    image?: { width: number; height: number; data: string } // base64 of width*height*4 bytes
  }
  bindings: Record<string, string> // initial expression bindings
  audio: SessionAudio
  durationFrames: number
  events: SessionEvent[] // ascending by frame (stable order within a frame)
}
