import type { Gpu } from '../../gpu/context'
import type { RenderSurface } from '../../gpu/targets'
import type { FrameContext, ParamSchema, SceneRuntime, ShaderStage } from '../types'

/**
 * Geometry family: "Strange Attractor" — a glowing, filamentary point cloud
 * traced by iterating the CLIFFORD map
 *   x' = sin(a*y) + c*cos(a*x)
 *   y' = sin(b*x) + d*cos(b*y)
 * as a SINGLE trajectory of NPOINTS iterates, recomputed from scratch every
 * frame from a fixed seed point. a/b/c/d are the exposed "equation knobs" —
 * this is the nerdy sandbox, the user literally dials the maths — plus a
 * small deterministic drift and an audio-reactive nudge so the cloud slowly
 * morphs and breathes with the music.
 *
 * PRNG discipline: the trajectory itself needs NO randomness at all (the map
 * is a pure deterministic iteration of frame.time + signals + params). The
 * only place "randomness" appears is per-point colour jitter, which uses a
 * pure hash of the point index (mulberry32-adjacent hash32, ported from
 * terrain.ts/flowfield.ts's GLSL `hash32`) XORed with the scene seed — never
 * a PRNG *stream* and never Math.random. That keeps `colour(i)` a pure
 * function of `i`, independent of anything but its own index.
 *
 * CPU/GPU split (mirrors terrain.ts's ring-buffer / projection split):
 * `update()` iterates the map and fills aspect-INDEPENDENT scratch arrays
 * (normalised position + colour per point) — everything that depends only on
 * frame.time/signals/params. `render()` knows the actual surface aspect, so
 * it applies the aspect correction (`ax = 1/max(aspect,1)`, `ay =
 * min(aspect,1)`, terrain/flowfield's convention) while packing the GPU
 * vertex buffer, then draws a soft-fade quad (afterglow) followed by additive
 * `gl.POINTS`.
 */

const BURN_IN = 20
const NPOINTS = 50000
const SEED_X = 0.1
const SEED_Y = 0.1
const NORM = 2.6 // Clifford attractor lives roughly in [-3,3]^2

const FLOATS_PER_VERTEX = 6 // pos.xy + color.rgba

const POINT_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec4 aColor;
uniform float uPointSize, uResHeight;
out vec4 vColor;
void main() {
  vColor = aColor;
  gl_Position = vec4(aPos, 0.0, 1.0);
  gl_PointSize = uPointSize * max(uResHeight / 720.0, 1.0);
}`

const POINT_FS = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 outColor;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  float alpha = smoothstep(1.0, 0.0, r2);
  outColor = vec4(vColor.rgb * alpha, alpha);
}`

const FADE_VS = `#version 300 es
layout(location = 0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`

const FADE_FS = `#version 300 es
precision highp float;
uniform float uFade;
out vec4 outColor;
void main() { outColor = vec4(0.0, 0.0, 0.0, uFade); }`

const FADE_AMOUNT = 0.16 // afterglow persistence between frames (terrain.ts uses 0.35 for its wireframe; a
                          // lighter fade suits the denser point cloud so filaments don't wash out)
const POINT_SIZE = 2.6

// --- Pure hash (no PRNG stream — see class doc) -----------------------------

function hash32(x: number): number {
  x = (x + 0x9e3779b9) >>> 0
  x = x ^ (x >>> 16)
  x = Math.imul(x, 0x7feb352d) >>> 0
  x = x ^ (x >>> 15)
  x = Math.imul(x, 0x846ca68b) >>> 0
  x = x ^ (x >>> 16)
  return x >>> 0
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

function hsv2rgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s
  const hp = (((h % 1) + 1) % 1) * 6
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let r = 0
  let g = 0
  let b = 0
  if (hp < 1) { r = c; g = x; b = 0 }
  else if (hp < 2) { r = x; g = c; b = 0 }
  else if (hp < 3) { r = 0; g = c; b = x }
  else if (hp < 4) { r = 0; g = x; b = c }
  else if (hp < 5) { r = x; g = 0; b = c }
  else { r = c; g = 0; b = x }
  const m = v - c
  return [r + m, g + m, b + m]
}

interface PointLocs {
  uPointSize: WebGLUniformLocation | null
  uResHeight: WebGLUniformLocation | null
}

export class StrangeAttractorScene implements SceneRuntime {
  meta = { id: 'attractor', name: 'Strange Attractor', family: 'geometry' as const }

