import { Transport, type TransportMode } from '../core/transport'
import { SignalBus } from '../core/signals'
import { Gpu } from '../gpu/context'
import { AudioEngine, publishDemoSignals } from '../audio/engine'
import { AudioEventDetector } from '../audio/events'
import { compile, type CompiledExpr } from '../dsl/compile'
import { DslState } from '../dsl/state'
import type { SceneRuntime } from '../scenes/types'
import { MappingRuntime } from '../mapping/runtime'
import { DEFAULT_MAPPINGS } from '../mapping/defaults'
import type { SourceEvent } from '../mapping/types'
import { SessionRecorder } from '../session/recorder'
import { SessionPlayer, type PlayerTarget } from '../session/player'
import type { SessionDoc } from '../session/types'

interface Binding {
  src: string
  compiled: CompiledExpr
  state: DslState
}

export interface EngineOptions {
  mode: TransportMode
  seed: number
  width: number
  height: number
  /** Fixed-timestep rate for render mode. */
  fps?: number
}

/**
 * Ties transport + signal bus + audio + scene into one loop. Live mode runs on
 * rAF paced by the audio clock; render mode steps deterministically under
 * external control (export pipeline, golden-image tests).
 */
export class Engine {
  readonly transport: Transport
  readonly bus = new SignalBus()
  readonly gpu: Gpu
  readonly audio = new AudioEngine()
  readonly events = new AudioEventDetector()
  readonly scene: SceneRuntime
  readonly seed: number
  readonly mappings: MappingRuntime

  private raf = 0
  private running = false
  private bindings = new Map<string, Binding>()
  private inputSignals = new Map<string, number>()

  private recorder: SessionRecorder | null = null
  private player: SessionPlayer | null = null
  /**
   * Routes replayed events into the live pipeline while bypassing recording —
   * queueInput goes straight to `mappings.queue` (not `this.queueInput`) so a
   * replayed session never re-records itself; setBinding/clearBinding reuse the
   * engine methods (they need DSL compilation) but that's safe because replay
   * only ever runs with `recorder` null.
   */
  private readonly playerTarget: PlayerTarget = {
    queueInput: (e) => this.mappings.queue(e),
    setInputSignal: (name, value) => this.inputSignals.set(name, value),
    setParam: (name, value) => this.scene.setParam(name, value),
    setBinding: (param, src) => this.setBinding(param, src),
    clearBinding: (param) => this.clearBinding(param),
  }

  constructor(canvas: HTMLCanvasElement, scene: SceneRuntime, opts: EngineOptions) {
    this.transport = new Transport(opts.mode, opts.fps ?? 60)
    this.gpu = new Gpu(canvas, { width: opts.width, height: opts.height })
    this.scene = scene
    this.seed = opts.seed
    this.mappings = new MappingRuntime(DEFAULT_MAPPINGS)
    scene.init(this.gpu, opts.seed)
  }

