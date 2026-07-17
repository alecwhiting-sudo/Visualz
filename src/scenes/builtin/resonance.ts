import { mulberry32, type Prng } from '../../core/prng'
import type { Gpu } from '../../gpu/context'
import { FullscreenPass, type RenderSurface } from '../../gpu/targets'
import type { FrameContext, ParamSchema, SceneRuntime, ShaderStage } from '../types'

/**
 * Geometry family wildcard: a Chladni plate — the standing-wave nodal
 * patterns sand traces on a vibrating plate, `chladni(x,y,m,n) =
 * cos(m*PI*x)*cos(n*PI*y) - cos(n*PI*x)*cos(m*PI*y)` on the aspect-fitted
 * unit square. GPU-stateless like julia.ts (one fullscreen fragment pass);
 * all persistent state (the current/next mode pair, crossfade phase, and the
 * mode-picking PRNG stream) lives on the CPU in update().
 *
 * Mode changes are event-driven, not continuous: on every onset pulse, the
 * scene picks a *new* target mode pair (m,n) — mixing the current band
 * energies with one deterministic PRNG draw — and crossfades the rendered
 * pattern from whatever it's currently settled on toward that new pair over
 * `morph` seconds. The PRNG (mulberry32(seed)) is advanced ONLY by onset
 * events (one draw per onset) plus a fixed three draws at init (starting
 * pair + grain seed) — never per-frame — so replay reproduces the identical mode
 * sequence regardless of anything but the onset signal's frame-indexed
 * on/off sequence, which fixed-timestep replay reproduces exactly.
 */

const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`

// hash32 copied verbatim from flowfield.ts's UPDATE_FS (same block julia.ts,
// morphogen.ts, kaleido.ts also copy) so the grain overlay stays
// bit-consistent with the rest of the codebase's hash idiom.
const RENDER_FS = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uAspect;
uniform float uMA, uNA, uMB, uNB, uFade;
uniform float uSharpness, uHueShift, uBrightness, uGrain, uSeed, uRms;
out vec4 outColor;

const float PI = 3.14159265359;

uint hash32(uint x){ x=x+0x9e3779b9u; x^=x>>16u; x*=0x7feb352du; x^=x>>15u; x*=0x846ca68bu; x^=x>>16u; return x; }
vec3 hsv2rgb(vec3 c){ vec4 K=vec4(1.,2./3.,1./3.,3.); vec3 p=abs(fract(c.xxx+K.xyz)*6.-K.www); return c.z*mix(K.xxx,clamp(p-K.xxx,0.,1.),c.y); }

// Standing-wave nodal function for a square plate driven at modes (m,n).
float chladni(float x, float y, float m, float n) {
  return cos(m * PI * x) * cos(n * PI * y) - cos(n * PI * x) * cos(m * PI * y);
}

void main(){
  // Aspect-fitted unit square, centered, letterboxed by the same min-axis
  // convention used everywhere else (julia.ts/mandeldive.ts/tunnel.ts): the
  // shorter screen axis spans exactly [-1, 1]; the longer axis simply keeps
  // evaluating the (unbounded-domain) cosine pattern past +-1 rather than
  // cropping, so the plate never looks stretched at any aspect ratio.
  vec2 uv = (gl_FragCoord.xy / uResolution) * 2.0 - 1.0;
  uv.x *= max(uAspect, 1.0);
  uv.y /= min(uAspect, 1.0);

  float a = chladni(uv.x, uv.y, uMA, uNA);
  float b = chladni(uv.x, uv.y, uMB, uNB);
  float v = mix(a, b, uFade);

  // Bright nodal lines ("sand" collecting where the plate doesn't move).
  float intensity = exp(-uSharpness * abs(v));

  // Deterministic per-pixel grain: seeded by a fixed uSeed uniform (derived
  // once from the scene's PRNG at init, never from time), not by frame index —
  // "seeded, no time-based randomness beyond uniforms" per spec.
  uint gh = hash32(uint(gl_FragCoord.x) * 1973u + uint(gl_FragCoord.y) * 9277u + uint(uSeed));
  float grain = float(gh) / 4294967296.0 - 0.5;

  float value = clamp(intensity + grain * uGrain * 0.25, 0.0, 1.0);
  vec3 col = hsv2rgb(vec3(fract(uHueShift + intensity * 0.12), 0.55, value));
  col *= uBrightness * (1.0 + 0.3 * uRms); // rms lifts overall brightness slightly
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`

