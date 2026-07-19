import { mulberry32 } from '../../core/prng'
import type { Gpu } from '../../gpu/context'
import { FullscreenPass, type RenderSurface } from '../../gpu/targets'
import type { FrameContext, ParamSchema, SceneRuntime, ShaderStage } from '../types'

/**
 * Geometry family: "another Mandelbrot dive, controlled differently" —
 * mandeldive.ts zooms into a curated boundary point and shades by smooth
 * escape count alone. Orbit Dive instead makes the *orbit trap* the star:
 * every pixel's escape orbit is tested each iteration against a geometric
 * trap shape, and the minimum distance the orbit ever comes to that trap
 * paints luminous filigree veins through the fractal's interior and
 * near-escape fringes — the classic orbit-trap look. A second knob (`family`)
 * continuously morphs the iteration map itself between Mandelbrot, Burning
 * Ship, and Tricorn, so the trap's veins get woven through genuinely
 * different (and, at intermediate `family` values, genuinely novel hybrid)
 * fractal geometry. GPU-stateless like mandeldive.ts/fractallab.ts: one
 * fullscreen fragment pass, pure function of uniforms every frame; all
 * persistent state (dive phase, trap spin phase, bass/onset envelopes, hue
 * drift) lives on the CPU in update(), fed to the shader in render().
 */

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
uniform float uFamily;
uniform float uTrapShape, uTrapSize, uTrapMix, uTrapTheta;
uniform float uHue, uContrast, uFlash;
out vec4 outColor;

vec3 hsv2rgb(vec3 c){ vec4 K=vec4(1.,2./3.,1./3.,3.); vec3 p=abs(fract(c.xxx+K.xyz)*6.-K.www); return c.z*mix(K.xxx,clamp(p-K.xxx,0.,1.),c.y); }
vec2 cmul(vec2 a, vec2 b){ return vec2(a.x*b.x - a.y*b.y, a.x*b.y + a.y*b.x); }

// Fixed iteration budget (spec: "~120", no depth-dependent scaling — unlike
// mandeldive.ts, the orbit trap itself carries the interior/near-escape
// structure, so pixels that never escape within ITER are still richly shaded
// by trap distance instead of needing more iterations to resolve detail).
const int ITER = 120;
const float BASE_EXTENT = 1.5; // same min-axis-fit half-width convention as mandeldive.ts
const float ESCAPE_R2 = 16.0;
const float HUE_SPREAD = 0.02;
const float TRAP_SHARPNESS = 9.0;
const vec3 INTERIOR_COL = vec3(0.05, 0.015, 0.0); // warm ember floor, not flat black

// Continuous trap-shape morph: 0=point, 1=cross, 2=circle(uTrapSize), 3=a
// rotating line through the origin at angle theta. Linearly cross-fades
// between whichever two shapes bracket the shape value so intermediate values are
// genuinely blended geometry, not a hard switch. uTrapSize does double duty:
// it's the circle's radius (shape~2) AND scales how far the glow reaches for
// every shape (see TRAP_SHARPNESS use at the call site) so the knob has a
// visible effect regardless of which shape is dialed in.
float trapDistance(vec2 z, float shape, float size, float theta) {
  float sizeSafe = max(size, 1e-4);
  float d0 = length(z);                       // point at origin
  float d1 = min(abs(z.x), abs(z.y));          // cross
  float d2 = abs(length(z) - sizeSafe);        // circle of radius size
  vec2 normal = vec2(-sin(theta), cos(theta));
  float d3 = abs(dot(z, normal));              // line through origin at angle theta
  float s = clamp(shape, 0.0, 3.0);
  if (s < 1.0) return mix(d0, d1, s);
  if (s < 2.0) return mix(d1, d2, s - 1.0);
  return mix(d2, d3, s - 2.0);
}

