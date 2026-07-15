import { mulberry32 } from '../../core/prng'
import type { Gpu } from '../../gpu/context'
import { FullscreenPass, type RenderSurface } from '../../gpu/targets'
import type { FrameContext, ParamSchema, SceneRuntime, ShaderStage } from '../types'

/**
 * Geometry family: a Julia-set fractal with domain warp. Unlike the particle
 * scenes, this is entirely GPU-stateless — one fullscreen fragment pass, a
 * pure function of uniforms every frame. All persistent state (the orbiting
 * `c` phase and the audio-reactive envelopes) lives on the CPU in `update()`,
 * fed to the shader as uniforms in `render()`.
 */

// Attribute-less fullscreen triangle: standard gl_VertexID trick, no VBO
// needed. Not exposed as an editable stage (only the fragment shader is —
// "the whole fractal is one fragment shader").
const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 pos = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(pos * 2.0 - 1.0, 0.0, 1.0);
}`

// hash32/vnoise2 copied verbatim from flowfield.ts's UPDATE_FS so the domain
// warp is bit-consistent with the DSL's noise builtin.
const RENDER_FS = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform float uAspect, uZoom, uWarp, uCAngle, uCRadius, uTime;
uniform float uHueShift, uHueSpread, uBrightness, uFlash;
out vec4 outColor;

uint hash32(uint x){ x=x+0x9e3779b9u; x^=x>>16u; x*=0x7feb352du; x^=x>>15u; x*=0x846ca68bu; x^=x>>16u; return x; }
float lattice2(int ix,int iy){ uint k = hash32(uint(ix)) ^ (uint(iy)*0x9e3779b9u); return float(hash32(k))/4294967296.0*2.0-1.0; }
float fade(float t){ return t*t*(3.0-2.0*t); }
float vnoise2(vec2 p){
  vec2 i=floor(p), f=p-i; vec2 u=vec2(fade(f.x),fade(f.y));
  int ix=int(i.x), iy=int(i.y);
  float a=lattice2(ix,iy), b=lattice2(ix+1,iy), c=lattice2(ix,iy+1), d=lattice2(ix+1,iy+1);
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y);
}

vec3 hsv2rgb(vec3 c){ vec4 K=vec4(1.,2./3.,1./3.,3.); vec3 p=abs(fract(c.xxx+K.xyz)*6.-K.www); return c.z*mix(K.xxx,clamp(p-K.xxx,0.,1.),c.y); }

const int ITER = 96;

void main(){
  // Min-axis-fit complex plane: the shorter screen axis always spans
  // [-1.5, 1.5] * uZoom, so the set never stretches at any aspect ratio.
  vec2 uv = (gl_FragCoord.xy / uResolution) * 2.0 - 1.0;
  uv.x *= max(uAspect, 1.0);
  uv.y /= min(uAspect, 1.0);
  vec2 p = uv * 1.5 * uZoom;

  // Domain warp before iterating.
  p += uWarp * vec2(vnoise2(p*2.0 + uTime), vnoise2(p*2.0 - uTime));

  vec2 c = uCRadius * vec2(cos(uCAngle), sin(uCAngle));
  vec2 z = p;
  float smoothN = float(ITER);
  bool escaped = false;
  // ITER=96 is a fixed unrolled bound (worst case: interior/boundary pixels
  // that never escape), but almost all pixels escape within a handful of
  // iterations — breaking out early is what keeps this a "good SwiftShader/
  // mobile balance" per the spec; it does not change smoothN (already
  // locked at the first crossing) or the resulting color.
  for (int i = 0; i < ITER; i++) {
    z = vec2(z.x*z.x - z.y*z.y, 2.0*z.x*z.y) + c;
    float m2 = dot(z, z);
    if (m2 > 16.0) {
      smoothN = float(i) + 1.0 - log2(log(sqrt(m2)));
      escaped = true;
      break;
    }
  }

  // Escape-gradient shading: near the set boundary (high smoothN) burns bright,
  // the slow far field falls off to near-black — the fractal reads as the
  // subject instead of a full-brightness rainbow filling the frame. Hue drifts
  // gently along the gradient (fract of a compressed ramp).
  float t = smoothN / float(ITER);
  float hue = fract(uHueShift + pow(t, 0.65) * uHueSpread);
  float glow = 0.08 + pow(t, 0.9) * 1.6;
  vec3 col = escaped ? hsv2rgb(vec3(hue, 0.75, clamp(glow, 0.0, 1.0))) : vec3(0.0);
  col *= uBrightness * (1.0 + uFlash);
  outColor = vec4(col, 1.0);
}`

