import { Transport, type TransportMode } from '../core/transport'
import { SignalBus } from '../core/signals'
import { Gpu } from '../gpu/context'
import { DefaultSurface, FullscreenPass } from '../gpu/targets'
import { AudioEngine, publishDemoSignals } from '../audio/engine'
import { AudioEventDetector, type AudioEventResult } from '../audio/events'
import { sampleTimeline, serializeTimeline, parseTimeline } from '../audio/timeline'
import type { FeatureTimeline } from '../audio/analysis'
import { compile, type CompiledExpr } from '../dsl/compile'
import { DslState } from '../dsl/state'
import type { IngestingScene, ParamSchema, SceneRuntime, SceneSnapshot, ShaderStage } from '../scenes/types'
import { SCENES } from '../scenes/registry'
import { MappingRuntime } from '../mapping/runtime'
import { DEFAULT_MAPPINGS } from '../mapping/defaults'
import { MACRO_SLOT_COUNT, MacroRouter } from './macroRouter'
import type { SourceEvent } from '../mapping/types'
import { SessionRecorder } from '../session/recorder'
import { SessionPlayer, type PlayerTarget } from '../session/player'
import type { SessionAudio, SessionDoc } from '../session/types'
import { readSurfaceSnapshot } from '../gpu/snapshot'
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

/** Scene handoff (docs/HANDOFF.md §2/§4): duck-type check for the ingest
 * capability, mirroring `acceptsImage` above. */
function hasIngest(scene: SceneRuntime): scene is SceneRuntime & IngestingScene {
  return typeof (scene as unknown as Partial<IngestingScene>).ingest === 'function'
}

/** Rounds to 1e-4 seconds (~0.1ms) — plenty of precision for a take's start
 * offset, keeps the serialized doc's number tidy rather than carrying whatever
 * float noise `AudioContext.currentTime`/the transport clock produced. */
function round4(seconds: number): number {
  return Math.round(seconds * 1e4) / 1e4
}

/** Handoff glide: `handoff.fade` values at/below this are a hard cut — the
 * UI dial's bottom stop means "cut", and the full-res frame copy is skipped
 * entirely so an unset signal costs nothing. */
const HANDOFF_CUT_THRESHOLD = 0.15

/** Held "UI mode" input signals baselined into a take at `startRecording`
 * (each is a review-finding class: set before arming, it silently shaped the
 * live performance — knob routing, handoff dissolve length — but replayed at
 * its default, diverging export from performance). Held `ctl.N` values are
 * deliberately NOT in this list; see the comment at the baseline site. */
const BASELINED_SIGNALS = ['macro.view', 'handoff.fade']

/** Fullscreen dissolve overlay for the handoff glide: samples A's captured
 * final frame at decaying alpha. Positions from gl_VertexID (FullscreenPass
 * draws 3 vertices, no VBO), uv = clip*0.5+0.5 — matches copyTexImage2D's
 * bottom-left origin, so no flip. */
const FADE_OVERLAY_VS = `#version 300 es
out vec2 vUV;
void main() {
  vec2 pos = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  vUV = pos * 0.5 + 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}`
