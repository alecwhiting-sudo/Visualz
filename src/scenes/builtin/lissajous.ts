import { mulberry32, type Prng } from '../../core/prng'
import type { Gpu } from '../../gpu/context'
import type { FrameContext, ParamSchema, SceneRuntime, ShaderStage } from '../types'

/**
 * First geometry-family scene: an audio-reactive Lissajous/harmonograph curve
 * with accumulation trails. Kept simple on purpose — it exists to prove the
 * architecture (transport-driven, signal-bound, seeded, golden-testable).
 */

const LINE_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
uniform float uAspect;
void main() {
  // Fit the (square) curve inside any viewport undistorted: shrink x on wide
  // aspects, shrink y on tall ones. Plain p.x /= uAspect overflows and clips
  // horizontally when aspect < 1 (9:16) — caught by the aspect goldens.
  vec2 p = aPos;
  p.x /= max(uAspect, 1.0);
  p.y *= min(uAspect, 1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`

const LINE_FS = `#version 300 es
precision highp float;
uniform vec3 uColor;
out vec4 outColor;
void main() {
  outColor = vec4(uColor, 1.0);
}`

const FADE_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`

const FADE_FS = `#version 300 es
precision highp float;
uniform float uFade;
out vec4 outColor;
void main() { outColor = vec4(0.0, 0.0, 0.0, uFade); }`

const POINTS = 2048

function hsl(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h * 12) % 12
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  return [f(0), f(8), f(4)]
}

export class LissajousScene implements SceneRuntime {
  meta = { id: 'lissajous', name: 'Lissajous', family: 'geometry' as const }

  params: ParamSchema[] = [
    { name: 'freqX', label: 'X frequency', min: 1, max: 12, default: 3, step: 1 },
    { name: 'freqY', label: 'Y frequency', min: 1, max: 12, default: 2, step: 1 },
    { name: 'drift', label: 'Phase drift', min: 0, max: 2, default: 0.35 },
    { name: 'trail', label: 'Trail fade', min: 0.01, max: 0.4, default: 0.08 },
    { name: 'hueSpeed', label: 'Hue speed', min: 0, max: 1, default: 0.12 },
  ]

  private values = new Map<string, number>()
  private gpu!: Gpu
  private random: Prng = mulberry32(1)
  private huePhase = 0

  private lineProgram!: WebGLProgram
  private fadeProgram!: WebGLProgram
  private lineVao!: WebGLVertexArrayObject
  private lineVbo!: WebGLBuffer
  private fadeVao!: WebGLVertexArrayObject
  private positions = new Float32Array(POINTS * 2)
  private amp = 0.8

  // Code layer (ARCHITECTURE.md §3.3): current source per editable stage, reset
  // to the stock defaults every init() so loadSession's dispose+init starts
  // clean. Uniform locations are looked up per-render (see render()), so
  // swapping `lineProgram`/`fadeProgram` here needs no location refresh.
  private lineSource = LINE_FS
  private fadeSource = FADE_FS

  init(gpu: Gpu, seed: number): void {
    this.gpu = gpu
    this.random = mulberry32(seed)
    this.huePhase = this.random()
    for (const p of this.params) this.values.set(p.name, p.default)

    this.lineSource = LINE_FS
    this.fadeSource = FADE_FS

    const gl = gpu.gl
    this.lineProgram = gpu.compileProgram(LINE_VS, this.lineSource)
    this.fadeProgram = gpu.compileProgram(FADE_VS, this.fadeSource)

    this.lineVao = gl.createVertexArray()!
    this.lineVbo = gl.createBuffer()!
    gl.bindVertexArray(this.lineVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo)
    gl.bufferData(gl.ARRAY_BUFFER, this.positions.byteLength, gl.DYNAMIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

    this.fadeVao = gl.createVertexArray()!
    const quad = gl.createBuffer()!
    gl.bindVertexArray(this.fadeVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, quad)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    )
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.bindVertexArray(null)

    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  setParam(name: string, value: number): void {
    this.values.set(name, value)
  }

  getParam(name: string): number {
    return this.values.get(name) ?? 0
  }

  update(ctx: FrameContext): void {
    const { signals, frame } = ctx
    // Audio drives amplitude and hue motion; silence still breathes a little.
    const rms = signals.get('rms')
    const bass = signals.get('bass')
    this.amp = 0.55 + 0.35 * Math.min(1, rms * 1.5 + bass * 0.5)
    this.huePhase = (this.huePhase + this.getParam('hueSpeed') * frame.dt) % 1
  }

  render(ctx: FrameContext): void {
    const gl = this.gpu.gl
    const t = ctx.frame.time
    const a = this.getParam('freqX')
    const b = this.getParam('freqY')
    const delta = t * this.getParam('drift') * Math.PI

    for (let i = 0; i < POINTS; i++) {
      const theta = (i / (POINTS - 1)) * Math.PI * 2
      this.positions[i * 2] = Math.sin(a * theta + delta) * this.amp
      this.positions[i * 2 + 1] = Math.sin(b * theta) * this.amp
    }

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

    // Fade pass: translucent black quad leaves trails from previous frames.
    gl.useProgram(this.fadeProgram)
    gl.uniform1f(gl.getUniformLocation(this.fadeProgram, 'uFade'), this.getParam('trail'))
    gl.bindVertexArray(this.fadeVao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    // Curve pass.
    gl.useProgram(this.lineProgram)
    const [r, g, bl] = hsl(this.huePhase, 0.85, 0.6)
    gl.uniform3f(gl.getUniformLocation(this.lineProgram, 'uColor'), r, g, bl)
    gl.uniform1f(
      gl.getUniformLocation(this.lineProgram, 'uAspect'),
      this.gpu.width / this.gpu.height,
    )
    gl.bindVertexArray(this.lineVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineVbo)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.positions)
    gl.drawArrays(gl.LINE_STRIP, 0, POINTS)
    gl.bindVertexArray(null)
  }

  resize(width: number, height: number): void {
    this.gpu.resize(width, height)
    this.gpu.gl.clearColor(0, 0, 0, 1)
    this.gpu.gl.clear(this.gpu.gl.COLOR_BUFFER_BIT)
  }

  dispose(): void {
    const gl = this.gpu.gl
    gl.deleteProgram(this.lineProgram)
    gl.deleteProgram(this.fadeProgram)
  }

  getShaderSources(): ShaderStage[] {
    return [
      { key: 'line-fs', label: 'Curve color (line-fs)', source: this.lineSource },
      { key: 'fade-fs', label: 'Trail fade (fade-fs)', source: this.fadeSource },
    ]
  }

  setShaderSource(key: string, source: string): void {
    const gl = this.gpu.gl
    switch (key) {
      case 'line-fs': {
        const program = this.gpu.compileProgram(LINE_VS, source) // throws on GLSL error; old program untouched
        gl.deleteProgram(this.lineProgram)
        this.lineProgram = program
        this.lineSource = source
        return
      }
      case 'fade-fs': {
        const program = this.gpu.compileProgram(FADE_VS, source)
        gl.deleteProgram(this.fadeProgram)
        this.fadeProgram = program
        this.fadeSource = source
        return
      }
      default:
        throw new Error(`Unknown shader stage "${key}" for scene "${this.meta.id}"`)
    }
  }
}