void main(){
  // Min-axis-fit complex plane, same convention as mandeldive.ts: the shorter
  // screen axis spans [-BASE_EXTENT, BASE_EXTENT] / uScale around the dive point.
  vec2 uv = (gl_FragCoord.xy / uResolution) * 2.0 - 1.0;
  uv.x *= max(uAspect, 1.0);
  uv.y /= min(uAspect, 1.0);
  vec2 c = uDiveC + uv * (BASE_EXTENT / uScale);

  // Continuous family morph (0=Mandelbrot, 1=Burning Ship, 2=Tricorn): fold z
  // toward its component-wise abs as family rises past 0, then fold the
  // result toward its conjugate as family rises past 1 — so family=0.5 is a
  // genuine half-abs hybrid, not either endpoint, and family=1.5 is a
  // half-conjugated Burning Ship, not a jump-cut to Tricorn.
  float absMix = clamp(uFamily, 0.0, 1.0);
  float conjMix = clamp(uFamily - 1.0, 0.0, 1.0);

  vec2 z = vec2(0.0);
  float smoothN = float(ITER);
  bool escaped = false;
  float minDist = 1e9;
  for (int i = 0; i < ITER; i++) {
    minDist = min(minDist, trapDistance(z, uTrapShape, uTrapSize, uTrapTheta));
    vec2 w = mix(z, abs(z), absMix);
    w = mix(w, vec2(w.x, -w.y), conjMix);
    z = cmul(w, w) + c;
    float m2 = dot(z, z);
    if (m2 > ESCAPE_R2) {
      smoothN = float(i) + 1.0 - log2(log(sqrt(m2)));
      escaped = true;
      break;
    }
  }

  // Plain escape-gradient shading: a blackbody-ish "ember" ramp rather than
  // mandeldive.ts's wide rainbow spread — heat (the smooth escape count)
  // both nudges hue slightly warmer AND desaturates/brightens, so cold
  // (low-heat) pixels read as deep near-black embers and hot (high-heat)
  // pixels read as pale gold-white, the way a real ember gradient looks.
  float t = clamp(smoothN / float(ITER), 0.0, 1.0);
  float heat = pow(t, 3.0);
  float hue = fract(uHue + heat * HUE_SPREAD);
  float sat = mix(0.92, 0.55, heat);
  float glow = 0.04 + heat * 1.3;
  vec3 escapeCol = escaped ? hsv2rgb(vec3(hue, sat, clamp(glow, 0.0, 1.0))) : INTERIOR_COL;

  // Orbit-trap glow: near-white-gold so the veins read as a distinct light
  // source woven through the ember escape bands, not just a recolored band.
  // uTrapSize widens the falloff (thicker veins) in addition to sizing the
  // circle trap shape. uTrapMix crossfades plain-escape <-> full trap coloring.
  vec3 trapCol = hsv2rgb(vec3(fract(uHue + 0.04), 0.18, 1.0));
  float trapGlow = clamp(exp(-minDist * TRAP_SHARPNESS / max(uTrapSize, 0.05)), 0.0, 1.0);
  vec3 col = mix(escapeCol, trapCol, clamp(uTrapMix * trapGlow, 0.0, 1.0));

  col *= uContrast * (1.0 + uFlash);
  outColor = vec4(col, 1.0);
}`

// Curated dive targets — deep-boundary complex-plane points chosen to stay
// visually rich (rather than flatten to plain interior or a formless dust)
// across the whole family morph (Mandelbrot / Burning Ship / Tricorn all
// have interesting structure near these coordinates) and the whole zoom
// breath. One is chosen per seed via mulberry32(seed), same convention as
// mandeldive.ts's DIVE_TARGETS.
const DIVE_TARGETS: ReadonlyArray<{ x: number; y: number; label: string }> = [
  { x: -1.62, y: 0.0, label: 'antenna root' },
  { x: -0.16370, y: 1.02598, label: 'mini-mandel bulb' },
  { x: 0.28693, y: 0.01412, label: 'elephant valley edge' },
  { x: -0.74364478, y: 0.13182525, label: 'seahorse spiral' },
  { x: -1.25066, y: 0.02012, label: 'seahorse tail' },
  { x: -0.5, y: 0.55, label: 'tricorn ear' },
]

// Zoom-breathing tuning: a full divePhase cycle (0 -> 2*pi) zooms 1x -> ~20000x
// -> 1x, the same magnification ceiling as mandeldive.ts and, per the task
// spec, the same "~1e-5 scale" precision floor (BASE_EXTENT / scale at the
// deepest point of the breath) before float32 precision would start to
// visibly degrade — the cosine shape means the dive never actually reaches
// that floor abruptly, it eases back out and loops, exactly like
// mandeldive.ts's breathing. diveSpeed is the divePhase angular rate (its
// units are "log-zoom per second" only loosely — the true log-zoom rate
// varies with sin(divePhase) - but the parameter is what drives how fast a
// full zoom-in-and-back-out loop happens).
const MAX_LOG = Math.log(20000)
const BASS_SMOOTH_TAU = 0.15 // seconds
const BASS_WIDEN_GAIN = 0.6 // how much bass widens the trap's glow reach
const SPIN_RATE = 1.0 // radians/sec at trapSpin = 1
const BEAT_NUDGE_GAIN = 0.4 // radians of musical nudge from beatPhase
const HUE_DRIFT_RATE = 0.004

// Onset flash envelope: same exponential-decay shape used elsewhere in this
// codebase (mandeldive.ts, julia.ts) for onset flashes.
const FLASH_DECAY = 8.0
const FLASH_GAIN = 1.0
const FLASH_MAX = 3.0

interface RenderLocs {
  uResolution: WebGLUniformLocation | null
  uAspect: WebGLUniformLocation | null
  uDiveC: WebGLUniformLocation | null
  uScale: WebGLUniformLocation | null
  uFamily: WebGLUniformLocation | null
  uTrapShape: WebGLUniformLocation | null
  uTrapSize: WebGLUniformLocation | null
  uTrapMix: WebGLUniformLocation | null
  uTrapTheta: WebGLUniformLocation | null
  uHue: WebGLUniformLocation | null
  uContrast: WebGLUniformLocation | null
  uFlash: WebGLUniformLocation | null
}

export class OrbitDiveScene implements SceneRuntime {
  meta = { id: 'orbitdive', name: 'Orbit Dive', family: 'geometry' as const }

  // Exactly 8 params, in the order the task spec fixes.
  params: ParamSchema[] = [
    { name: 'family', label: 'Family', min: 0, max: 2, default: 0 },
    { name: 'trapShape', label: 'Trap shape', min: 0, max: 3, default: 1.2 },
    { name: 'trapSize', label: 'Trap size', min: 0.05, max: 2, default: 0.6 },
    { name: 'trapMix', label: 'Trap mix', min: 0, max: 1, default: 0.7 },
    { name: 'diveSpeed', label: 'Dive speed', min: 0, max: 1.5, default: 0.35 },
    { name: 'trapSpin', label: 'Trap spin', min: -1, max: 1, default: 0.2 },
    { name: 'hue', label: 'Hue', min: 0, max: 1, default: 0.08 },
    { name: 'contrast', label: 'Contrast', min: 0.3, max: 2, default: 1 },
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
  private spinPhase = 0
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
    this.spinPhase = 0
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

    // Exp-smoothed bass envelope, ~0.15s halflife — widens the trap's glow
    // reach (see BASS_WIDEN_GAIN in render()).
    const a = 1 - Math.exp(-dt / BASS_SMOOTH_TAU)
    this.smoothedBass += (bass - this.smoothedBass) * a

    // Dive breathing phase: diveSpeed is the angular rate of the zoom-in/
    // zoom-out loop (see MAX_LOG's comment above).
    const diveSpeed = this.getParam('diveSpeed')
    this.divePhase += diveSpeed * dt

    // Trap-spin accumulator: trapSpin is a rate (radians/sec at |trapSpin|=1),
    // not an absolute angle — a per-frame beatPhase nudge is layered on top
    // in render() so the spin also reads as musically responsive.
    const trapSpin = this.getParam('trapSpin')
    this.spinPhase += trapSpin * SPIN_RATE * dt

    // Slow hue drift driven by mid, same idiom as mandeldive.ts's huePhase.
    this.huePhase += HUE_DRIFT_RATE * mid * dt

    // Onset-flash envelope.
    this.flash = this.flash * Math.exp(-FLASH_DECAY * dt) + FLASH_GAIN * onset
    if (this.flash > FLASH_MAX) this.flash = FLASH_MAX
  }

  render(ctx: FrameContext, surface: RenderSurface): void {
    const gl = this.gpu.gl
    surface.bind()
    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)

    const zoomLog = MAX_LOG * (0.5 - 0.5 * Math.cos(this.divePhase))
    const scale = Math.exp(zoomLog)

    const trapSize = this.getParam('trapSize') * (1 + BASS_WIDEN_GAIN * this.smoothedBass)
    const beatPhase = ctx.signals.get('beatPhase')
    const theta = this.spinPhase + beatPhase * BEAT_NUDGE_GAIN

    gl.useProgram(this.renderProgram)
    gl.uniform2f(this.renderLoc.uResolution, surface.width, surface.height)
    gl.uniform1f(this.renderLoc.uAspect, surface.width / surface.height)
    gl.uniform2f(this.renderLoc.uDiveC, this.diveC.x, this.diveC.y)
    gl.uniform1f(this.renderLoc.uScale, scale)
    gl.uniform1f(this.renderLoc.uFamily, this.getParam('family'))
    gl.uniform1f(this.renderLoc.uTrapShape, this.getParam('trapShape'))
    gl.uniform1f(this.renderLoc.uTrapSize, trapSize)
    gl.uniform1f(this.renderLoc.uTrapMix, this.getParam('trapMix'))
    gl.uniform1f(this.renderLoc.uTrapTheta, theta)
    gl.uniform1f(this.renderLoc.uHue, this.getParam('hue') + this.huePhase)
    gl.uniform1f(this.renderLoc.uContrast, this.getParam('contrast'))
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
      uFamily: gl.getUniformLocation(program, 'uFamily'),
      uTrapShape: gl.getUniformLocation(program, 'uTrapShape'),
      uTrapSize: gl.getUniformLocation(program, 'uTrapSize'),
      uTrapMix: gl.getUniformLocation(program, 'uTrapMix'),
      uTrapTheta: gl.getUniformLocation(program, 'uTrapTheta'),
      uHue: gl.getUniformLocation(program, 'uHue'),
      uContrast: gl.getUniformLocation(program, 'uContrast'),
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
