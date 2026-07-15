import { Transport, type TransportMode } from '../core/transport'
import { SignalBus } from '../core/signals'
import { Gpu } from '../gpu/context'
import { AudioEngine, publishDemoSignals } from '../audio/engine'
import { AudioEventDetector, type AudioEventResult } from '../audio/events'
import { sampleTimeline, serializeTimeline, parseTimeline } from '../audio/timeline'
import type { FeatureTimeline } from '../audio/analysis'
import { compile, type CompiledExpr } from '../dsl/compile'
import { DslState } from '../dsl/state'
import type { SceneRuntime } from '../scenes/types'
import { MappingRuntime } from '../mapping/runtime'
import { DEFAULT_MAPPINGS } from '../mapping/defaults'
import type { SourceEvent } from '../mapping/types'
import { SessionRecorder } from '../session/recorder'
import { SessionPlayer, type PlayerTarget } from '../session/player'
import type { SessionAudio, SessionDoc } from '../session/types'

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
  /** Set by `loadSession` when the loaded doc's audio is `kind: 'file'`; drives
   * signal publishing during replay instead of the (stopped) live AudioEngine. */
  private sessionTimeline: FeatureTimeline | null = null
  /** Set while timeline lookup drives signals; the causal detector resets on the
   * next non-timeline frame so it never resumes from frozen adaptive state. */
  private detectorStale = false
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

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, scene: SceneRuntime, opts: EngineOptions) {
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
    // Absent in DedicatedWorkerGlobalScope, where render-mode engines run (export).
    if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this.raf)
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

  /**
   * Snapshots current engine state and starts recording every input/param/binding
   * change. The boundary is edge-based, like starting a tape mid-note: state held
   * across it (pressed keys, in-flight ramps) is not captured — replay reproduces
   * events from here on. Active pulse contributions are subtracted from the param
   * snapshot so a decaying transient isn't baked in as the permanent base.
   *
   * The `audio` field is captured the same way: if a file is currently playing
   * with a finished analysis, the doc gets `{kind:'file', name, timeline}` (the
   * offline `FeatureTimeline`, serialized); otherwise `{kind:'demo'}`. This is
   * also edge-based — loading a *different* file mid-recording is not captured;
   * the doc keeps referencing whatever was playing when recording started, even
   * though the live engine keeps dancing to the new track underneath it.
   */
  startRecording(): void {
    const params: Record<string, number> = {}
    for (const p of this.scene.params) {
      params[p.name] = this.scene.getParam(p.name) - this.mappings.pulseOffset(p.name)
    }
    const bindings: Record<string, string> = {}
    for (const [param, b] of this.bindings) bindings[param] = b.src
    const audio: SessionAudio =
      this.audio.isPlaying && this.audio.timeline
        ? { kind: 'file', name: this.audio.fileName ?? 'audio', timeline: serializeTimeline(this.audio.timeline) }
        : { kind: 'demo' }
    this.recorder = new SessionRecorder({
      seed: this.seed,
      fps: this.transport.fps,
      sceneId: this.scene.meta.id,
      params,
      bindings,
      audio,
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
    this.audio.stop() // demo-signal replay must never read a live analyser
    this.recorder = null // replay must not re-record itself (playerTarget relies on this)
    this.transport.reset()
    this.bus.clear()
    this.mappings.reset()
    this.events.reset()
    this.inputSignals.clear()
    this.bindings.clear()

    this.sessionTimeline = null
    if (doc.audio.kind === 'file') {
      try {
        this.sessionTimeline = parseTimeline(doc.audio.timeline)
      } catch (err) {
        throw new Error(`Session audio timeline is invalid: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

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
    this.sessionTimeline = null
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

  /**
   * Signal-source priority (docs/ANALYSIS.md §12): a whole-track offline
   * `FeatureTimeline` — sessions replaying `audio.kind === 'file'`, or a file
   * currently playing live with its analysis done — is strictly better than
   * the live `AudioEventDetector` (non-causal, sees the whole track) and takes
   * over both band publishing AND onset/beat/beatPhase; the detector does not
   * run in that case. Everything else (no timeline: demo sessions, no audio
   * loaded, or a future mic path) keeps today's publishDemoSignals/analyser +
   * AudioEventDetector behavior.
   */
  private updateAndRender(time: number, frame: { time: number; dt: number; frame: number }): void {
    const timeline =
      this.player !== null
        ? this.sessionTimeline
        : this.audio.isPlaying
          ? this.audio.timeline
          : null

    let ev: AudioEventResult
    if (timeline) {
      const s = sampleTimeline(timeline, frame.time, frame.dt)
      this.bus.set('rms', s.rms)
      this.bus.set('bass', s.bass)
      this.bus.set('mid', s.mid)
      this.bus.set('high', s.high)
      ev = { onset: s.onset === 1, beat: s.beat === 1, beatPhase: s.beatPhase, onsetStrength: s.onsetStrength }
      // The causal detector isn't run on timeline frames, so its adaptive state
      // goes stale; make the next non-timeline frame start it fresh.
      this.detectorStale = true
    } else {
      if (this.detectorStale) {
        this.events.reset()
        this.detectorStale = false
      }
      if (this.audio.isPlaying) {
        this.audio.publishSignals(this.bus)
      } else {
        publishDemoSignals(this.bus, time)
      }
      ev = this.events.update(frame.dt, frame.time, this.bus, !this.audio.isPlaying)
    }
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