  params: ParamSchema[] = [
    { name: 'a', label: 'A', min: -2.5, max: 2.5, default: -1.7 },
    { name: 'b', label: 'B', min: -2.5, max: 2.5, default: 1.8 },
    { name: 'c', label: 'C', min: -2.5, max: 2.5, default: -1.9 },
    { name: 'd', label: 'D', min: -2.5, max: 2.5, default: -0.4 },
    { name: 'zoom', label: 'Zoom', min: 0.4, max: 3, default: 1 },
    { name: 'hue', label: 'Hue', min: 0, max: 1, default: 0.72 },
    { name: 'audioWarp', label: 'Audio warp', min: 0, max: 1, default: 0.4 },
    { name: 'glow', label: 'Glow', min: 0.3, max: 2, default: 1 },
  ]

  private values = new Map<string, number>()
  private gpu!: Gpu
  private seedXor = 0

  // Scratch per-point arrays filled by update() — aspect-independent (see
  // class doc). Sized once; reused every frame, no per-frame allocation.
  private rawX = new Float32Array(NPOINTS)
  private rawY = new Float32Array(NPOINTS)
  private colR = new Float32Array(NPOINTS)
  private colG = new Float32Array(NPOINTS)
  private colB = new Float32Array(NPOINTS)

  // GPU vertex buffer scratch, packed by render() once it knows the surface
  // aspect.
  private verts = new Float32Array(NPOINTS * FLOATS_PER_VERTEX)

  private pointProgram!: WebGLProgram
  private fadeProgram!: WebGLProgram
  private pointVao!: WebGLVertexArrayObject
  private pointVbo!: WebGLBuffer
  private fadeVao!: WebGLVertexArrayObject
  private pointLoc!: PointLocs
  private fadeLoc!: { uFade: WebGLUniformLocation | null }

  // Code layer (ARCHITECTURE.md §3.3): current source per editable stage,
  // reset to stock every init() so loadSession's dispose+init starts clean.
  private pointSource = POINT_FS
  private fadeSource = FADE_FS

  init(gpu: Gpu, seed: number): void {
    this.gpu = gpu
    this.seedXor = seed >>> 0
    for (const p of this.params) this.values.set(p.name, p.default)

    this.pointSource = POINT_FS
    this.fadeSource = FADE_FS

    const gl = gpu.gl
    this.pointProgram = gpu.compileProgram(POINT_VS, this.pointSource)
    this.fadeProgram = gpu.compileProgram(FADE_VS, this.fadeSource)
    this.pointLoc = this.lookupPointLocs(this.pointProgram)
    this.fadeLoc = { uFade: gl.getUniformLocation(this.fadeProgram, 'uFade') }

    this.pointVao = gl.createVertexArray()!
    this.pointVbo = gl.createBuffer()!
    gl.bindVertexArray(this.pointVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointVbo)
    gl.bufferData(gl.ARRAY_BUFFER, this.verts.byteLength, gl.DYNAMIC_DRAW)
    const stride = FLOATS_PER_VERTEX * 4
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, stride, 2 * 4)

    this.fadeVao = gl.createVertexArray()!
    const quad = gl.createBuffer()!
    gl.bindVertexArray(this.fadeVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, quad)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
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
    const { frame, signals } = ctx
    const bass = signals.get('bass')
    const mid = signals.get('mid')
    const high = signals.get('high')
    const rms = signals.get('rms')

    const audioWarp = this.getParam('audioWarp')
    const zoom = this.getParam('zoom')
    const hue = this.getParam('hue')
    const glow = this.getParam('glow')

    // Live equation constants: base knob + a small deterministic drift +
    // an audio-reactive nudge, each on its own rate/phase/band so the four
    // constants morph independently rather than in lockstep (class doc).
    const t = frame.time
    const a = this.getParam('a') + 0.15 * Math.sin(t * 0.13 + 0.0) + audioWarp * bass * 0.5
    const b = this.getParam('b') + 0.15 * Math.sin(t * 0.17 + 1.7) + audioWarp * mid * 0.5
    const c = this.getParam('c') + 0.15 * Math.sin(t * 0.11 + 3.1) + audioWarp * high * 0.5
    const d = this.getParam('d') + 0.15 * Math.sin(t * 0.19 + 4.6) + audioWarp * rms * 0.5

    let x = SEED_X
    let y = SEED_Y
    for (let i = 0; i < BURN_IN; i++) {
      const nx = Math.sin(a * y) + c * Math.cos(a * x)
      const ny = Math.sin(b * x) + d * Math.cos(b * y)
      x = nx
      y = ny
    }

