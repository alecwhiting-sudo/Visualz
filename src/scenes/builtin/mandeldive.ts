import { mulberry32 } from '../../core/prng'
import type { Gpu } from '../../gpu/context'
import { FullscreenPass, type RenderSurface } from '../../gpu/targets'
import type { FrameContext, ParamSchema, SceneRuntime, ShaderStage } from '../types'

/**
 * Geometry family: a warp-free Mandelbrot whose evolution responds to bass —
 * a breathing zoom into a curated deep-boundary location. Like julia.ts, this
 * is GPU-stateless (one fullscreen fragment pass); all persistent state (dive
 * phase, envelopes, hue drift) lives on the CPU in `update()`, fed to the
 * shader as uniforms in `render()`.
 */

// Attribute-less fullscreen triangle, identical to julia.ts's.
const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`

const RENDER_FS = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uAspect;
uniform vec2 uDiveC;
uniform float uScale;
uniform int uIter;
uniform float uTrapMix, uHueShift, uHueSpread, uBrightness, uFlash;
out vec4 outColor;

vec3 hsv2rgb(vec3 c){ vec4 K=vec4(1.,2./3.,1./3.,3.); vec3 p=abs(fract(c.xxx+K.xyz)*6.-K.www); return c.z*mix(K.xxx,clamp(p-K.xxx,0.,1.),c.y); }

// Fixed unrolled iteration bound (worst case: points that never escape);
// uIter (70-200, scaled with dive depth by the CPU) is the actual per-pixel
// cutoff via the early "if (i >= uIter) break;" below.
const int MAX_ITER = 200;
const float BASE_EXTENT = 1.5; // same min-axis-fit half-width convention as julia.ts's zoom=1
const float ESCAPE_R2 = 16.0;
const vec2 TRAP_POINT = vec2(0.0, 0.25);

void main(){
  // Min-axis-fit complex plane, same convention as julia.ts: the shorter
  // screen axis spans [-BASE_EXTENT, BASE_EXTENT] / uScale around the dive
  // point, so the fractal never stretches at any aspect ratio.
  vec2 uv = (gl_FragCoord.xy / uResolution) * 2.0 - 1.0;
  uv.x *= max(uAspect, 1.0);
  uv.y /= min(uAspect, 1.0);
  vec2 c = uDiveC + uv * (BASE_EXTENT / uScale);

  vec2 z = vec2(0.0);
  float smoothN = float(uIter);
  bool escaped = false;
  float minDist = 1e9;
  for (int i = 0; i < MAX_ITER; i++) {
    if (i >= uIter) break;
    minDist = min(minDist, length(z - TRAP_POINT));
    z = vec2(z.x*z.x - z.y*z.y, 2.0*z.x*z.y) + c;
    float m2 = dot(z, z);
    if (m2 > ESCAPE_R2) {
      smoothN = float(i) + 1.0 - log2(log(sqrt(m2)));
      escaped = true;
      break;
    }
  }

  // Escape-gradient shading, same tuning as julia.ts's final look.
  float t = smoothN / float(uIter);
  float hue = fract(uHueShift + pow(t, 0.65) * uHueSpread);
  float glow = 0.08 + pow(t, 0.9) * 1.6;
  vec3 escapeCol = escaped ? hsv2rgb(vec3(hue, 0.75, clamp(glow, 0.0, 1.0))) : vec3(0.0);

  // Orbit-trap glow: a fixed complementary hue (offset 0.5 from the escape
  // gradient's hue shift) so the trap highlight reads as a distinct color
  // regardless of uHueShift. Interior points (escaped == false) start from
  // near-black escapeCol, so at trapMix > 0 they read as faint glow instead
  // of going solid black on deep zooms.
  float trapHue = fract(uHueShift + 0.5);
  vec3 trapCol = hsv2rgb(vec3(trapHue, 0.8, 1.0));
  float trapGlow = clamp(uTrapMix * exp(-minDist * 8.0), 0.0, 1.0);
  vec3 col = mix(escapeCol, trapCol, trapGlow);

  col *= uBrightness * (1.0 + uFlash);
  outColor = vec4(col, 1.0);
}`

// Curated dive targets — classic deep-boundary Mandelbrot locations, picked
// well since they stay visually rich across the whole zoom range the scene
// breathes through. One is chosen per seed via mulberry32(seed).
const DIVE_TARGETS: ReadonlyArray<{ x: number; y: number; label: string }> = [
  { x: -0.74364478, y: 0.13182525, label: 'Seahorse Valley' },
  { x: -0.1637007, y: 1.0259839, label: 'mini-mandel spiral' },
  { x: -1.7492, y: 0.0, label: 'needle' },
  { x: 0.25498704, y: -0.00056798, label: 'elephant valley cusp' },
  { x: -0.745428, y: 0.113009, label: 'double spiral' },
]

// Zoom-breathing tuning.
const MAX_LOG = Math.log(20000) // 1x -> 20000x -> 1x across a full breath cycle
const BASE_ITER = 70
const ITER_SPAN = 130
const MAX_ITER_UNIFORM = 200 // must match RENDER_FS's fixed MAX_ITER loop bound
const BASS_SMOOTH_TAU = 0.15 // seconds
const HUE_DRIFT_RATE = 0.02

// Onset flash envelope: same exponential-decay shape used elsewhere
// (julia.ts, lorenz-style scenes) for onset flashes.
const FLASH_DECAY = 8.0
const FLASH_GAIN = 1.0
const FLASH_MAX = 3.0