interface ModePair {
  m: number
  n: number
}

function clampMode(v: number): number {
  return Math.min(9, Math.max(1, v))
}

interface RenderLocs {
  uResolution: WebGLUniformLocation | null
  uAspect: WebGLUniformLocation | null
  uMA: WebGLUniformLocation | null
  uNA: WebGLUniformLocation | null
  uMB: WebGLUniformLocation | null
  uNB: WebGLUniformLocation | null
  uFade: WebGLUniformLocation | null
  uSharpness: WebGLUniformLocation | null
  uHueShift: WebGLUniformLocation | null
  uBrightness: WebGLUniformLocation | null
  uGrain: WebGLUniformLocation | null
  uSeed: WebGLUniformLocation | null
  uRms: WebGLUniformLocation | null
}

export class ResonanceScene implements SceneRuntime {
  meta = { id: 'resonance', name: 'Resonance', family: 'geometry' as const }

  params: ParamSchema[] = [
    { name: 'modeBias', label: 'Mode bias', min: 0, max: 2, default: 1 },
    { name: 'sharpness', label: 'Sharpness', min: 2, max: 40, default: 14 },
    { name: 'morph', label: 'Morph', min: 0.05, max: 2, default: 0.35 },
    { name: 'hueShift', label: 'Hue shift', min: 0, max: 1, default: 0.6 },
    { name: 'brightness', label: 'Brightness', min: 0.3, max: 2, default: 1 },
    { name: 'grain', label: 'Grain', min: 0, max: 1, default: 0.3 },
  ]

  private values = new Map<string, number>()
  private gpu!: Gpu
  private fsPass!: FullscreenPass
  private renderProgram!: WebGLProgram
  private renderLoc!: RenderLocs

  // CPU-only state (ARCHITECTURE.md §1): mode-picking PRNG stream (advanced
  // only on onsets, plus twice at init — see class doc), the current/next
  // mode pairs, the dt-advanced crossfade phase, and a fixed grain seed
  // (derived once from the same stream, never from time).
  private rng!: Prng
  private pairA: ModePair = { m: 1, n: 2 }
  private pairB: ModePair = { m: 1, n: 2 }
  private fadePhase = 1
  private grainSeed = 0

  private renderSource = RENDER_FS

  init(gpu: Gpu, seed: number): void {
    this.gpu = gpu
    for (const p of this.params) this.values.set(p.name, p.default)

    this.rng = mulberry32(seed)
    // Starting mode pair: two draws, signal-free (no audio yet at init time),
    // just enough spread to look non-trivial from frame 0 before the first
    // onset takes over the real audio-reactive picking below.
    const m0 = clampMode(1 + Math.floor(this.rng() * 4))
    let n0 = clampMode(m0 + 1 + Math.floor(this.rng() * 3))
    if (n0 === m0) n0 = m0 >= 9 ? m0 - 1 : m0 + 1
    this.pairA = { m: m0, n: n0 }
    this.pairB = { m: m0, n: n0 }
    this.fadePhase = 1 // fully settled on pairA (pairA === pairB) until the first onset
    this.grainSeed = Math.floor(this.rng() * 1_000_000)

    this.renderSource = RENDER_FS

    const gl = gpu.gl
    this.fsPass = new FullscreenPass(gpu)
    this.renderProgram = gpu.compileProgram(FULLSCREEN_VS, this.renderSource)
    this.renderLoc = this.lookupRenderLocs(this.renderProgram)

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
    const high = signals.get('high')
    const onset = signals.get('onset')

    if (onset) {
      // Finalize whatever we were fading toward, then pick a fresh target —
      // one PRNG draw, this frame only (count-based advance, see class doc).
      this.pairA = this.pairB
      const modeBias = this.getParam('modeBias')
      const rngStep = this.rng()
      const m = clampMode(1 + Math.floor(bass * modeBias * 6 + rngStep))
      let n = clampMode(m + 1 + Math.floor(high * 4))
      if (n === m) n = m >= 9 ? m - 1 : m + 1
      this.pairB = { m, n }
      this.fadePhase = 0
    }

    const morph = Math.max(0.001, this.getParam('morph'))
    this.fadePhase = Math.min(1, this.fadePhase + frame.dt / morph)
  }

