import type { Gpu } from '../../gpu/context'
import type { RenderSurface } from '../../gpu/targets'
import type { FrameContext, ParamSchema, SceneRuntime } from '../types'

/**
 * STUB — being built (task #47): "Whip Storm" — multiple verlet whips in complementary hues with
 * bass-driven magnetic attraction/repulsion and wall-strike sparks.
 * Placeholder so the registry entry compiles; renders solid black.
 */
export class WhipStormScene implements SceneRuntime {
  meta = { id: 'whipstorm', name: 'Whip Storm', family: 'geometry' as const }
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
