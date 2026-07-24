import type { Gpu } from '../../gpu/context'
import type { RenderSurface } from '../../gpu/targets'
import type { FrameContext, ParamSchema, SceneRuntime } from '../types'

/** STUB — replaced by the builder. Warp starfield: fly through stars that
 *  streak at high speed. */
export class StarFlightScene implements SceneRuntime {
  meta = { id: 'starflight', name: 'Star Flight', family: 'geometry' as const }
  params: ParamSchema[] = []
  private gpu!: Gpu
  init(gpu: Gpu): void {
    this.gpu = gpu
    gpu.gl.clearColor(0, 0, 0, 1)
    gpu.gl.clear(gpu.gl.COLOR_BUFFER_BIT)
  }
  setParam(): void {}
  getParam(): number { return 0 }
  update(): void {}
  render(_ctx: FrameContext, surface: RenderSurface): void {
    surface.bind()
    const gl = this.gpu.gl
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }
  resize(w: number, h: number): void { this.gpu.resize(w, h) }
  dispose(): void {}
}