const FADE_OVERLAY_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform float uAlpha;
in vec2 vUV;
out vec4 outColor;
void main() {
  outColor = vec4(texture(uTex, vUV).rgb, uAlpha);
}`

export interface EngineOptions {
  mode: TransportMode
  seed: number
  width: number
  height: number
  /** Fixed-timestep rate for render mode. */
  fps?: number
  /** Adopt an existing AudioEngine instead of creating a fresh one — used by
   * scene switches, which rebuild the whole Engine but must keep the loaded
   * track playing (and its transport row alive) across the swap. */
  audio?: AudioEngine
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
  readonly audio: AudioEngine
  readonly events = new AudioEventDetector()
  /** Mutable (docs/HANDOFF.md §9, core-interface change, architect-approved):
   * an in-place scene switch must reassign this. Backed by a private field +
   * public getter rather than a bare mutable property so every external
   * reader (App.tsx: `engine.scene.params`, `.meta`, …) keeps going through
   * one property access that always observes the current scene. */
  private _scene: SceneRuntime
  get scene(): SceneRuntime {
    return this._scene
  }
  readonly seed: number
  readonly mappings: MappingRuntime
  /** The canvas as the scene's render destination — always this in v1 (no
   * combiner scene yet), but scenes read viewport/aspect from it, not `gpu`. */
  private readonly surface: DefaultSurface

  private raf = 0
  private running = false
  private bindings = new Map<string, Binding>()
  private inputSignals = new Map<string, number>()
  /** Macro controls (docs/MACROS.md): eight `ctl.N` slots that drive the
   * current scene's params positionally once engaged, surviving scene
   * switches. Reset in the constructor, `switchScene`, and `loadSession`
   * (§2/§4) — a cold scene change (a brand new `Engine`) resets for free
   * since this field is allocated fresh per instance. */
  private readonly macros = new MacroRouter()

  private recorder: SessionRecorder | null = null
  private player: SessionPlayer | null = null
  /**
   * Handoff glide (user request — "a glide for handoffs like the frame
   * glide"): when the recorded `handoff.fade` input signal is above
   * HANDOFF_CUT_THRESHOLD at the moment `switchScene` runs, A's final frame
   * is copied into a full-res texture and composited over B with alpha
   * decaying from 1 to 0 across `duration` seconds of transport time — a
   * dissolve from the old scene into the new one. Below the threshold (the
   * default — the signal is absent until the UI knob writes it) no copy is
   * even made and the switch stays today's hard cut. Deterministic: the
   * duration is a recorded signal, the clock is transport time, and the
   * overlay runs identically in live, replay, and export engines.
   */
  private handoffFade: { tex: WebGLTexture; startTime: number; duration: number } | null = null
  private fadeProgram: WebGLProgram | null = null
  private fadePass: FullscreenPass | null = null
  private fadeAlphaLoc: WebGLUniformLocation | null = null
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
  /**
   * `transport.frame` right after `loadSession`'s `transport.reset(doc.audio.
   * startSeconds ?? 0)` — i.e. `round(startSeconds * fps)`, or 0 for a doc with
   * no `startSeconds` (and always 0 for a live, non-replaying engine, since only
   * `loadSession` sets this).
   *
   * Session events are recorded RELATIVE to the take's own start (`SessionRecorder`
   * baselines every event to `startFrame`), so they're `0`-based regardless of
   * `startSeconds`. But `reset(startSeconds)` now seeds the transport's frame
   * counter to match (so `frame.time`/`frame.frame` agree, per the transport's own
   * seeding rule) — meaning `transport.frame` itself is no longer 0-based during
   * replay/export. `applyUpTo` needs the two to line up, so both call sites
   * (`renderFrames`, `tick`) subtract this back off before comparing against the
   * doc's 0-based event frames. Old docs (no `startSeconds`) get offset 0, so
   * `transport.frame - playerFrameOffset === transport.frame` — byte-identical
   * to pre-fix behavior.
   */
  private playerFrameOffset = 0
  /** Set while timeline lookup drives signals; the causal detector resets on the
   * next non-timeline frame so it never resumes from frozen adaptive state. */
  private detectorStale = false
  /**
   * Set by every control-surface mutation (params, input signals, queued
   * trigger events, bindings, shader edits, scene switches, image loads,
   * seeks) and consumed by the live loop's frozen branch: a loaded track that
   * isn't playing normally skips ticks entirely (see `start()`), which used
   * to make MIDI knobs and UI sliders dead until play was pressed — you
   * couldn't "get in position" before a take. When this flag is up, the
   * frozen branch runs ONE reduced tick — routing + bindings + render at the
   * frozen clock, but no `scene.update()`, so frame-clocked simulations
   * (Gray-Scott et al.) still don't simmer through a pause.
   */
  private controlsDirty = false
  /**
   * Routes replayed events into the live pipeline while bypassing recording —
   * queueInput goes straight to `mappings.queue` (not `this.queueInput`) so a
   * replayed session never re-records itself; setBinding/clearBinding reuse the
   * engine methods (they need DSL compilation) but that's safe because replay
   * only ever runs with `recorder` null.
   */
  private readonly playerTarget: PlayerTarget = {
    queueInput: (e) => this.mappings.queue(e),
    // Mirrors the live `setInputSignal` below (docs/MACROS.md §4: "both the
    // live path and the player path route through here — verify; hook
    // both"): this writes `inputSignals` directly rather than calling
    // `this.setInputSignal` (which would also try to record — harmless here
    // since `recorder` is always null while a player drives this, but the
    // direct write predates macros and there's no reason to route back
    // through the recording-aware method), so macro engagement is noted
    // explicitly here too rather than relying on unification.
    setInputSignal: (name, value) => {
      this.inputSignals.set(name, value)
      this.macros.noteSignal(name)
    },
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
    // Scene handoff (docs/HANDOFF.md §4): reuses `switchScene` directly —
    // recorder is always null while a player drives this (replay/export),
    // so the call never re-records itself (invariant I6).
    switchScene: (id) => this.switchScene(id),
  }

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, scene: SceneRuntime, opts: EngineOptions) {
    this.transport = new Transport(opts.mode, opts.fps ?? 60)
    this.gpu = new Gpu(canvas, { width: opts.width, height: opts.height })
    this.surface = new DefaultSurface(this.gpu)
    this._scene = scene
    this.seed = opts.seed
    this.audio = opts.audio ?? new AudioEngine()
    this.mappings = new MappingRuntime(DEFAULT_MAPPINGS)
    // Pads/PERFORM batch: positional pad targets are a pure function of the
    // scene's own param schema (see `setPadTargets`'s doc comment) — derive
    // them here so a freshly-constructed engine's T1-T4 pads are live from
    // frame one, same as the retarget after `switchScene` below.
    this.mappings.setPadTargets(scene.params)
    // Redundant with the field initializer above (a fresh `MacroRouter` already
    // starts fully disengaged) but explicit per docs/MACROS.md §2's reset-point
    // list, and cheap insurance against a future refactor that reorders fields.
    this.macros.reset()
    scene.init(this.gpu, opts.seed)
  }

  /** Live mode: start the rAF loop. */
  start(): void {
    if (this.transport.mode !== 'live' || this.running) return
    // An adopted AudioEngine (scene switch) may already be minutes into a
    // track; without this the first advanceTo would produce one giant dt (the
    // full elapsed time) and every dt-clocked scene and stateful DSL helper
    // would lurch forward in a single frame. Starting the transport AT the
    // audio position makes the first frame's dt ordinary.
    if (this.audio.hasFile) this.transport.reset(this.audio.time)
    this.running = true
    let fallbackClock = 0
    const loop = () => {
      if (!this.running) return
      // A loaded track that is not audibly running (paused, stopped, or ended)
      // skips the tick entirely: a frozen clock alone (dt=0) freezes the
      // time-clocked scenes, but frame-clocked simulations (Gray-Scott's
      // substeps, the tunnel ring, flowfield's uFrame) advance per update()
      // call and would keep simmering through a "pause". The canvas holds its
      // last frame (preserveDrawingBuffer); a seek made while paused takes
      // visual effect on resume.
      if (this.audio.hasFile && !this.audio.isPlaying) {
        // …unless a control moved (see `controlsDirty`): run one reduced tick
        // so knobs/pads/edits take effect and show on screen while frozen.
        // advanceTo at the unchanged audio position yields dt=0 and the same
        // frame number, and the session player is NOT applied here — replay
        // events must not be consumed while the transport is frozen. A
        // recording can never be live in this branch (`startRecording`
        // throws unless audio is playing), so nothing is mis-recorded.
        if (this.controlsDirty) {
          this.controlsDirty = false
          this.updateAndRender(this.transport.advanceTo(this.audio.time), { skipSceneUpdate: true })
        }
        this.raf = requestAnimationFrame(loop)
        return
      }
      // Audio clock once a file has been loaded; no file at all keeps the
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
      if (this.player) this.player.applyUpTo(this.transport.frame - this.playerFrameOffset, this.playerTarget)
      const frame = this.transport.step()
      this.updateAndRender(frame)
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
    // Re-render at the new position while paused (signals are a pure timeline
    // lookup, so bindings/meters jump correctly even with the clock frozen).
    this.controlsDirty = true
  }

  stopAudio(): void {
    if (this.isRecording) return
    this.audio.stop()
    this.controlsDirty = true
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
    this.controlsDirty = true
  }

  setParam(name: string, value: number): void {
    if (this.recorder) this.recorder.recordParam(this.transport.frame, name, value)
    this.scene.setParam(name, value)
    this.controlsDirty = true
  }

  /**
   * Continuous-input signals (e.g. an XY touch pad) that persist on the bus every
   * frame until changed again — unlike mapping actions, these are just named
   * numbers for expressions/scenes to read, published before bindings each frame.
   */
  setInputSignal(name: string, value: number): void {
    if (this.recorder) this.recorder.recordInputSignal(this.transport.frame, name, value)
    this.inputSignals.set(name, value)
    // Macro pickup (docs/MACROS.md §2): a NEW value for `ctl.N` engages that
    // slot, live or replayed (see `playerTarget.setInputSignal`'s matching
    // call) — a no-op for every other signal name.
    this.macros.noteSignal(name)
    this.controlsDirty = true
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
    this.controlsDirty = true
  }

  clearBinding(param: string): void {
    if (this.recorder) this.recorder.recordBinding(this.transport.frame, param, null)
    this.bindings.delete(param)
    this.controlsDirty = true
  }

  getBinding(param: string): string | undefined {
    return this.bindings.get(param)?.src
  }

  /**
   * The active macro view (docs/DECKS.md knob-toggle trial): the param
   * set(s) the 8 slots positionally address this frame. Ordinary scenes:
   * `[scene.params]`, exactly the old behavior. Composite (deck) scenes —
   * detected by their `a.` / `b.` param prefixes, no new scene API — read
   * the recorded `macro.view` input signal: 0 = deck A's params (default),
   * 1 = deck B's, 2 = fader-follows (mix < 0.5 → A, else B), 3 = both
   * (slot i drives A's AND B's i-th param off one edge). The signal travels
   * the ordinary setInputSignal record/replay path, so a view flip mid-take
   * replays exactly; `mix`/`mode` stay reachable via their UI sliders and
   * expressions, never the slots.
   */
  private macroParamSets(): ParamSchema[][] {
    const params = this.scene.params
    const a = params.filter((p) => p.name.startsWith('a.'))
    const b = params.filter((p) => p.name.startsWith('b.'))
    if (a.length === 0 || b.length === 0) return [params]
    const view = this.bus.get('macro.view')
    if (view === 3) return [a, b]
    if (view === 2) return [this.scene.getParam('mix') < 0.5 ? a : b]
    if (view === 1) return [b]
    return [a]
  }

  /**
   * docs/MACROS.md §4/§5: true when param `name` currently has no explicit
   * user binding but IS driven by an engaged macro slot — the UI (studio
   * `Knob`, perform `RotaryKnob`, via `paramBinding.ts`'s hook) renders such
   * params live and shows "ctl N" instead of an expression, same visual
   * language as an explicitly bound param. Positional within the ACTIVE
   * macro view (see `macroParamSets`), not raw `scene.params` order.
   */
  isMacroDriven(name: string): boolean {
    const index = this.macroSlotIndexOf(name)
    if (index === null) return false
    return this.macros.isDriven(index, this.macroParamSets(), (n) => this.bindings.has(n))
  }

  /**
   * 1-based slot number the ACTIVE macro view assigns to param `name`, or
   * null when no slot addresses it (past position 8, or a deck param the
   * current view doesn't target). The UI's per-row slot chips read this so
   * they track the knob toggle instead of showing raw scene.params order.
   */
  macroSlotOf(name: string): number | null {
    const index = this.macroSlotIndexOf(name)
    return index === null ? null : index + 1
  }

  private macroSlotIndexOf(name: string): number | null {
    for (const set of this.macroParamSets()) {
      const index = set.findIndex((p) => p.name === name)
      if (index >= 0 && index < MACRO_SLOT_COUNT) return index
    }
    return null
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
    this.controlsDirty = true
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
    this.controlsDirty = true
  }

  /** Duck-type check for the UI: does the current scene accept `setSceneImage`? */
  sceneAcceptsImage(): boolean {
    return acceptsImage(this.scene)
  }

  /**
   * Scene handoff (docs/HANDOFF.md §4): hand off to another scene mid-session
   * IN PLACE — no Engine rebuild, so the transport, recorder, signal history,
   * and mappings survive the swap. A's final rendered frame becomes B's
   * initial conditions via a duck-typed `ingest(snapshot)`; scenes without
   * `ingest` (julia/mandeldive/morphogen) just boot fresh — a plain hard cut.
   *
   * Live callers (the App button/hotkey) and the session player both call
   * this; the only difference is replay runs with `recorder` null, so it's
   * never re-recorded (invariant I6). Throws on an unknown scene id — a
   * corrupt doc must fail loudly, never silently keep rendering A (invariant
   * I8: the throw can only come from `entry` lookup, `next.init`, or
   * `next.ingest`, all of which run before A is touched, so a throw always
   * leaves A intact and nothing recorded).
   */
  switchScene(toId: string): void {
    const entry = SCENES[toId]
    if (!entry) throw new Error(`switchScene: unknown scene "${toId}"`)

    // 1. Capture A's frame BEFORE building B — B.init() typically ends with a
    //    gl.clear() on the default framebuffer and would wipe the surface we
    //    need. Bind the default surface explicitly (§4 note: B's init/render
    //    may have left a different framebuffer/viewport bound).
    this.surface.bind()
    const snapshot: SceneSnapshot = readSurfaceSnapshot(this.gpu.gl, this.gpu.width, this.gpu.height)

    // Handoff glide (see `handoffFade`): with the surface still bound and A's
    // frame intact, grab a FULL-RES copy for the dissolve overlay — the ≤256px
    // ingest snapshot above is far too coarse to show on screen. Captured
    // before B is built for the same reason the snapshot is; a failure past
    // this point (I8's throw-leaves-A-intact guarantee) just orphans one
    // texture, freed on the next switch/dispose.
    const fadeSeconds = this.inputSignals.get('handoff.fade') ?? 0
    let fadeTex: WebGLTexture | null = null
    if (fadeSeconds > HANDOFF_CUT_THRESHOLD) {
      const gl = this.gpu.gl
      fadeTex = gl.createTexture()
      gl.bindTexture(gl.TEXTURE_2D, fadeTex)
      gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 0, 0, this.gpu.width, this.gpu.height, 0)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      gl.bindTexture(gl.TEXTURE_2D, null)
    }

    // 2. Build + init + ingest B while A is still alive, so any failure
    //    leaves A intact (I8) — both calls may throw (e.g. a float-renderable
    //    check, or a malformed snapshot).
    const next = entry.create()
    next.init(this.gpu, this.seed) // seed continuity (I9): always the session seed, never time/switch-derived
    if (hasIngest(next)) next.ingest(snapshot)

    // 3. Commit: record, dispose A, swap, clear A-scoped state.
    if (this.recorder) this.recorder.recordSwitch(this.transport.frame, toId)
    this._scene.dispose()
    this._scene = next
    // Bindings reference A's param names; the clear is implicit in the switch
    // event (no per-param clearBinding events are emitted — replay's
    // switchScene clears them identically, invariant I6). Mappings/ramps are
    // left untouched: a stray `params.set(unknownName, …)` write is harmless.
    this.bindings.clear()
    // Pads/PERFORM batch: retarget T1-T4 positionally onto B's own param
    // schema — a stale rule still naming one of A's params would otherwise
    // silently write nothing (or, worse, a same-named param on B by
    // coincidence) instead of B's actual (n-1)th param. Pure function of
    // `next.params`, so live and replay (both funnel through this same
    // `switchScene` method, invariant I6) retarget identically.
    this.mappings.setPadTargets(next.params)
    // Macro pickup resets on every switch (docs/MACROS.md §2): B's params are
    // a different schema at the same positions, so A's stale ctl.N-driven
    // values must not yank B's params on its very first frame — B's slots
    // stay dormant until a fresh ctl.N event arrives post-switch. The CC->slot
    // hardware mapping itself lives in app state, untouched by this reset.
    this.macros.reset()
    // ARCHITECT AMENDMENT (§5a, invariant I11): when B ingested the snapshot,
    // it becomes the stored image, so a recording started at ANY point after
    // this switch serializes it into `doc.scene.image` and replays B's true
    // initial state; non-ingesting B clears it (a plain hard cut has no
    // material to restore).
    this.storedImage = hasIngest(next) ? snapshot : null
    // Arm (or replace) the dissolve — a switch mid-fade drops the previous
    // overlay texture and starts fresh from the outgoing frame captured above.
    this.clearHandoffFade()
    if (fadeTex) {
      // Frame-derived start time, not `transport.time`: the switch event is
      // frame-quantized in the session log, and live continuous audio time
      // sits up to 1/fps ahead of the stepped replay clock — deriving from
      // the frame counter gives live and replay the same dissolve phase.
      this.handoffFade = {
        tex: fadeTex,
        startTime: this.transport.frame / this.transport.fps,
        duration: fadeSeconds,
      }
    }
    // A switch made while the track is paused/stopped should show B's first
    // frame, not hold A's last one until play resumes.
    this.controlsDirty = true
  }

  private clearHandoffFade(): void {
    if (this.handoffFade) {
      this.gpu.gl.deleteTexture(this.handoffFade.tex)
      this.handoffFade = null
    }
  }

  /** Draws the handoff dissolve overlay (A's captured frame at decaying
   * alpha) over whatever the scene just rendered; drops the fade once it has
   * fully played out. Runs in live ticks, frozen control ticks (alpha simply
   * holds while time is frozen), replay, and export alike. */
  private renderHandoffFade(time: number): void {
    const fade = this.handoffFade
    if (!fade) return
    const alpha = 1 - (time - fade.startTime) / fade.duration
    if (alpha <= 0) {
      this.clearHandoffFade()
      return
    }
    const gl = this.gpu.gl
    if (!this.fadeProgram) {
      this.fadeProgram = this.gpu.compileProgram(FADE_OVERLAY_VS, FADE_OVERLAY_FS)
      this.fadePass = new FullscreenPass(this.gpu)
      this.fadeAlphaLoc = gl.getUniformLocation(this.fadeProgram, 'uAlpha')
    }
    this.surface.bind()
    gl.disable(gl.DEPTH_TEST)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.useProgram(this.fadeProgram)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, fade.tex)
    gl.uniform1i(gl.getUniformLocation(this.fadeProgram, 'uTex'), 0)
    gl.uniform1f(this.fadeAlphaLoc, Math.min(1, alpha))
    this.fadePass!.draw()
    gl.disable(gl.BLEND)
    gl.bindTexture(gl.TEXTURE_2D, null)
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
    // A recording started with a loaded-but-not-playing track (paused, stopped,
    // or ended) would run against a frozen transport: the live view holds one
    // frame while events accumulate, but replay/export steps time forward from
    // 0 — a coherent yet *different* video than what was performed. Reject
    // loudly; the App also disables Record in this state.
    if (this.audio.hasFile && !this.audio.isPlaying) {
      throw new Error('Cannot start recording while the track is paused or stopped — press play first')
    }
    const params: Record<string, number> = {}
    for (const p of this.scene.params) {
      params[p.name] = this.scene.getParam(p.name) - this.mappings.pulseOffset(p.name)
    }
    const bindings: Record<string, string> = {}
    for (const [param, b] of this.bindings) bindings[param] = b.src
    // Take-baselining (session/types.ts's SessionAudio doc comment): capture
    // where "now" sits in the take's own time source, so replay/export (which
    // always steps frame.time from 0) can add it back in. A take armed right
    // at track/demo start round-trips to exactly 0 seconds, which the `> 0`
    // guards below omit entirely (not even `startSeconds: 0`) for back-compat
    // with docs recorded before this field existed.
    const fileStartSeconds = round4(this.audio.time)
    const demoStartSeconds = round4(this.transport.time)
    const audio: SessionAudio =
      this.audio.hasFile && this.audio.timeline
        ? {
            kind: 'file',
            name: this.audio.fileName ?? 'audio',
            timeline: serializeTimeline(this.audio.timeline),
            ...(fileStartSeconds > 0 ? { startSeconds: fileStartSeconds } : {}),
          }
        : { kind: 'demo', ...(demoStartSeconds > 0 ? { startSeconds: demoStartSeconds } : {}) }
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
    this.recorder = new SessionRecorder(
      {
        seed: this.seed,
        fps: this.transport.fps,
        sceneId: this.scene.meta.id,
        params,
        bindings,
        audio,
        shaders,
        image,
      },
      this.transport.frame,
    )
    // The take boundary is edge-based (see the method doc: in-flight state is
    // not captured), and macro engagement/edge memory is exactly such state:
    // `loadSession` replays from a RESET router, so a router still engaged
    // from unrecorded pre-roll input (e.g. positioning knobs while the track
    // was stopped — the frozen control tick) would make live and replay
    // diverge if a recorded ctl.N event repeated a pre-roll value (live: no
    // edge, skipped; replay: NaN -> routed). Reset here so the take starts
    // from the same dormant router replay will. Params keep their snapshotted
    // values; each knob re-engages on its first in-take movement (pickup).
    this.macros.reset()
    // Held "UI mode" signals (BASELINED_SIGNALS — knob-view choice, handoff
    // dissolve length) are baselined as ordinary frame-0 inputSignal events:
    // each is state set BEFORE arming that silently shapes the performance,
    // and without the baseline replay falls back to its default (review
    // finding for macro.view: every recorded ctl edge re-routed to the wrong
    // deck). Held ctl.N values are deliberately NOT seeded the same way: the
    // params snapshot above already carries their effect, and re-seeding
    // them would re-engage slots on replay and clobber pre-roll UI edits
    // (the exact divergence the macros.reset() above exists to prevent).
    for (const name of BASELINED_SIGNALS) {
      const value = this.inputSignals.get(name)
      if (value !== undefined) {
        this.recorder.recordInputSignal(this.transport.frame, name, value)
      }
    }
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
    // Take-baselining phase fix: reset the transport TO the take's own start
    // position (file-timeline seconds, or demo clock seconds), not to 0 — so
    // `frame.time` (scene render + DSL bindings, not just signal sampling) is
    // correct from frame one, and every time-driven visual replays at the same
    // phase it was performed at. `playerFrameOffset` records where that leaves
    // the frame counter, so `applyUpTo` can still compare against the doc's
    // 0-based recorded event frames (see the field's own doc comment).
    this.transport.reset(doc.audio.startSeconds ?? 0)
    this.playerFrameOffset = this.transport.frame
    this.bus.clear()
    this.mappings.reset()
    this.events.reset()
    this.inputSignals.clear()
    this.bindings.clear()
    // Macro pickup resets on load, same reasoning as switchScene above
    // (docs/MACROS.md §2/§4): a fresh replay/export run must not have any
    // slot pre-engaged from a previous run's stale state.
    this.macros.reset()
    // A dissolve overlay in flight belongs to the pre-load live state, not
    // the session being replayed — replayed switch events arm their own.
    this.clearHandoffFade()

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
    //
    // ARCHITECT AMENDMENT (§5a): `doc.scene.image` may equally be a handoff
    // snapshot from a switch recorded before `startRecording` (invariant
    // I11) — `setImage`-only scenes (photoswarm) keep this exact branch
    // unchanged (its `ingest` is a one-line delegate to `setImage`, so
    // behavior is identical either way, and only `setImage` can express the
    // "revert to null/fallback" case `ingest`'s signature can't). Scenes that
    // ingest but don't accept a plain `setImage` (grayscott/kaleido/tunnel/
    // flowfield) gain faithful restore via `ingest` when an image is present;
    // absent an image, their own `init()` above already produced the correct
    // seeded state, so there is nothing to reapply.
    if (acceptsImage(this.scene)) {
      this.storedImage = doc.scene.image
        ? { width: doc.scene.image.width, height: doc.scene.image.height, data: decodeImageBase64(doc.scene.image.data) }
        : null
      this.scene.setImage(this.storedImage)
    } else if (hasIngest(this.scene) && doc.scene.image) {
      this.storedImage = {
        width: doc.scene.image.width,
        height: doc.scene.image.height,
        data: decodeImageBase64(doc.scene.image.data),
      }
      this.scene.ingest(this.storedImage)
    } else {
      this.storedImage = null
    }

    this.player = new SessionPlayer(doc)
  }

  /** Disarms the active replay player (no-op if none is armed). */
  clearSession(): void {
    this.player = null
    this.sessionTimeline = null
    this.playerFrameOffset = 0
  }

  /** True once an armed player has applied every recorded event (false if none is armed). */
  get replayDone(): boolean {
    return this.player !== null && this.player.done
  }

  /**
   * Frame count relative to the currently-armed session's start: 0 right after
   * `loadSession`, advancing by 1 per subsequent `renderFrames`/live tick — what
   * `doc.durationFrames` and every recorded event's `frame` are counted against
   * (see `playerFrameOffset`'s doc comment). Equals `transport.frame` when no
   * session has been loaded, or for a doc with no `startSeconds`, since
   * `playerFrameOffset` stays 0 in both cases. External replay-progress UI
   * (App.tsx) reads this instead of `transport.frame` directly.
   */
  get replayFrame(): number {
    return this.transport.frame - this.playerFrameOffset
  }

  /** Stops the loop, silences audio, and releases scene GPU resources — call
   * before discarding an engine. `keepAudio` skips the audio stop for callers
   * that hand the AudioEngine to a successor engine (scene switches): without
   * the default stop, a discarded engine's track kept playing as an orphan
   * (audible during replays, doubled after reloads). */
  dispose(opts?: { keepAudio?: boolean }): void {
    this.stop()
    if (!opts?.keepAudio) this.audio.stop()
    this.clearHandoffFade()
    if (this.fadeProgram) this.gpu.gl.deleteProgram(this.fadeProgram)
    this.fadePass?.dispose()
    this.scene.dispose()
  }

  private tick(time: number): void {
    if (this.player) this.player.applyUpTo(this.transport.frame - this.playerFrameOffset, this.playerTarget)
    const frame = this.transport.advanceTo(time)
    this.updateAndRender(frame)
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
  private updateAndRender(
    frame: { time: number; dt: number; frame: number },
    opts?: { skipSceneUpdate?: boolean },
  ): void {
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

    // Take-baselining (session/types.ts): `loadSession` now resets the transport
    // TO the take's own start position (`doc.audio.startSeconds ?? 0`), so
    // `frame.time` already lands at the right point in the take's time source
    // for a replaying/exporting player — no separate offset needed here anymore
    // (this used to add `audioStartSeconds` back in; deleted along with that
    // field, since scene render + DSL bindings need the exact same shift and
    // getting it from the transport itself, not a signal-sampling-only patch,
    // is what fixes Finding 1's phase-shift regression).
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
      publishDemoSignals(this.bus, frame.time)
      // The demo detector path (events.ts's updateDemo) recomputes its analytic
      // beat straight from `time`, independent of the bus — it must see the
      // same time passed to publishDemoSignals or the two go out of phase.
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
    // Macro router (docs/MACROS.md §4): runs AFTER bindings evaluate, so an
    // explicit expression binding on a param is already in place and the
    // router's own `hasBinding` skip is just for clarity/no-double-write —
    // ctl.N is already on the bus (raw 0..1) via the `inputSignals` loop
    // above; range-mapping + step-snapping happen only here, never on the bus.
    // The param set(s) come from the active macro view (docs/DECKS.md
    // knob-toggle trial) — `[scene.params]` for ordinary scenes, the A/B/
    // fader/both selection for deck (composite) scenes.
    this.macros.route(
      this.macroParamSets(),
      (name) => this.bindings.has(name),
      (slot) => this.bus.get(`ctl.${slot}`),
      (name, value) => this.scene.setParam(name, value),
    )
    this.mappings.update(frame.dt, this.bus, {
      get: (n) => this.scene.getParam(n),
      set: (n, v) => this.scene.setParam(n, v),
    })
    const ctx = { frame, signals: this.bus }
    // Frozen control tick (see `controlsDirty`): render with the new control
    // values but skip update() — per-CALL-clocked simulation state (Gray-Scott
    // substeps, tunnel ring, flowfield's uFrame) must not advance while the
    // transport is frozen, and scenes read params at render time so the
    // control change is still visible.
    if (!opts?.skipSceneUpdate) this.scene.update(ctx)
    this.scene.render(ctx, this.surface)
    this.renderHandoffFade(frame.time)
  }
}
