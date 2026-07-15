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

  constructor(snapshot: SessionSnapshot) {
    this.snapshot = snapshot
  }

  recordInput(frame: number, event: SourceEvent): void {
    this.events.push({ frame, type: 'input', event })
  }

  recordInputSignal(frame: number, name: string, value: number): void {
    this.events.push({ frame, type: 'inputSignal', name, value })
  }

  recordParam(frame: number, name: string, value: number): void {
    this.events.push({ frame, type: 'param', name, value })
  }

  recordBinding(frame: number, param: string, src: string | null): void {
    this.events.push({ frame, type: 'binding', param, src })
  }

  finish(frame: number): SessionDoc {
    return {
      version: 1,
      seed: this.snapshot.seed,
      fps: this.snapshot.fps,
      scene: { id: this.snapshot.sceneId, params: { ...this.snapshot.params } },
      bindings: { ...this.snapshot.bindings },
      audio: this.snapshot.audio ?? { kind: 'demo' },
      durationFrames: frame,
      events: this.events.slice(),
    }
  }
}
