/**
 * The thin GPU layer (ARCHITECTURE.md §3.7): WebGL2 with no framework on top.
 * Deliberately small — programs, buffers, fullscreen passes. Render targets and
 * ping-pong pairs land here when the particle family needs them.
 */

export interface GpuOptions {
  width?: number
  height?: number
}

export class Gpu {
  readonly canvas: HTMLCanvasElement
  readonly gl: WebGL2RenderingContext

  constructor(canvas: HTMLCanvasElement, opts: GpuOptions = {}) {
    this.canvas = canvas
    if (opts.width) canvas.width = opts.width
    if (opts.height) canvas.height = opts.height
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      // Trails via accumulation need the buffer kept between frames.
      preserveDrawingBuffer: true,
      alpha: false,
    })
    if (!gl) throw new Error('WebGL2 is not available')
    this.gl = gl
    gl.viewport(0, 0, canvas.width, canvas.height)
  }

  get width(): number {
    return this.canvas.width
  }

  get height(): number {
    return this.canvas.height
  }

  resize(width: number, height: number): void {
    this.canvas.width = width
    this.canvas.height = height
    this.gl.viewport(0, 0, width, height)
  }

  /**
   * Compile + link, throwing with the full shader info log on failure. Scene
   * hot-recompile relies on this throwing cleanly so the last good program
   * can keep rendering.
   */
  compileProgram(vertexSrc: string, fragmentSrc: string): WebGLProgram {
    const gl = this.gl
    const vs = this.compileShader(gl.VERTEX_SHADER, vertexSrc)
    const fs = this.compileShader(gl.FRAGMENT_SHADER, fragmentSrc)
    const program = gl.createProgram()
    if (!program) throw new Error('Failed to create program')
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) ?? 'unknown link error'
      gl.deleteProgram(program)
      throw new Error(`Program link failed: ${log}`)
    }
    return program
  }

  private compileShader(type: number, source: string): WebGLShader {
    const gl = this.gl
    const shader = gl.createShader(type)
    if (!shader) throw new Error('Failed to create shader')
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) ?? 'unknown compile error'
      gl.deleteShader(shader)
      const kind = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment'
      throw new Error(`${kind} shader compile failed: ${log}`)
    }
    return shader
  }
}
