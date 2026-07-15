/**
 * GPGPU render-target helpers (ARCHITECTURE.md §3.7), specified in
 * docs/PARTICLES.md §1-2. WebGL2 has no compute shaders, so particle state lives
 * in RGBA32F textures updated via fullscreen-triangle fragment passes and
 * ping-ponged between frames.
 *
 * RGBA32F is required, not a fallback from RGBA16F: half-float precision stalls
 * small per-step velocities to zero near the edges of NDC (docs/PARTICLES.md §0).
 * `checkFloatRenderable` must be called (and its failure surfaced) before any of
 * these are constructed.
 */

import type { Gpu } from './context'

export interface FloatCaps {
  ok: boolean
  reason?: string
}

/**
 * RGBA32F color-renderability gated by `EXT_color_buffer_float` (present on iOS
 * 15+ Safari, desktop browsers, and ANGLE-SwiftShader/CI). Also runtime-probes
 * FBO completeness, since some stacks report the extension but fail anyway.
 */
export function checkFloatRenderable(gpu: Gpu): FloatCaps {
  const gl = gpu.gl
  if (!gl.getExtension('EXT_color_buffer_float')) {
    return { ok: false, reason: 'EXT_color_buffer_float unavailable — particle family requires float render targets' }
  }
  const tex = gl.createTexture()!
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, 4, 4)
  const fbo = gl.createFramebuffer()!
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
  gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  gl.deleteFramebuffer(fbo)
  gl.deleteTexture(tex)
  return ok ? { ok: true } : { ok: false, reason: 'RGBA32F not framebuffer-complete on this driver' }
}

/**
 * One RGBA32F texture + its own framebuffer. NEAREST/CLAMP_TO_EDGE, no mips —
 * particle state is read back with `texelFetch`, never sampled/filtered.
 */
export class FloatTarget {
  readonly texture: WebGLTexture
  readonly fbo: WebGLFramebuffer
  readonly size: number
  private readonly gl: WebGL2RenderingContext

  /** `initial` must be `size*size*4` floats (RGBA per texel), or omitted for zeros. */
  constructor(gpu: Gpu, size: number, initial?: Float32Array) {
    const gl = gpu.gl
    this.gl = gl
    this.size = size

    const tex = gl.createTexture()
    if (!tex) throw new Error('Failed to create GPGPU state texture')
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, size, size)
    const data = initial ?? new Float32Array(size * size * 4)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, size, size, gl.RGBA, gl.FLOAT, data)

    const fbo = gl.createFramebuffer()
    if (!fbo) throw new Error('Failed to create GPGPU framebuffer')
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.bindTexture(gl.TEXTURE_2D, null)

    this.texture = tex
    this.fbo = fbo
  }

  upload(data: Float32Array): void {
    const gl = this.gl
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.size, this.size, gl.RGBA, gl.FLOAT, data)
    gl.bindTexture(gl.TEXTURE_2D, null)
  }

  /** Bind this target's fbo and set the viewport to its (square) texture size. */
  bindTarget(): void {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
    gl.viewport(0, 0, this.size, this.size)
  }

  bindTexture(unit: number): void {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
  }

  dispose(): void {
    this.gl.deleteFramebuffer(this.fbo)
    this.gl.deleteTexture(this.texture)
  }
}

/**
 * Two `FloatTarget`s, swapped every update — read from `src`, write to `dst`,
 * then `swap()`. `resize()` is the count-quality re-init path (docs/PARTICLES.md
 * §6): disposes both targets and rebuilds at a new (square) size with fresh
 * seed data, since particle count changes can't be resampled in place.
 */
export class PingPong {
  private gpu: Gpu
  private a: FloatTarget
  private b: FloatTarget
  private flip = false
  size: number

  constructor(gpu: Gpu, size: number, initial?: Float32Array) {
    this.gpu = gpu
    this.size = size
    this.a = new FloatTarget(gpu, size, initial)
    this.b = new FloatTarget(gpu, size, initial)
  }

  get src(): FloatTarget {
    return this.flip ? this.b : this.a
  }

  get dst(): FloatTarget {
    return this.flip ? this.a : this.b
  }

  swap(): void {
    this.flip = !this.flip
  }

  resize(size: number, initial: Float32Array): void {
    this.a.dispose()
    this.b.dispose()
    this.size = size
    this.flip = false
    this.a = new FloatTarget(this.gpu, size, initial)
    this.b = new FloatTarget(this.gpu, size, initial)
  }

  dispose(): void {
    this.a.dispose()
    this.b.dispose()
  }
}

/**
 * Attribute-less fullscreen-triangle pass: one empty VAO, `drawArrays(TRIANGLES,
 * 0, 3)`. Whatever program is bound must generate the covering triangle itself
 * from `gl_VertexID` (no attributes, no varyings needed) — shared by the GPGPU
 * update pass (fragment reads `gl_FragCoord.xy` to address its state texel) and
 * any other full-viewport quad draw (e.g. a trail fade).
 */
export class FullscreenPass {
  private readonly gl: WebGL2RenderingContext
  private readonly vao: WebGLVertexArrayObject

  constructor(gpu: Gpu) {
    this.gl = gpu.gl
    const vao = this.gl.createVertexArray()
    if (!vao) throw new Error('Failed to create fullscreen-pass VAO')
    this.vao = vao
  }

  draw(): void {
    const gl = this.gl
    gl.bindVertexArray(this.vao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindVertexArray(null)
  }

  dispose(): void {
    this.gl.deleteVertexArray(this.vao)
  }
}
