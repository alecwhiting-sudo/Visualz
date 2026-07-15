import { Transport, type TransportMode } from '../core/transport'
import { SignalBus } from '../core/signals'
import { Gpu } from '../gpu/context'
import { AudioEngine, publishDemoSignals } from '../audio/engine'
import type { SceneRuntime } from '../scenes/types'

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

  private raf = 0
  private running = false

  constructor(canvas: HTMLCanvasElement, scene: SceneRuntime, opts: EngineOptions) {
    this.transport = new Transport(opts.mode, opts.fps ?? 60)
    this.gpu = new Gpu(canvas, { width: opts.width, height: opts.height })
    this.scene = scene
    this.seed = opts.seed
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
    const ctx = { frame, signals: this.bus }
    this.scene.update(ctx)
    this.scene.render(ctx)
  }
}
