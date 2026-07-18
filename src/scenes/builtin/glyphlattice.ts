import type { Gpu } from '../../gpu/context'
import type { RenderSurface } from '../../gpu/targets'
import type { FrameContext, ParamSchema, SceneRuntime } from '../types'

/**
 * STUB — being built (task #41): "Glyph Lattice", a diagram-style line scene:
 * a morphing lattice of parametric curves (lissajous → rose → harmonograph
 * families) with Matrix-style random text strings zooming along the lines
 * via a deterministic baked 5x7 bitmap glyph atlas. This placeholder only
 * exists so the registry entry compiles while the real scene lands; it
 * renders solid black.
 */
export class GlyphLatticeScene implements SceneRuntime {
  meta = { id: 'glyphlattice', name: 'Glyph Lattice', family: 'geometry' as const }
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
