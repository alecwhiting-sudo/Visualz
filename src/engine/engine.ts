import { Transport, type TransportMode } from '../core/transport'
import { SignalBus } from '../core/signals'
import { Gpu } from '../gpu/context'
import { DefaultSurface } from '../gpu/targets'
import { AudioEngine, publishDemoSignals } from '../audio/engine'
import { AudioEventDetector, type AudioEventResult } from '../audio/events'
import { sampleTimeline, serializeTimeline, parseTimeline } from '../audio/timeline'
import type { FeatureTimeline } from '../audio/analysis'
import { compile, type CompiledExpr } from '../dsl/compile'
import { DslState } from '../dsl/state'
import type { SceneRuntime, ShaderStage } from '../scenes/types'
import { MappingRuntime } from '../mapping/runtime'
import { DEFAULT_MAPPINGS } from '../mapping/defaults'
import type { SourceEvent } from '../mapping/types'
import { SessionRecorder } from '../session/recorder'
import { SessionPlayer, type PlayerTarget } from '../session/player'
import type { SessionAudio, SessionDoc } from '../session/types'
import { decodeImageBase64, encodeImageBase64 } from './imageCodec'

interface Binding {
  src: string
  compiled: CompiledExpr
  state: DslState
}

/** A scene's imported-media snapshot (Photo Swarm task): duck-typed, not part
 * of `SceneRuntime` — most scenes have no imported-media concept. */
export interface SceneImage {
  width: number
  height: number
  data: Uint8ClampedArray
}

interface ImageCapableScene {
  setImage(img: SceneImage | null): void
}

