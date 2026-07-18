import type { Gpu } from '../../gpu/context'
import type { RenderSurface } from '../../gpu/targets'
import type { FrameContext, ParamSchema, SceneRuntime } from '../types'

/**
 * STUB — being built (task #42): "Glyph Geometry" — evolving geometric outlines drawn ENTIRELY from
 * text glyphs (no line primitives), sharing the glyphlattice bitmap atlas.
 * This placeholder only exists so the registry entry compiles while the
 * real scene lands; it renders solid black.
 */
export class GlyphGeometryScene implements SceneRuntime {
  meta = { id: 'glyphgeometry', name: 'Glyph Geometry', family: 'geometry' as const }
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