    for (let i = 0; i < NPOINTS; i++) {
      const nx = Math.sin(a * y) + c * Math.cos(a * x)
      const ny = Math.sin(b * x) + d * Math.cos(b * y)
      const dx = nx - x
      const dy = ny - y
      const step = Math.sqrt(dx * dx + dy * dy)
      x = nx
      y = ny

      this.rawX[i] = (x / NORM) * zoom
      this.rawY[i] = (y / NORM) * zoom

      // Colour: hue/brightness vary with local step length (gives the
      // filaments depth instead of one flat colour) plus a tiny per-index
      // hash jitter (pure function of i — never Math.random, see class doc).
      const speedNorm = clamp01(step * 0.6)
      const jitter = (hash32(i ^ this.seedXor) / 4294967296 - 0.5) * 0.05
      const localHue = hue + speedNorm * 0.1 - 0.05 + jitter
      const val = clamp01(0.55 + 0.45 * speedNorm)
      const [r, g, bl] = hsv2rgb(localHue, 0.7 + 0.25 * speedNorm, val)
      const intensity = glow * (0.5 + 0.6 * speedNorm)
      this.colR[i] = r * intensity
      this.colG[i] = g * intensity
      this.colB[i] = bl * intensity
    }
  }

  render(_ctx: FrameContext, surface: RenderSurface): void {
    const gl = this.gpu.gl
    surface.bind()

    // Aspect correction (flowfield.ts's render-vs convention) applied here,
    // not in update(), because only render() knows the actual surface shape
    // — a scene rendered into a child target must compose for THAT target.
    const aspect = surface.width / surface.height
    const ax = 1 / Math.max(aspect, 1)
    const ay = Math.min(aspect, 1)

    let n = 0
    for (let i = 0; i < NPOINTS; i++) {
      this.verts[n++] = this.rawX[i] * ax
      this.verts[n++] = this.rawY[i] * ay
      this.verts[n++] = this.colR[i]
      this.verts[n++] = this.colG[i]
      this.verts[n++] = this.colB[i]
      this.verts[n++] = 1.0
    }

    gl.enable(gl.BLEND)

    // Fade pass: translucent black quad — soft afterglow, matching
    // terrain.ts/flowfield.ts's trail-persistence convention. Relies on the
    // surface's buffer persisting across frames (true for both the default
    // framebuffer and a texture target).
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    gl.useProgram(this.fadeProgram)
    gl.uniform1f(this.fadeLoc.uFade, FADE_AMOUNT)
    gl.bindVertexArray(this.fadeVao)
    gl.drawArrays(gl.TRIANGLES, 0, 3)

    // Point pass: additive for the neon-glow look (overlapping filaments brighten).
    gl.blendFunc(gl.ONE, gl.ONE)
    gl.useProgram(this.pointProgram)
    gl.uniform1f(this.pointLoc.uPointSize, POINT_SIZE)
    gl.uniform1f(this.pointLoc.uResHeight, surface.height)
    gl.bindVertexArray(this.pointVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.pointVbo)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.verts)
    gl.drawArrays(gl.POINTS, 0, NPOINTS)
    gl.bindVertexArray(null)
  }

  resize(width: number, height: number): void {
    this.gpu.resize(width, height)
    this.gpu.gl.clearColor(0, 0, 0, 1)
    this.gpu.gl.clear(this.gpu.gl.COLOR_BUFFER_BIT)
  }

  dispose(): void {
    const gl = this.gpu.gl
    gl.deleteProgram(this.pointProgram)
    gl.deleteProgram(this.fadeProgram)
    gl.deleteVertexArray(this.pointVao)
    gl.deleteBuffer(this.pointVbo)
    gl.deleteVertexArray(this.fadeVao)
  }

  getShaderSources(): ShaderStage[] {
    return [
      { key: 'point-fs', label: 'Point glow (point-fs)', source: this.pointSource },
      { key: 'fade-fs', label: 'Trail fade (fade-fs)', source: this.fadeSource },
    ]
  }

  setShaderSource(key: string, source: string): void {
    const gl = this.gpu.gl
    switch (key) {
      case 'point-fs': {
        const program = this.gpu.compileProgram(POINT_VS, source) // throws on GLSL error; old program untouched
        gl.deleteProgram(this.pointProgram)
        this.pointProgram = program
        this.pointLoc = this.lookupPointLocs(program)
        this.pointSource = source
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

  private lookupPointLocs(program: WebGLProgram): PointLocs {
    const gl = this.gpu.gl
    return {
      uPointSize: gl.getUniformLocation(program, 'uPointSize'),
      uResHeight: gl.getUniformLocation(program, 'uResHeight'),
    }
  }
}
