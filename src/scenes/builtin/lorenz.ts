import { mulberry32 } from '../../core/prng'
import type { Gpu } from '../../gpu/context'
import { checkFloatRenderable, FullscreenPass, PingPong, type RenderSurface } from '../../gpu/targets'
import { snapCountToSide, DEFAULT_COUNT, DEFAULT_SIDE } from '../families/particles/gpgpu'
import type { FrameContext, ParamSchema, SceneRuntime, ShaderStage } from '../types'

/**
 * Particles family, scene 2 (docs/PARTICLES.md §7): the Lorenz attractor. State
 * (x,y,z,age) lives in an RGBA32F ping-pong texture; each fragment integrates its
 * own particle forward with RK2 (midpoint), 4 fixed unrolled substeps. GLSL below
 * is transcribed verbatim from the spec.
 */

const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`

const FADE_FS = `#version 300 es
precision highp float;
uniform float uFade;
out vec4 outColor;
void main() { outColor = vec4(0.0, 0.0, 0.0, uFade); }`

const UPDATE_FS = `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform float uDt, uSpeed;
out vec4 outState;
vec3 deriv(vec3 s){ return vec3(10.0*(s.y-s.x), s.x*(28.0-s.z)-s.y, s.x*s.y-(8.0/3.0)*s.z); }
void main(){
  vec4 st = texelFetch(uState, ivec2(gl_FragCoord.xy), 0);
  vec3 s = st.xyz;
  float h = uSpeed*uDt/4.0;
  for(int i=0;i<4;i++){          // fixed bound → fully unrolled
    vec3 k1 = deriv(s);
    vec3 k2 = deriv(s + 0.5*h*k1);
    s += h*k2;
  }
  outState = vec4(s, st.a);
}`

const RENDER_VS = `#version 300 es
precision highp float;
uniform sampler2D uState;
uniform int uTexSize;
uniform float uAngle, uScale, uAspect, uPointSize, uResHeight;
out float vZ;
void main(){
  int i = gl_VertexID;
  vec3 s = texelFetch(uState, ivec2(i % uTexSize, i / uTexSize), 0).xyz;
  float ca=cos(uAngle), sa=sin(uAngle);
  float rx = s.x*ca - s.y*sa;
  vec2 p = vec2(rx, s.z-25.0) * uScale;    // uScale = 0.03125 * projScale
  vZ = (s.z-25.0)/25.0;
  p.x /= max(uAspect,1.0);
  p.y *= min(uAspect,1.0);
  gl_Position = vec4(p, 0.0, 1.0);
  gl_PointSize = uPointSize * max(uResHeight/360.0, 1.0);
}`

// Same premultiplied-additive hsv2rgb sprite as flowfield; hue from height
// instead of speed, alpha carries the brightness reactivity (docs/PARTICLES.md §7).
const RENDER_FS = `#version 300 es
precision highp float;
in float vZ;
uniform float uHueShift, uFalloff, uBrightness;
out vec4 outColor;
vec3 hsv2rgb(vec3 c){ vec4 K=vec4(1.,2./3.,1./3.,3.); vec3 p=abs(fract(c.xxx+K.xyz)*6.-K.www); return c.z*mix(K.xxx,clamp(p-K.xxx,0.,1.),c.y); }
void main(){
  vec2 d = gl_PointCoord*2.0-1.0;
  float r2 = dot(d,d);
  if(r2 > 1.0) discard;
  float alpha = exp(-r2*uFalloff) * uBrightness;
  vec3 col = hsv2rgb(vec3(fract(uHueShift + 0.15*vZ), 0.8, 1.0));
  outColor = vec4(col*alpha, alpha);
}`

const FALLOFF = 4.0
const BASE_SCALE = 0.03125 // 1/32, "0.84 NDC fit" base per docs/PARTICLES.md §7

// CPU seeding constants (docs/PARTICLES.md §7): canonical Lorenz params, a fixed
// reference-trajectory step, warm-up length, and stride between particles.
const SIGMA = 10
const RHO = 28
const BETA = 8 / 3
const SEED_H = 0.005
const WARMUP_STEPS = 2000
const STRIDE_STEPS = 3
const PERTURB = 0.02
// Canonical off-attractor Lorenz starting point; warm-up runs long enough
// (2000 steps) that the choice doesn't affect where seeding lands on the
// attractor (validated below against docs/PARTICLES.md §7's extent numbers).
const SEED_START: [number, number, number] = [0.1, 0.1, 0.1]

function deriv([x, y, z]: [number, number, number]): [number, number, number] {
  return [SIGMA * (y - x), x * (RHO - z) - y, x * y - BETA * z]
}

function rk2Step(s: [number, number, number], h: number): [number, number, number] {
  const k1 = deriv(s)
  const mid: [number, number, number] = [s[0] + 0.5 * h * k1[0], s[1] + 0.5 * h * k1[1], s[2] + 0.5 * h * k1[2]]
  const k2 = deriv(mid)
  return [s[0] + h * k2[0], s[1] + h * k2[1], s[2] + h * k2[2]]
}

/**
 * CPU seed (docs/PARTICLES.md §7): integrate a reference RK2 trajectory
 * (h=0.005), warm up 2000 steps, then place particle i at the trajectory point
 * reached after i more strides of 3 steps (continuing the same trajectory, not
 * restarting — O(warmup + 3n), not O(n²)), plus a ±0.02 mulberry32 perturbation
 * per axis. age = i/n.
 */
export function seedLorenzState(seed: number, n: number): Float32Array {
  let s = SEED_START
  for (let i = 0; i < WARMUP_STEPS; i++) s = rk2Step(s, SEED_H)

  const rng = mulberry32(seed)
  const out = new Float32Array(n * 4)
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < STRIDE_STEPS; k++) s = rk2Step(s, SEED_H)
    const dx = (rng() * 2 - 1) * PERTURB
    const dy = (rng() * 2 - 1) * PERTURB
    const dz = (rng() * 2 - 1) * PERTURB
    out[i * 4 + 0] = s[0] + dx
    out[i * 4 + 1] = s[1] + dy
    out[i * 4 + 2] = s[2] + dz
    out[i * 4 + 3] = i / n
  }
  return out
}

interface UpdateLocs {
  uState: WebGLUniformLocation | null
  uDt: WebGLUniformLocation | null
  uSpeed: WebGLUniformLocation | null
}

interface RenderLocs {
  uState: WebGLUniformLocation | null
  uTexSize: WebGLUniformLocation | null
  uAngle: WebGLUniformLocation | null
  uScale: WebGLUniformLocation | null
  uAspect: WebGLUniformLocation | null
  uPointSize: WebGLUniformLocation | null
  uResHeight: WebGLUniformLocation | null
  uHueShift: WebGLUniformLocation | null
  uFalloff: WebGLUniformLocation | null
  uBrightness: WebGLUniformLocation | null
}

export class LorenzScene implements SceneRuntime {
  meta = { id: 'lorenz', name: 'Lorenz Attractor', family: 'particles' as const }

  params: ParamSchema[] = [
    { name: 'count', label: 'Particle count', min: 4096, max: 262144, default: DEFAULT_COUNT, step: 1024 },
    { name: 'speed', label: 'Speed', min: 0.1, max: 3, default: 1.0 },
    { name: 'rotSpeed', label: 'Rotation speed', min: 0, max: 1, default: 0.15 },
    { name: 'projScale', label: 'Projection scale', min: 0.5, max: 2, default: 1.0 },
    { name: 'pointSize', label: 'Point size', min: 1, max: 6, default: 2.0 },
    { name: 'trail', label: 'Trail fade', min: 0.02, max: 0.5, default: 0.1 },
    { name: 'brightness', label: 'Brightness', min: 0.2, max: 2, default: 1.0 },
    { name: 'hueShift', label: 'Hue shift', min: 0, max: 1, default: 0.6 },
  ]

  private values = new Map<string, number>()
  private gpu!: Gpu
  private seed = 0
  private side = DEFAULT_SIDE
  private pendingSide: number | null = null
  private flash = 0

  private pp!: PingPong
  private fsPass!: FullscreenPass
  private updateProgram!: WebGLProgram
  private fadeProgram!: WebGLProgram
  private renderProgram!: WebGLProgram
  private updateLoc!: UpdateLocs
  private fadeLoc!: { uFade: WebGLUniformLocation | null }
  private renderLoc!: RenderLocs
  private pointsVao!: WebGLVertexArrayObject

  // Code layer (ARCHITECTURE.md §3.3): current source per editable stage, reset
  // to the stock defaults every init() so loadSession's dispose+init starts
  // clean. Uniform locations are cached (not per-render getUniformLocation
  // calls) so a program swap must refresh them.
  private updateSource = UPDATE_FS
  private renderSource = RENDER_FS

  init(gpu: Gpu, seed: number): void {
    const caps = checkFloatRenderable(gpu)
    if (!caps.ok) throw new Error(caps.reason)

    this.gpu = gpu
    this.seed = seed
    this.side = DEFAULT_SIDE
    this.pendingSide = null
    this.flash = 0
    for (const p of this.params) this.values.set(p.name, p.default)

    this.updateSource = UPDATE_FS
    this.renderSource = RENDER_FS

    const gl = gpu.gl
    this.pp = new PingPong(gpu, this.side, seedLorenzState(seed, this.side * this.side))
    this.fsPass = new FullscreenPass(gpu)

    this.updateProgram = gpu.compileProgram(FULLSCREEN_VS, this.updateSource)
    this.fadeProgram = gpu.compileProgram(FULLSCREEN_VS, FADE_FS)
    this.renderProgram = gpu.compileProgram(RENDER_VS, this.renderSource)

    this.updateLoc = this.lookupUpdateLocs(this.updateProgram)
    this.fadeLoc = { uFade: gl.getUniformLocation(this.fadeProgram, 'uFade') }
    this.renderLoc = this.lookupRenderLocs(this.renderProgram)

    const vao = gl.createVertexArray()
    if (!vao) throw new Error('Failed to create points VAO')
    this.pointsVao = vao

    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  setParam(name: string, value: number): void {
    if (name === 'count') {
      const side = snapCountToSide(value)
      this.values.set('count', side * side)
      this.pendingSide = side !== this.side ? side : null
      return
    }
    this.values.set(name, value)
  }

  getParam(name: string): number {
    return this.values.get(name) ?? 0
  }

  update(ctx: FrameContext): void {
    const { frame, signals } = ctx
    const gl = this.gpu.gl

    if (this.pendingSide !== null) {
      this.side = this.pendingSide
      this.pendingSide = null
      this.pp.resize(this.side, seedLorenzState(this.seed, this.side * this.side))
    }

    const rms = signals.get('rms')
    const speed = Math.min(3, Math.max(0.1, this.getParam('speed') * (0.6 + 0.8 * rms)))

    this.pp.dst.bindTarget()
    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)
    gl.useProgram(this.updateProgram)
    this.pp.src.bindTexture(0)
    gl.uniform1i(this.updateLoc.uState, 0)
    gl.uniform1f(this.updateLoc.uDt, frame.dt)
    gl.uniform1f(this.updateLoc.uSpeed, speed)
    this.fsPass.draw()
    this.pp.swap()

    // Onset-flash envelope, computed here (not in render()) so it advances once
    // per frame regardless of how many times render() might be called.
    const onset = signals.get('onset')
    this.flash = this.flash * Math.exp(-8 * frame.dt) + 0.8 * onset
  }

  render(ctx: FrameContext, surface: RenderSurface): void {
    const gl = this.gpu.gl
    surface.bind()

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    // Fade pass: relies on the surface's buffer persisting across frames —
    // true both for the default framebuffer (preserveDrawingBuffer) and a
    // texture target.
    gl.useProgram(this.fadeProgram)
    gl.uniform1f(this.fadeLoc.uFade, this.getParam('trail'))
    this.fsPass.draw()

    const bass = ctx.signals.get('bass')
    const brightness = this.getParam('brightness') * (0.7 + 0.6 * bass) + this.flash

    gl.blendFunc(gl.ONE, gl.ONE)
    gl.useProgram(this.renderProgram)
    this.pp.src.bindTexture(0)
    gl.uniform1i(this.renderLoc.uState, 0)
    gl.uniform1i(this.renderLoc.uTexSize, this.side)
    gl.uniform1f(this.renderLoc.uAngle, ctx.frame.time * this.getParam('rotSpeed'))
    gl.uniform1f(this.renderLoc.uScale, BASE_SCALE * this.getParam('projScale'))
    gl.uniform1f(this.renderLoc.uAspect, surface.width / surface.height)
    gl.uniform1f(this.renderLoc.uPointSize, this.getParam('pointSize'))
    gl.uniform1f(this.renderLoc.uResHeight, surface.height)
    gl.uniform1f(this.renderLoc.uHueShift, this.getParam('hueShift'))
    gl.uniform1f(this.renderLoc.uFalloff, FALLOFF)
    gl.uniform1f(this.renderLoc.uBrightness, brightness)
    gl.bindVertexArray(this.pointsVao)
    gl.drawArrays(gl.POINTS, 0, this.side * this.side)
    gl.bindVertexArray(null)
  }

  resize(width: number, height: number): void {
    this.gpu.resize(width, height)
    this.gpu.gl.clearColor(0, 0, 0, 1)
    this.gpu.gl.clear(this.gpu.gl.COLOR_BUFFER_BIT)
  }

  dispose(): void {
    const gl = this.gpu.gl
    gl.deleteProgram(this.updateProgram)
    gl.deleteProgram(this.fadeProgram)
    gl.deleteProgram(this.renderProgram)
    gl.deleteVertexArray(this.pointsVao)
    this.fsPass.dispose()
    this.pp.dispose()
  }

  private lookupUpdateLocs(program: WebGLProgram): UpdateLocs {
    const gl = this.gpu.gl
    return {
      uState: gl.getUniformLocation(program, 'uState'),
      uDt: gl.getUniformLocation(program, 'uDt'),
      uSpeed: gl.getUniformLocation(program, 'uSpeed'),
    }
  }

  private lookupRenderLocs(program: WebGLProgram): RenderLocs {
    const gl = this.gpu.gl
    return {
      uState: gl.getUniformLocation(program, 'uState'),
      uTexSize: gl.getUniformLocation(program, 'uTexSize'),
      uAngle: gl.getUniformLocation(program, 'uAngle'),
      uScale: gl.getUniformLocation(program, 'uScale'),
      uAspect: gl.getUniformLocation(program, 'uAspect'),
      uPointSize: gl.getUniformLocation(program, 'uPointSize'),
      uResHeight: gl.getUniformLocation(program, 'uResHeight'),
      uHueShift: gl.getUniformLocation(program, 'uHueShift'),
      uFalloff: gl.getUniformLocation(program, 'uFalloff'),
      uBrightness: gl.getUniformLocation(program, 'uBrightness'),
    }
  }

  getShaderSources(): ShaderStage[] {
    return [
      { key: 'update-fs', label: 'Integrator (update-fs)', source: this.updateSource },
      { key: 'render-fs', label: 'Point render (render-fs)', source: this.renderSource },
    ]
  }

  setShaderSource(key: string, source: string): void {
    const gl = this.gpu.gl
    switch (key) {
      case 'update-fs': {
        const program = this.gpu.compileProgram(FULLSCREEN_VS, source) // throws on GLSL error; old program untouched
        gl.deleteProgram(this.updateProgram)
        this.updateProgram = program
        this.updateLoc = this.lookupUpdateLocs(program)
        this.updateSource = source
        return
      }
      case 'render-fs': {
        const program = this.gpu.compileProgram(RENDER_VS, source)
        gl.deleteProgram(this.renderProgram)
        this.renderProgram = program
        this.renderLoc = this.lookupRenderLocs(program)
        this.renderSource = source
        return
      }
      default:
        throw new Error(`Unknown shader stage "${key}" for scene "${this.meta.id}"`)
    }
  }
}