function acceptsImage(scene: SceneRuntime): scene is SceneRuntime & ImageCapableScene {
  return typeof (scene as unknown as Partial<ImageCapableScene>).setImage === 'function'
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
  /** The canvas as the scene's render destination — always this in v1 (no
   * combiner scene yet), but scenes read viewport/aspect from it, not `gpu`. */
  private readonly surface: DefaultSurface

  private raf = 0
  private running = false
  private bindings = new Map<string, Binding>()
  private inputSignals = new Map<string, number>()

  private recorder: SessionRecorder | null = null
  private player: SessionPlayer | null = null
  /** Last image handed to `setSceneImage`, kept so `startRecording` can
   * snapshot it and callers can reapply it after swapping to a new scene
   * instance (App.tsx's scene-switch flow constructs a fresh Engine/scene per
   * switch, so "reapply on scene change" is that caller's responsibility —
   * this field is what it reapplies from). `null` after an explicit
   * `setSceneImage(null)` or a `loadSession` whose doc had no `scene.image`. */
  private storedImage: SceneImage | null = null
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
    // Straight to the scene, bypassing this.setShaderSource (and thus
    // recording) — same reasoning as setParam above (mirrors setBinding's
    // reuse pattern in the comment on this field). A compile error on replay
    // means the doc is corrupt and should throw, not silently keep the old
    // program.
    setShaderSource: (key, source) => {
      if (!this.scene.setShaderSource) {
        throw new Error(`Session references shader stage "${key}" but scene "${this.scene.meta.id}" has no code layer`)
      }
      this.scene.setShaderSource(key, source)
    },
  }

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, scene: SceneRuntime, opts: EngineOptions) {
    this.transport = new Transport(opts.mode, opts.fps ?? 60)
    this.gpu = new Gpu(canvas, { width: opts.width, height: opts.height })
    this.surface = new DefaultSurface(this.gpu)
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
      // Audio clock once a file has been loaded (gated on `hasFile`, not
      // `isPlaying`: `AudioEngine.time` is frozen at the held offset while
      // paused/stopped, and feeding that frozen value straight into
      // `transport.advanceTo` is what freezes the visuals with it — falling
      // back to the free-running clock on pause would instead make the demo
      // clock take over and the visuals jump). No file loaded at all keeps the
      // steady rAF-paced fallback clock (demo mode dances on its own).
      const time = this.audio.hasFile ? this.audio.time : (fallbackClock += 1 / 60)
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
   * Transport controls (play/pause/stop/seek), gated on recording: the session
   * model assumes a monotonically advancing transport (recordInput/Param/etc.
   * are keyed by `transport.frame`), so pausing, seeking, or stopping mid-
   * recording would let the audio clock — and therefore `frame.time` — jump or
   * freeze in a way the recorded log can't represent. Reject as a no-op rather
   * than recording something replay couldn't reproduce; App.tsx also disables
   * the transport UI while `isRecording`, this is the belt to that suspenders.
   */
  pauseAudio(): void {
    if (this.isRecording) return
    this.audio.pause()
  }

  resumeAudio(): void {
    if (this.isRecording) return
    this.audio.resume()
  }

  /**
   * Intentionally does NOT reset scene state (kaleido feedback trails, tunnel
   * ring phase, Gray-Scott chemical field, particle positions, …) — this is a
   * live instrument, not a video scrubber, so a seek is a jump in *time*, not a
   * rewind of the running simulation. Audio-derived signals (bass/beat/etc.)
   * still jump correctly because they're a pure lookup by time on the
   * FeatureTimeline (see `updateAndRender`); only per-scene state carries on
   * from wherever it was.
   */
  seekAudio(seconds: number): void {
    if (this.isRecording) return
    this.audio.seek(seconds)
  }

  stopAudio(): void {
    if (this.isRecording) return
    this.audio.stop()
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

  /**
   * Code layer pass-through (ARCHITECTURE.md §3.3). Throws on GLSL error (the
   * scene's `gpu.compileProgram` log) — the caller surfaces it inline and the
   * scene's last good program keeps rendering. Records the edit when a
   * recording is armed (only on success, mirroring `setBinding`).
   */
  setShaderSource(key: string, source: string): void {
    if (!this.scene.setShaderSource) {
      throw new Error(`Scene "${this.scene.meta.id}" has no shader code layer`)
    }
    this.scene.setShaderSource(key, source)
    if (this.recorder) this.recorder.recordShader(this.transport.frame, key, source)
  }

  /** `[]` when the scene doesn't implement the code layer. */
  getShaderSources(): ShaderStage[] {
    return this.scene.getShaderSources ? this.scene.getShaderSources() : []
  }

  /**
   * Image material for image-driven scenes (Photo Swarm task): forwards to
   * the scene via a duck-typed `setImage` and remembers the snapshot
   * regardless of whether the current scene accepts it, so a caller that
   * switches scenes afterward can decide to reapply it. `null` reverts an
   * image-capable scene to its built-in fallback.
   */
  setSceneImage(img: SceneImage | null): void {
    this.storedImage = img
    if (acceptsImage(this.scene)) this.scene.setImage(img)
  }

  /** Duck-type check for the UI: does the current scene accept `setSceneImage`? */
  sceneAcceptsImage(): boolean {
    return acceptsImage(this.scene)
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
      this.audio.hasFile && this.audio.timeline
        ? { kind: 'file', name: this.audio.fileName ?? 'audio', timeline: serializeTimeline(this.audio.timeline) }
        : { kind: 'demo' }
    // Snapshot ALL current stage sources (not just edited ones) — dead simple
    // and correct, at the cost of ~2-6KB per doc (docs the tradeoff rather than
    // diffing against scene defaults, which would need a throwaway scene
    // instance). Undefined (not `{}`) for scenes with no code layer.
    const shaders = this.scene.getShaderSources
      ? Object.fromEntries(this.scene.getShaderSources().map((s) => [s.key, s.source]))
      : undefined
    // Photo Swarm task: the stored image, base64-encoded, or omitted entirely
    // (not even `{}`) when none has been set — mirrors `shaders` above.
    const image = this.storedImage
      ? {
          width: this.storedImage.width,
          height: this.storedImage.height,
          data: encodeImageBase64(this.storedImage.data),
        }
      : undefined
    this.recorder = new SessionRecorder({
      seed: this.seed,
      fps: this.transport.fps,
      sceneId: this.scene.meta.id,
      params,
      bindings,
      audio,
      shaders,
      image,
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
    if (doc.scene.id !== this.scene.meta.id) {
      throw new Error(`Session scene "${doc.scene.id}" does not match constructed scene "${this.scene.meta.id}"`)
    }
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
    for (const [key, source] of Object.entries(doc.scene.shaders ?? {})) {
      if (!this.scene.setShaderSource) {
        throw new Error(
          `Session scene.shaders references shader stage "${key}" but scene "${this.scene.meta.id}" has no code layer`,
        )
      }
      this.scene.setShaderSource(key, source)
    }

    // Photo Swarm task: apply doc.scene.image if present and the scene accepts
    // images; silently ignored (not thrown) if the scene has no `setImage` —
    // unlike shaders/bindings, an image-driven scene id is not guaranteed by
    // `doc.scene.id` alone (a hand-edited doc could carry a stale image field
    // after a scene swap). Reapplying unconditionally (rather than only when
    // `doc.scene.image` is present) makes the scene's image state a pure
    // function of the doc, independent of whatever this Engine/scene instance
    // rendered before this call.
    if (acceptsImage(this.scene)) {
      this.storedImage = doc.scene.image
        ? { width: doc.scene.image.width, height: doc.scene.image.height, data: decodeImageBase64(doc.scene.image.data) }
        : null
      this.scene.setImage(this.storedImage)
    } else {
      this.storedImage = null
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
   * that's currently loaded live (playing, paused, or stopped) with its
   * analysis done — is strictly better than the live `AudioEventDetector`
   * (non-causal, sees the whole track) and takes over both band publishing AND
   * onset/beat/beatPhase; the detector does not run in that case. A loaded
   * file with no timeline yet (analysis still running/failed) freezes instead
   * of falling back while paused/stopped (see below). Everything else (no
   * audio loaded at all, or a future mic path) keeps today's
   * publishDemoSignals/analyser + AudioEventDetector behavior.
   */
  private updateAndRender(time: number, frame: { time: number; dt: number; frame: number }): void {
    const timeline =
      this.player !== null
        ? this.sessionTimeline
        : // `hasFile`, not `isPlaying`: a paused/stopped-but-loaded file keeps
          // sampling its timeline at the (frozen) transport time, so signals
          // hold steady with the visuals instead of falling back to demo
          // signals the instant playback pauses.
          this.audio.hasFile
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
    } else if (this.audio.isPlaying) {
      if (this.detectorStale) {
        this.events.reset()
        this.detectorStale = false
      }
      this.audio.publishSignals(this.bus)
      ev = this.events.update(frame.dt, frame.time, this.bus, false)
    } else if (this.audio.hasFile) {
      // Paused/stopped with a file loaded but no timeline yet (analysis still
      // running, or it failed): freeze rather than read the analyser (its
      // source is disconnected while paused, so it would decay toward silence)
      // or fall back to demo signals (a visible discontinuity) — hold the bus
      // and event state at whatever they last were.
      this.detectorStale = true
      ev = {
        onset: false,
        beat: false,
        beatPhase: this.bus.get('beatPhase'),
        onsetStrength: this.bus.get('onsetStrength'),
      }
    } else {
      if (this.detectorStale) {
        this.events.reset()
        this.detectorStale = false
      }
      publishDemoSignals(this.bus, time)
      ev = this.events.update(frame.dt, frame.time, this.bus, true)
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
    this.scene.render(ctx, this.surface)
  }
}