interface RenderLocs {
  uResolution: WebGLUniformLocation | null
  uAspect: WebGLUniformLocation | null
  uDiveC: WebGLUniformLocation | null
  uScale: WebGLUniformLocation | null
  uIter: WebGLUniformLocation | null
  uTrapMix: WebGLUniformLocation | null
  uHueShift: WebGLUniformLocation | null
  uHueSpread: WebGLUniformLocation | null
  uBrightness: WebGLUniformLocation | null
  uFlash: WebGLUniformLocation | null
}

export class MandelDiveScene implements SceneRuntime {
  meta = { id: 'mandeldive', name: 'Mandel Dive', family: 'geometry' as const }

  params: ParamSchema[] = [
    { name: 'diveSpeed', label: 'Dive speed', min: 0.02, max: 0.4, default: 0.09 },
    { name: 'maxDepth', label: 'Max depth', min: 0.3, max: 1.0, default: 1.0 },
    { name: 'trapMix', label: 'Trap glow', min: 0, max: 1, default: 0.5 },
    { name: 'hueShift', label: 'Hue shift', min: 0, max: 1, default: 0.62 },
    { name: 'hueSpread', label: 'Hue spread', min: 0.1, max: 1, default: 0.5 },
    { name: 'brightness', label: 'Brightness', min: 0.3, max: 2, default: 1.0 },
  ]

  private values = new Map<string, number>()
  private gpu!: Gpu
  private fsPass!: FullscreenPass
  private renderProgram!: WebGLProgram
  private renderLoc!: RenderLocs

  // CPU-only state (ARCHITECTURE.md §1): the dive point is picked once from
  // the seed; everything else accumulates dt every frame (never wall-clock).
  private diveC = { x: 0, y: 0 }
  private divePhase = 0
  private smoothedBass = 0
  private huePhase = 0
  private flash = 0

  // Code layer (ARCHITECTURE.md §3.3): current source for the one editable
  // stage, reset to stock every init().
  private renderSource = RENDER_FS

  init(gpu: Gpu, seed: number): void {
    this.gpu = gpu
    for (const p of this.params) this.values.set(p.name, p.default)

    const rng = mulberry32(seed)
    const idx = Math.floor(rng() * DIVE_TARGETS.length)
    const target = DIVE_TARGETS[Math.min(idx, DIVE_TARGETS.length - 1)]
    this.diveC = { x: target.x, y: target.y }
    this.divePhase = 0
    this.smoothedBass = 0
    this.huePhase = 0
    this.flash = 0

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
    const mid = signals.get('mid')
    const onset = signals.get('onset')
    const dt = frame.dt

    // Exp-smoothed bass envelope, ~0.15s halflife.
    const a = 1 - Math.exp(-dt / BASS_SMOOTH_TAU)
    this.smoothedBass += (bass - this.smoothedBass) * a

    // Breathing dive phase: bass speeds up the zoom breath (0.4x-2x the base rate).
    const diveSpeed = this.getParam('diveSpeed')
    this.divePhase += diveSpeed * (0.4 + 1.6 * this.smoothedBass) * dt

    // Slow hue drift driven by mid.
    this.huePhase += HUE_DRIFT_RATE * mid * dt

    // Onset-flash envelope.
    this.flash = this.flash * Math.exp(-FLASH_DECAY * dt) + FLASH_GAIN * onset
    if (this.flash > FLASH_MAX) this.flash = FLASH_MAX
  }

  render(_ctx: FrameContext, surface: RenderSurface): void {
    const gl = this.gpu.gl
    surface.bind()
    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)

    const maxDepth = this.getParam('maxDepth')
    const effectiveMaxLog = MAX_LOG * maxDepth
    // Breathing magnification: 1x -> 20000x*maxDepth -> 1x over a full divePhase cycle.
    const zoomLog = effectiveMaxLog * (0.5 - 0.5 * Math.cos(this.divePhase))
    const scale = Math.exp(zoomLog)
    const ratio = effectiveMaxLog > 0 ? zoomLog / effectiveMaxLog : 0
    const iter = Math.min(MAX_ITER_UNIFORM, Math.max(BASE_ITER, Math.floor(BASE_ITER + ITER_SPAN * ratio)))

    gl.useProgram(this.renderProgram)
    gl.uniform2f(this.renderLoc.uResolution, surface.width, surface.height)
    gl.uniform1f(this.renderLoc.uAspect, surface.width / surface.height)
    gl.uniform2f(this.renderLoc.uDiveC, this.diveC.x, this.diveC.y)
    gl.uniform1f(this.renderLoc.uScale, scale)
    gl.uniform1i(this.renderLoc.uIter, iter)
    gl.uniform1f(this.renderLoc.uTrapMix, this.getParam('trapMix'))
    gl.uniform1f(this.renderLoc.uHueShift, this.getParam('hueShift') + this.huePhase)
    gl.uniform1f(this.renderLoc.uHueSpread, this.getParam('hueSpread'))
    gl.uniform1f(this.renderLoc.uBrightness, this.getParam('brightness'))
    gl.uniform1f(this.renderLoc.uFlash, this.flash)
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
      uDiveC: gl.getUniformLocation(program, 'uDiveC'),
      uScale: gl.getUniformLocation(program, 'uScale'),
      uIter: gl.getUniformLocation(program, 'uIter'),
      uTrapMix: gl.getUniformLocation(program, 'uTrapMix'),
      uHueShift: gl.getUniformLocation(program, 'uHueShift'),
      uHueSpread: gl.getUniformLocation(program, 'uHueSpread'),
      uBrightness: gl.getUniformLocation(program, 'uBrightness'),
      uFlash: gl.getUniformLocation(program, 'uFlash'),
    }
  }

  getShaderSources(): ShaderStage[] {
    return [{ key: 'render-fs', label: 'Fractal (render-fs)', source: this.renderSource }]
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
