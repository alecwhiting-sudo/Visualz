import type { SourceEvent } from '../mapping/types'
import type { SessionDoc } from './types'

/**
 * The narrow surface the player drives. Deliberately excludes Engine to avoid
 * an import cycle (session/ -> engine/ -> session/) — the engine adapts itself
 * to this shape when arming a player (see engine.ts).
 */
export interface PlayerTarget {
  queueInput(e: SourceEvent): void
  setInputSignal(name: string, value: number): void
  setParam(name: string, value: number): void
  setBinding(param: string, src: string): void
  clearBinding(param: string): void
  /** Code-layer hot-recompile (ARCHITECTURE.md §3.3). Routed straight to the
   * scene, bypassing recording — see engine.ts's `playerTarget`. A compile
   * error here means the doc is corrupt (it was recorded with a compiling
   * shader), so it throws rather than swallowing the failure. */
  setShaderSource(key: string, source: string): void
}

/**
 * Session player (ARCHITECTURE.md §3.5): replays a recorded event log through
 * a `PlayerTarget`. A single monotonic cursor guarantees every event applies
 * exactly once, in recorded order — `applyUpTo` is safe to call every frame
 * with the current (possibly repeated or advancing) frame number.
 */
export class SessionPlayer {
  private readonly doc: SessionDoc
  private cursor = 0

  constructor(doc: SessionDoc) {
    this.doc = doc
  }

  /** True once every recorded event has been applied. */
  get done(): boolean {
    return this.cursor >= this.doc.events.length
  }

  /** Applies, in recorded order, every not-yet-applied event with `event.frame <= frame`. */
  applyUpTo(frame: number, target: PlayerTarget): void {
    const events = this.doc.events
    while (this.cursor < events.length && events[this.cursor].frame <= frame) {
      const event = events[this.cursor]
      switch (event.type) {
        case 'input':
          target.queueInput(event.event)
          break
        case 'inputSignal':
          target.setInputSignal(event.name, event.value)
          break
        case 'param':
          target.setParam(event.name, event.value)
          break
        case 'binding':
          if (event.src === null) target.clearBinding(event.param)
          else target.setBinding(event.param, event.src)
          break
        case 'shader':
          target.setShaderSource(event.key, event.source)
          break
      }
      this.cursor++
    }
  }
}
