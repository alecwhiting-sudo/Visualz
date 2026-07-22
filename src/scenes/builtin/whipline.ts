import type { Gpu } from '../../gpu/context'
import type { RenderSurface } from '../../gpu/targets'
import type { FrameContext, ParamSchema, SceneRuntime } from '../types'

/**
 * STUB — being built (task #46): "Whip Line" — user-defined maths: a differentially rotating line
 * (outer end 2x the inner) as a wall-bouncing verlet chain with
 * beat-spaced echoes and beat-pulsed hue/brightness.
 * Placeholder so the registry entry compiles while the real scene lands;
 * renders solid black.
 */
export class WhipLineScene implements SceneRuntime {
  meta = { id: 'whipline', name: 'Whip Line', family: 'geometry' as const }
  params: ParamSchema[] = []
  private values = new Map<string, number>()
  private gpu!: Gpu

  init(gpu: Gpu, _seed: number): void {
    this.gpu = gpu
  }

  update(_ctx: FrameContext): void {}

  render(_ctx: FrameContext, surface: RenderSurface): void {
    const gl = this.gpu.gl
    surface.bind()
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  resize(_w: number, _h: number): void {}
  dispose(): void {}

  setParam(name: string, value: number): void {
    this.values.set(name, value)
  }

  getParam(name: string): number {
    return this.values.get(name) ?? 0
  }
}