  /** Live mode: start the rAF loop. */
  start(): void {
    if (this.transport.mode !== 'live' || this.running) return
    this.running = true
    let fallbackClock = 0
    const loop = () => {
      if (!this.running) return
      // Audio clock when playing; otherwise a steady rAF-paced clock. The
      // fallback is the one place live mode touches frame pacing directly.
      const time = this.audio.isPlaying ? this.audio.time : (fallbackClock += 1 / 60)
      this.tick(time)
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  stop(): void {
    this.running = false
    cancelAnimationFrame(this.raf)
  }

  /** Render mode: step exactly n fixed-timestep frames. */
  renderFrames(n: number): void {
    if (this.transport.mode !== 'render') throw new Error('renderFrames() is render-mode only')
    for (let i = 0; i < n; i++) {
      if (this.player) this.player.applyUpTo(this.transport.frame, this.playerTarget)
      const frame = this.transport.step()
      this.updateAndRender(frame.time, frame)
    }
  }

  /**
   * The sanctioned entry point for key/trigger input (ARCHITECTURE.md §3.4):
   * records the event (if a recording is armed) and forwards it to the mapping
   * layer. Frontends (keyboard, touch pads) and the test harness call this
   * rather than `mappings.queue` directly, so every live input is captured for
   * session replay.
   */
  queueInput(e: SourceEvent): void {
    if (this.recorder) this.recorder.recordInput(this.transport.frame, e)
    this.mappings.queue(e)
  }

  setParam(name: string, value: number): void {
    if (this.recorder) this.recorder.recordParam(this.transport.frame, name, value)
    this.scene.setParam(name, value)
  }

  /**
   * Continuous-input signals (e.g. an XY touch pad) that persist on the bus every
   * frame until changed again — unlike mapping actions, these are just named
   * numbers for expressions/scenes to read, published before bindings each frame.
   */
  setInputSignal(name: string, value: number): void {
    if (this.recorder) this.recorder.recordInputSignal(this.transport.frame, name, value)
    this.inputSignals.set(name, value)
  }

  /**
   * Bind a scene param to a DSL expression, evaluated every frame before the scene
   * updates (the "equations" layer of the authoring model). Throws DslError on bad
   * source — callers surface it inline and the previous binding stays active.
   */
  setBinding(param: string, src: string): void {
    const compiled = compile(src, `${this.scene.meta.id}.${param}`)
    if (this.recorder) this.recorder.recordBinding(this.transport.frame, param, src)
    this.bindings.set(param, { src, compiled, state: new DslState() })
  }

  clearBinding(param: string): void {
    if (this.recorder) this.recorder.recordBinding(this.transport.frame, param, null)
    this.bindings.delete(param)
  }

  getBinding(param: string): string | undefined {
    return this.bindings.get(param)?.src
  }

  /** True while a session recording is in progress (`startRecording()` ran, `stopRecording()` hasn't). */
  get isRecording(): boolean {
    return this.recorder !== null
  }

  /** Snapshots current engine state and starts recording every input/param/binding change. */
  startRecording(): void {
    const params: Record<string, number> = {}
    for (const p of this.scene.params) params[p.name] = this.scene.getParam(p.name)
    const bindings: Record<string, string> = {}
    for (const [param, b] of this.bindings) bindings[param] = b.src
    this.recorder = new SessionRecorder({
      seed: this.seed,
      fps: this.transport.fps,
      sceneId: this.scene.meta.id,
      params,
      bindings,
    })
  }

  /** Stops recording and returns the finished session doc, or null if nothing was recording. */
  stopRecording(): SessionDoc | null {
    if (!this.recorder) return null
    const doc = this.recorder.finish(this.transport.frame)
    this.recorder = null
    return doc
  }

  /**
   * Deterministic replay (ARCHITECTURE.md §3.5): resets transport, bus, mapping
   * state, input signals, and bindings to cold-start, re-initializes the scene
   * with the session's seed and initial params/bindings, then arms a player that
   * feeds the recorded event log back through the pipeline as frames advance
   * (see `renderFrames`/`tick`).
   */
  loadSession(doc: SessionDoc): void {
    this.transport.reset()
    this.bus.clear()
    this.mappings.reset()
    this.events.reset()
    this.inputSignals.clear()
    this.bindings.clear()

    this.scene.dispose()
    this.scene.init(this.gpu, doc.seed)
    for (const [name, value] of Object.entries(doc.scene.params)) {
      this.scene.setParam(name, value)
    }
    for (const [param, src] of Object.entries(doc.bindings)) {
      this.setBinding(param, src)
    }

    this.player = new SessionPlayer(doc)
  }

  /** Disarms the active replay player (no-op if none is armed). */
  clearSession(): void {
    this.player = null
  }

  /** True once an armed player has applied every recorded event (false if none is armed). */
  get replayDone(): boolean {
    return this.player !== null && this.player.done
  }

  /** Stops the loop and releases scene GPU resources — call before discarding an engine. */
  dispose(): void {
    this.stop()
    this.scene.dispose()
  }

  private tick(time: number): void {
    if (this.player) this.player.applyUpTo(this.transport.frame, this.playerTarget)
    const frame = this.transport.advanceTo(time)
    this.updateAndRender(time, frame)
  }

  private updateAndRender(time: number, frame: { time: number; dt: number; frame: number }): void {
    if (this.audio.isPlaying) {
      this.audio.publishSignals(this.bus)
    } else {
      publishDemoSignals(this.bus, time)
    }
    const ev = this.events.update(frame.dt, frame.time, this.bus, !this.audio.isPlaying)
    this.bus.set('onset', ev.onset ? 1 : 0)
    this.bus.set('beat', ev.beat ? 1 : 0)
    this.bus.set('beatPhase', ev.beatPhase)
    this.bus.set('onsetStrength', ev.onsetStrength)
    for (const [name, value] of this.inputSignals) {
      this.bus.set(name, value)
    }
    for (const [param, b] of this.bindings) {
      this.scene.setParam(
        param,
        b.compiled.evaluate({
          time: frame.time,
          dt: frame.dt,
          frame: frame.frame,
          signals: this.bus,
          state: b.state,
        }),
      )
    }
    this.mappings.update(frame.dt, this.bus, {
      get: (n) => this.scene.getParam(n),
      set: (n, v) => this.scene.setParam(n, v),
    })
    const ctx = { frame, signals: this.bus }
    this.scene.update(ctx)
    this.scene.render(ctx)
  }
}
