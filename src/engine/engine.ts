import { Transport, type TransportMode } from '../core/transport'
import { SignalBus } from '../core/signals'
import { Gpu } from '../gpu/context'
import { AudioEngine, publishDemoSignals } from '../audio/engine'
import { compile, type CompiledExpr } from '../dsl/compile'
import { DslState } from '../dsl/state'
import type { SceneRuntime } from '../scenes/types'
import { MappingRuntime } from '../mapping/runtime'
import { DEFAULT_MAPPINGS } from '../mapping/defaults'

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
  readonly scene: SceneRuntime
  readonly seed: number
  readonly mappings: MappingRuntime

  private raf = 0
  private running = false
  private bindings = new Map<string, Binding>()
  private inputSignals = new Map<string, number>()

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
      const frame = this.transport.step()
      this.updateAndRender(frame.time, frame)
    }
  }

  setParam(name: string, value: number): void {
    this.scene.setParam(name, value)
  }

  /**
   * Continuous-input signals (e.g. an XY touch pad) that persist on the bus every
   * frame until changed again — unlike mapping actions, these are just named
   * numbers for expressions/scenes to read, published before bindings each frame.
   */
  setInputSignal(name: string, value: number): void {
    this.inputSignals.set(name, value)
  }

  /**
   * Bind a scene param to a DSL expression, evaluated every frame before the scene
   * updates (the "equations" layer of the authoring model). Throws DslError on bad
   * source — callers surface it inline and the previous binding stays active.
   */
  setBinding(param: string, src: string): void {
    const compiled = compile(src, `${this.scene.meta.id}.${param}`)
    this.bindings.set(param, { src, compiled, state: new DslState() })
  }

  clearBinding(param: string): void {
    this.bindings.delete(param)
  }

  getBinding(param: string): string | undefined {
    return this.bindings.get(param)?.src
  }

  private tick(time: number): void {
    const frame = this.transport.advanceTo(time)
    this.updateAndRender(time, frame)
  }

  private updateAndRender(time: number, frame: { time: number; dt: number; frame: number }): void {
    if (this.audio.isPlaying) {
      this.audio.publishSignals(this.bus)
    } else {
      publishDemoSignals(this.bus, time)
    }
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
