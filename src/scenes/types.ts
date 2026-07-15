import type { Frame } from '../core/transport'
import type { SignalBus } from '../core/signals'
import type { Gpu } from '../gpu/context'

/** What a scene sees each frame: transport time and the signal bus. Never wall-clock. */
export interface FrameContext {
  frame: Frame
  signals: SignalBus
}

export interface ParamSchema {
  name: string
  label: string
  min: number
  max: number
  default: number
  step?: number
}

export interface SceneMeta {
  id: string
  name: string
  family: 'geometry' | 'particles'
}

export interface ShaderStage {
  key: string          // stable id, e.g. 'line-fs', 'update-fs', 'render-fs'
  label: string        // human label for the editor dropdown
  source: string       // current GLSL source
}

/**
 * The scene runtime interface (ARCHITECTURE.md §3.3). The serializable Scene
 * *document* (params + expressions + source + bindings) comes next; the skeleton
 * ships the runtime side with params only.
 */
export interface SceneRuntime {
  meta: SceneMeta
  params: ParamSchema[]
  init(gpu: Gpu, seed: number): void
  setParam(name: string, value: number): void
  getParam(name: string): number
  update(ctx: FrameContext): void
  render(ctx: FrameContext): void
  resize(width: number, height: number): void
  dispose(): void
  /** Code layer (optional): shader stages editable in-app. */
  getShaderSources?(): ShaderStage[]
  /**
   * Hot-recompile stage `key` with new source. On GLSL error THROWS (message =
   * gpu.compileProgram's log) and the previous program keeps rendering; on
   * success the new program takes effect next frame. Unknown key throws.
   */
  setShaderSource?(key: string, source: string): void
}
