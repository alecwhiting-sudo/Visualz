import type { Gpu } from '../../gpu/context'
import { FullscreenPass, type RenderSurface } from '../../gpu/targets'
import type { ParamSchema } from '../../scenes/types'
import type { FxPass } from '../types'

/** Shared attribute-less fullscreen-triangle vertex shader (same
 * `gl_VertexID` trick as `scenes/composite.ts`'s blend pass) — every FX pass
 * draws one covering triangle and does all its work in the fragment stage. */
export const FX_VERTEX_SRC = `#version 300 es
void main() {
  vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`

/**
 * Scaffolding shared by every built-in FX pass: compiles `fragmentSrc`
 * against `FX_VERTEX_SRC`, binds the source texture to unit 0 (`uSrc`) plus
 * the standard `uResolution`/`uTime` uniforms every pass gets for free, then
 * calls `setUniforms` for the pass's own params before drawing. Keeps each
 * pass file to just its fragment shader + param schema.
 */
export function makeFxPass(
  id: string,
  name: string,
  params: ParamSchema[],
  fragmentSrc: string,
  setUniforms: (gl: WebGL2RenderingContext, program: WebGLProgram, values: ReadonlyMap<string, number>) => void,
): FxPass {
  let gpuRef: Gpu | null = null
  let program: WebGLProgram | null = null
  let fsPass: FullscreenPass | null = null
  let uSrcLoc: WebGLUniformLocation | null = null
  let uResLoc: WebGLUniformLocation | null = null
  let uTimeLoc: WebGLUniformLocation | null = null

  return {
    meta: { id, name },
    params,
    init(gpu: Gpu) {
      gpuRef = gpu
      program = gpu.compileProgram(FX_VERTEX_SRC, fragmentSrc)
      fsPass = new FullscreenPass(gpu)
      const gl = gpu.gl
      uSrcLoc = gl.getUniformLocation(program, 'uSrc')
      uResLoc = gl.getUniformLocation(program, 'uResolution')
      uTimeLoc = gl.getUniformLocation(program, 'uTime')
    },
    render(gpu: Gpu, src: WebGLTexture, dst: RenderSurface, frameTime: number, values: ReadonlyMap<string, number>) {
      if (!program || !fsPass) throw new Error(`FxPass "${id}" rendered before init()`)
      const gl = gpu.gl
      dst.bind()
      gl.disable(gl.BLEND)
      gl.disable(gl.DEPTH_TEST)
      gl.useProgram(program)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, src)
      gl.uniform1i(uSrcLoc, 0)
      gl.uniform2f(uResLoc, dst.width, dst.height)
      gl.uniform1f(uTimeLoc, frameTime)
      setUniforms(gl, program, values)
      fsPass.draw()
      gl.bindTexture(gl.TEXTURE_2D, null)
    },
    dispose() {
      if (gpuRef && program) gpuRef.gl.deleteProgram(program)
      fsPass?.dispose()
      gpuRef = null
      program = null
      fsPass = null
    },
  }
}
