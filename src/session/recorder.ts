import type { SourceEvent } from '../mapping/types'
import type { SessionAudio, SessionDoc, SessionEvent } from './types'

/** The engine-state snapshot captured the moment recording starts. */
export interface SessionSnapshot {
  seed: number
  fps: number
  sceneId: string
  params: Record<string, number>
  bindings: Record<string, string>
  /** Defaults to `{ kind: 'demo' }` when omitted (existing callers/tests). */
  audio?: SessionAudio
  /** Current shader-stage sources (code layer), keyed by stage key. Omitted
   * entirely — not even `{}` — from `SessionDoc.scene` when this is undefined,
   * so existing snapshots/tests that don't pass it are unaffected. */
  shaders?: Record<string, string>
  /** Base64-encoded RGBA snapshot for image-driven scenes (Photo Swarm task).
   * Omitted entirely from `SessionDoc.scene` when this is undefined. */
  image?: { width: number; height: number; data: string }
}

/**
 * Session recorder (ARCHITECTURE.md §3.5): pure bookkeeping — appends
 * `(frame, event)` tuples as the engine reports them and produces a
 * `SessionDoc` on `finish()`. Carries no engine imports beyond types so it stays
 * trivially unit-testable and reusable by the export pipeline later.
 */
export class SessionRecorder {
  private readonly snapshot: SessionSnapshot
  private readonly events: SessionEvent[] = []
  /** The absolute `transport.frame` reading at construction (engine passes
   * this from `startRecording`) — every recorded event and `durationFrames`
   * are stored RELATIVE to it. Live-mode `transport.frame` is a rAF tick
   * counter that never resets (ARCHITECTURE.md §3.5 doesn't require it to),
   * so a take armed after any rehearsal would otherwise record thousands of
   * frames of dead lead-in and replay far longer than the performance (the
   * take-baselining defect this field fixes). Defaults to 0 so every existing
   * caller/test that constructs a recorder without a second argument (always
   * at a fresh engine's frame 0) is unaffected. */
  private readonly startFrame: number

  constructor(snapshot: SessionSnapshot, startFrame = 0) {
    this.snapshot = snapshot
    this.startFrame = startFrame
  }

  /** Absolute transport frame -> relative-to-`startFrame`, clamped at 0. Every
   * frame the engine reports here is `transport.frame`, which only advances
   * monotonically once recording is armed, so a negative result should be
   * unreachable — the clamp is a defensive floor (never crash a live
   * performance over an off-by-one), not a expected code path. */
  private relative(frame: number): number {
    return Math.max(0, frame - this.startFrame)
  }

  recordInput(frame: number, event: SourceEvent): void {
    this.events.push({ frame: this.relative(frame), type: 'input', event })
  }

  recordInputSignal(frame: number, name: string, value: number): void {
    this.events.push({ frame: this.relative(frame), type: 'inputSignal', name, value })
  }

  recordParam(frame: number, name: string, value: number): void {
    this.events.push({ frame: this.relative(frame), type: 'param', name, value })
  }

  recordBinding(frame: number, param: string, src: string | null): void {
    this.events.push({ frame: this.relative(frame), type: 'binding', param, src })
  }

  recordShader(frame: number, key: string, source: string): void {
    this.events.push({ frame: this.relative(frame), type: 'shader', key, source })
  }

  /** Scene handoff (docs/HANDOFF.md §5): records only the target scene id —
   * the handoff snapshot itself is never serialized (invariant I7); it is
   * recomputed on replay by re-capturing A's re-rendered frame. */
  recordSwitch(frame: number, toScene: string): void {
    this.events.push({ frame: this.relative(frame), type: 'switch', toScene })
  }

  finish(frame: number): SessionDoc {
    const transportFrames = this.relative(frame)
    // DATA-LOSS GUARD (user lost a 6-minute performance): if the transport's
    // frame counter stalled or rewound during the take, the frame-based
    // duration can read 0 even though minutes of events were recorded — and
    // the App's empty-take rejection then threw the whole performance away.
    // A take that CONTAINS events is never empty: recover its length from
    // the last recorded event plus a one-second tail, so the performance is
    // preserved (replayable/exportable, even if the underlying clock fault
    // squeezed its timing) instead of destroyed. A take with no events and
    // no frames stays 0 — genuinely empty, and rejected downstream as before.
    const lastEventFrame = this.events.reduce((m, e) => Math.max(m, e.frame), 0)
    const durationFrames =
      transportFrames <= 0 && this.events.length > 0
        ? lastEventFrame + this.snapshot.fps
        : transportFrames
    return {
      version: 1,
      seed: this.snapshot.seed,
      fps: this.snapshot.fps,
      scene: {
        id: this.snapshot.sceneId,
        params: { ...this.snapshot.params },
        ...(this.snapshot.shaders !== undefined ? { shaders: { ...this.snapshot.shaders } } : {}),
        ...(this.snapshot.image !== undefined ? { image: { ...this.snapshot.image } } : {}),
      },
      bindings: { ...this.snapshot.bindings },
      audio: this.snapshot.audio ?? { kind: 'demo' },
      durationFrames,
      events: this.events.slice(),
    }
  }
}