// Envelope tuning: bass smoothing time-constant-ish rate, and the onset flash
// decay/gain (same shape as lorenz.ts's `flash`).
const BASS_SMOOTH_RATE = 3.0
const FLASH_DECAY = 8.0
const FLASH_GAIN = 1.0
const FLASH_MAX = 3.0

interface RenderLocs {
  uResolution: WebGLUniformLocation | null
  uAspect: WebGLUniformLocation | null
  uZoom: WebGLUniformLocation | null
  uWarp: WebGLUniformLocation | null
  uCAngle: WebGLUniformLocation | null
  uCRadius: WebGLUniformLocation | null
  uTime: WebGLUniformLocation | null
  uHueShift: WebGLUniformLocation | null
  uHueSpread: WebGLUniformLocation | null
  uBrightness: WebGLUniformLocation | null
  uFlash: WebGLUniformLocation | null
}

export class JuliaScene implements SceneRuntime {
  meta = { id: 'julia', name: 'Julia Warp', family: 'geometry' as const }

  params: ParamSchema[] = [
    { name: 'orbitSpeed', label: 'Orbit speed', min: 0, max: 0.5, default: 0.08 },
    { name: 'cRadius', label: 'C radius', min: 0.6, max: 0.9, default: 0.7885 },
    { name: 'zoom', label: 'Zoom', min: 0.5, max: 3, default: 1 },
    { name: 'warp', label: 'Domain warp', min: 0, max: 0.6, default: 0.12 },
    { name: 'hueShift', label: 'Hue shift', min: 0, max: 1, default: 0.7 },
    { name: 'hueSpread', label: 'Hue spread', min: 0.1, max: 1, default: 0.55 },
    { name: 'brightness', label: 'Brightness', min: 0.3, max: 2, default: 1 },
  ]

  private values = new Map<string, number>()
  private gpu!: Gpu
  private fsPass!: FullscreenPass
  private renderProgram!: WebGLProgram
  private renderLoc!: RenderLocs

  // CPU-only state (ARCHITECTURE.md §1): the orbiting c's phase accumulates
  // dt every frame (not `orbitSpeed * time`) so a mid-session orbitSpeed knob
  // change stays continuous, like the DSL's lfo(). Starting offset is derived
  // once from the seed so different seeds start the orbit at different points.
  private cAnglePhase = 0
  private smoothedBass = 0
  private flash = 0

  // Code layer (ARCHITECTURE.md §3.3): current source for the one editable
  // stage, reset to stock every init(). Uniform locations are cached, so a
  // program swap in setShaderSource must refresh them.
  private renderSource = RENDER_FS

  init(gpu: Gpu, seed: number): void {
    this.gpu = gpu
    for (const p of this.params) this.values.set(p.name, p.default)

    const rng = mulberry32(seed)
    this.cAnglePhase = rng() * Math.PI * 2
    this.smoothedBass = 0
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
    const onset = signals.get('onset')

    const a = 1 - Math.exp(-BASS_SMOOTH_RATE * frame.dt)
    this.smoothedBass += (bass - this.smoothedBass) * a

    this.flash = this.flash * Math.exp(-FLASH_DECAY * frame.dt) + FLASH_GAIN * onset
    if (this.flash > FLASH_MAX) this.flash = FLASH_MAX

    this.cAnglePhase += this.getParam('orbitSpeed') * frame.dt
  }

  render(ctx: FrameContext, surface: RenderSurface): void {
    const gl = this.gpu.gl
    surface.bind()
    gl.disable(gl.BLEND)
    gl.disable(gl.DEPTH_TEST)

    const high = ctx.signals.get('high')
    const zoom = this.getParam('zoom') * (1 + 0.15 * this.smoothedBass)
    const warp = this.getParam('warp') * (1 + 0.5 * high)

    gl.useProgram(this.renderProgram)
    gl.uniform2f(this.renderLoc.uResolution, surface.width, surface.height)
    gl.uniform1f(this.renderLoc.uAspect, surface.width / surface.height)
    gl.uniform1f(this.renderLoc.uZoom, zoom)
    gl.uniform1f(this.renderLoc.uWarp, warp)
    gl.uniform1f(this.renderLoc.uCAngle, this.cAnglePhase)
    gl.uniform1f(this.renderLoc.uCRadius, this.getParam('cRadius'))
    gl.uniform1f(this.renderLoc.uTime, ctx.frame.time)
    gl.uniform1f(this.renderLoc.uHueShift, this.getParam('hueShift'))
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
      uZoom: gl.getUniformLocation(program, 'uZoom'),
      uWarp: gl.getUniformLocation(program, 'uWarp'),
      uCAngle: gl.getUniformLocation(program, 'uCAngle'),
      uCRadius: gl.getUniformLocation(program, 'uCRadius'),
      uTime: gl.getUniformLocation(program, 'uTime'),
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