  render(ctx: FrameContext, surface: RenderSurface): void {
    const gl = this.gpu.gl
    surface.bind()
    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)

    const t = this.fadePhase
    const fadeSmoothed = t * t * (3 - 2 * t) // smoothstep, same shape as morphogen.ts's journey crossfade
    const rms = ctx.signals.get('rms')

    gl.useProgram(this.renderProgram)
    gl.uniform2f(this.renderLoc.uResolution, surface.width, surface.height)
    gl.uniform1f(this.renderLoc.uAspect, surface.width / surface.height)
    gl.uniform1f(this.renderLoc.uMA, this.pairA.m)
    gl.uniform1f(this.renderLoc.uNA, this.pairA.n)
    gl.uniform1f(this.renderLoc.uMB, this.pairB.m)
    gl.uniform1f(this.renderLoc.uNB, this.pairB.n)
    gl.uniform1f(this.renderLoc.uFade, fadeSmoothed)
    gl.uniform1f(this.renderLoc.uSharpness, this.getParam('sharpness'))
    gl.uniform1f(this.renderLoc.uHueShift, this.getParam('hueShift'))
    gl.uniform1f(this.renderLoc.uBrightness, this.getParam('brightness'))
    gl.uniform1f(this.renderLoc.uGrain, this.getParam('grain'))
    gl.uniform1f(this.renderLoc.uSeed, this.grainSeed)
    gl.uniform1f(this.renderLoc.uRms, rms)
    this.fsPass.draw()
  }

  resize(width: number, height: number): void {
    this.gpu.resize(width, height)
    this.gpu.gl.clearColor(0, 0, 0, 1)
    this.gpu.gl.clear(this.gpu.gl.COLOR_BUFFER_BIT)
  }

  dispose(): void {
    const gl = this.gpu.gl
    gl.deleteProgram(this.renderProgram)
    this.fsPass.dispose()
  }

  private lookupRenderLocs(program: WebGLProgram): RenderLocs {
    const gl = this.gpu.gl
    return {
      uResolution: gl.getUniformLocation(program, 'uResolution'),
      uAspect: gl.getUniformLocation(program, 'uAspect'),
      uMA: gl.getUniformLocation(program, 'uMA'),
      uNA: gl.getUniformLocation(program, 'uNA'),
      uMB: gl.getUniformLocation(program, 'uMB'),
      uNB: gl.getUniformLocation(program, 'uNB'),
      uFade: gl.getUniformLocation(program, 'uFade'),
      uSharpness: gl.getUniformLocation(program, 'uSharpness'),
      uHueShift: gl.getUniformLocation(program, 'uHueShift'),
      uBrightness: gl.getUniformLocation(program, 'uBrightness'),
      uGrain: gl.getUniformLocation(program, 'uGrain'),
      uSeed: gl.getUniformLocation(program, 'uSeed'),
      uRms: gl.getUniformLocation(program, 'uRms'),
    }
  }

  getShaderSources(): ShaderStage[] {
    return [{ key: 'render-fs', label: 'Chladni plate (render-fs)', source: this.renderSource }]
  }

  setShaderSource(key: string, source: string): void {
    const gl = this.gpu.gl
    switch (key) {
      case 'render-fs': {
        const program = this.gpu.compileProgram(FULLSCREEN_VS, source) // throws on GLSL error; old program untouched
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
